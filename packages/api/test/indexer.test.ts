// Тесты поиска по собственному индексу.
//
// Отдельный файл от search.test.ts: там проверяется работа без индекса (по FTS
// коллекции), здесь — с индексом. Оба режима должны быть рабочими, потому что до
// первой индексации приложение живёт на первом.

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { loadConfig } from '../src/config.js';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { buildServer } from '../src/server.js';
import { createUser } from '../src/auth/users.js';
import { buildIndex, isIndexReady, readIndexState } from '../src/indexer/index.js';

const collectionDb = join(import.meta.dirname, '../../../data/collection.db');
const describeIfFixtures = existsSync(collectionDb) ? describe : describe.skip;

describeIfFixtures('поиск по собственному индексу', () => {
  let fastify: FastifyInstance;
  let cookie: string;
  let appDb: string;

  beforeAll(async () => {
    appDb = join(tmpdir(), `flw-index-${process.pid}.db`);
    rmSync(appDb, { force: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: join(tmpdir(), `flw-index-cache-${process.pid}`),
      SESSION_SECRET: 'test-secret',
      LOG_LEVEL: 'silent',
    });

    fastify = await buildServer(loadConfig());
    await createUser(fastify.db.write, 'tester', 'password123', 'Тестер');

    const login = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'tester', password: 'password123' },
    });
    cookie = login.headers['set-cookie'] as string;

    buildIndex(fastify.db, collectionDb);
    // Готовность кэшируется на 10 секунд — сбрасываем, иначе тесты пойдут по коллекции.
    fastify.searchIndex.invalidate();
  });

  afterAll(async () => {
    await fastify.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${appDb}${suffix}`, { force: true });
  });

  const search = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    fastify.inject({ method: 'POST', url: '/api/v1/search', headers: { cookie }, payload });

  // withTotal обязателен: по умолчанию /search считает только страницу, а общее число
  // совпадений отдаёт /search/facets (см. п. 13.2 в docs/architecture.md).
  const total = async (payload: Record<string, unknown>): Promise<number> =>
    (await search({ ...payload, withTotal: true })).json().total;

  it('индекс собран и виден серверу', () => {
    expect(isIndexReady(fastify.db.read)).toBe(true);
    expect(readIndexState(fastify.db.read)?.indexed_at).toBeTruthy();
    expect(fastify.searchIndex.isReady()).toBe(true);
  });

  it('повторная сборка пропускается, если коллекция не менялась', () => {
    const result = buildIndex(fastify.db, collectionDb);
    expect(result.built).toBe(false);
    expect(result.reason).toMatch(/не менялась/);
  });

  it('находит книгу независимо от падежа — то, чего не умеет FTS коллекции', async () => {
    const nominative = await total({ where: { field: 'title', op: 'match', value: 'город' } });
    expect(nominative).toBeGreaterThan(0);

    for (const form of ['города', 'городу', 'городом', 'городе']) {
      expect(await total({ where: { field: 'title', op: 'match', value: form } })).toBe(nominative);
    }
  });

  it('находит автора в любой форме', async () => {
    const suggest = await fastify.inject({
      method: 'GET',
      url: '/api/v1/search/suggest?q=%D0%B1&kind=author&limit=1',
      headers: { cookie },
    });
    const author = suggest.json().items[0];
    expect(author).toBeDefined();

    const lastName = String(author.label).split(' ')[0] as string;
    const base = await total({ where: { field: 'author', op: 'match', value: lastName } });
    expect(base).toBeGreaterThan(0);

    // Фамилия в косвенном падеже должна давать тот же набор книг.
    const oblique = lastName.endsWith('а') ? `${lastName}й` : `${lastName}а`;
    expect(await total({ where: { field: 'author', op: 'match', value: oblique } })).toBe(base);
  });

  it('ищет подстроку внутри слова', async () => {
    const found = await total({ where: { field: 'title', op: 'substring', value: 'орол' } });
    expect(found).toBeGreaterThan(0);

    const items = (await search({ where: { field: 'title', op: 'substring', value: 'орол' } }))
      .json()
      .items.map((item: { title: string }) => item.title.toLowerCase());
    expect(items.every((title: string) => title.includes('орол'))).toBe(true);
  });

  it('требует минимум три символа для подстроки', async () => {
    const response = await search({ where: { field: 'title', op: 'substring', value: 'аа' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/три символа/);
  });

  it('ограничивает поиск колонкой: слово из аннотации не находится по названию', async () => {
    const anywhere = await total({
      where: { field: 'annotation', op: 'match', value: 'экспедиция' },
    });
    expect(anywhere).toBeGreaterThan(0);
    expect(await total({ where: { field: 'title', op: 'match', value: 'экспедиция' } })).toBe(0);
  });

  it('ранжирует по релевантности, а курсор остаётся согласованным', async () => {
    const first = (
      await search({
        where: { field: 'any', op: 'match', value: 'город' },
        sort: [{ field: 'relevance', dir: 'desc' }],
        limit: 3,
      })
    ).json();

    expect(first.items.length).toBeGreaterThan(0);
    expect(first.nextCursor).toBeTruthy();

    const second = (
      await search({
        where: { field: 'any', op: 'match', value: 'город' },
        sort: [{ field: 'relevance', dir: 'desc' }],
        limit: 3,
        cursor: first.nextCursor,
      })
    ).json();

    const firstIds = first.items.map((item: { bookId: number }) => item.bookId);
    const secondIds = second.items.map((item: { bookId: number }) => item.bookId);
    expect(firstIds.filter((id: number) => secondIds.includes(id))).toEqual([]);
  });

  it('отдаёт подсказки по всем видам', async () => {
    for (const kind of ['author', 'series', 'keyword', 'title']) {
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/search/suggest?q=%D0%B1&kind=${kind}&limit=3`,
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      const items = response.json().items;
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) expect(item.kind).toBe(kind);
    }
  });

  it('не ломается на запросе из одних служебных символов', async () => {
    const response = await search({ where: { field: 'any', op: 'match', value: '"*()' } });
    expect([200, 400]).toContain(response.statusCode);
  });
});

// Доиндексация: коллекция после новой поставки inpx. Работаем на копии — коллекцию
// нельзя ни менять, ни блокировать, а тут нужно именно записать в неё новые книги.
describeIfFixtures('доиндексация', () => {
  let handle: DbHandle;
  let collectionCopy: string;
  let appDb: string;

  const countIndexed = (): number =>
    (handle.read.prepare('SELECT count(*) AS n FROM books_fts').get() as { n: number }).n;

  /** Новая поставка: книга с UpdateID больше всех прежних. */
  const deliverBook = (title: string): number => {
    const collection = new Database(collectionCopy);
    const { maxId, maxUpdate } = collection
      .prepare('SELECT max(BookID) AS maxId, coalesce(max(UpdateID), 0) AS maxUpdate FROM Books')
      .get() as { maxId: number; maxUpdate: number };

    const bookId = maxId + 1;
    collection
      .prepare(
        `INSERT INTO Books (BookID, Title, SearchTitle, Lang, Year, FolderID, FileName, Ext,
                            BookSize, UpdateID, IsDeleted, SourceLib)
         VALUES (?, ?, ?, 'ru', 2026, 1, ?, '.fb2', 1024, ?, 0, 'test')`,
      )
      .run(bookId, title, title.toUpperCase(), `file_${bookId}`, maxUpdate + 1);
    collection.close();

    return bookId;
  };

  beforeAll(() => {
    collectionCopy = join(tmpdir(), `flw-incr-collection-${process.pid}.db`);
    appDb = join(tmpdir(), `flw-incr-app-${process.pid}.db`);
    for (const path of [collectionCopy, appDb]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    }
    copyFileSync(collectionDb, collectionCopy);

    Object.assign(process.env, {
      COLLECTION_DB: collectionCopy,
      APP_DB: appDb,
      CACHE_DIR: join(tmpdir(), `flw-incr-cache-${process.pid}`),
      SESSION_SECRET: 'test-secret',
      LOG_LEVEL: 'silent',
    });

    handle = openDatabase(loadConfig(), { info: () => {}, warn: () => {} });
    buildIndex(handle, collectionCopy, { force: true });
  });

  afterAll(() => {
    handle.close();
    for (const path of [collectionCopy, appDb]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it('дописывает только новые книги, не пересобирая индекс', () => {
    const before = countIndexed();
    const bookId = deliverBook('Инкрементальнаякнига Зюмбрик');

    const result = buildIndex(handle, collectionCopy);

    expect(result.mode).toBe('incremental');
    expect(result.books).toBe(1);
    // Старые строки на месте: их никто не перестраивал.
    expect(countIndexed()).toBe(before + 1);

    const found = handle.read
      .prepare(`SELECT rowid AS bookId FROM books_fts WHERE books_fts MATCH 'зюмбрик'`)
      .all() as Array<{ bookId: number }>;
    expect(found.map((row) => row.bookId)).toEqual([bookId]);
  });

  it('повторный запуск после доиндексации ничего не делает', () => {
    const result = buildIndex(handle, collectionCopy);
    expect(result.mode).toBe('skipped');
  });

  it('собирает заново, если из старой части коллекции пропали книги', () => {
    // Удаление книги UpdateID не двигает: доиндексация её бы не заметила и оставила
    // строку в индексе навсегда — поэтому такой случай обязан уходить в полную сборку.
    const collection = new Database(collectionCopy);
    const { bookId } = collection.prepare('SELECT min(BookID) AS bookId FROM Books').get() as {
      bookId: number;
    };
    collection.prepare('DELETE FROM Books WHERE BookID = ?').run(bookId);
    collection.close();

    deliverBook('Ещёоднакнига Зюмбрик');

    const result = buildIndex(handle, collectionCopy);
    expect(result.mode).toBe('full');

    const stale = handle.read
      .prepare('SELECT count(*) AS n FROM books_fts WHERE rowid = ?')
      .get(bookId) as { n: number };
    expect(stale.n).toBe(0);
  });
});
