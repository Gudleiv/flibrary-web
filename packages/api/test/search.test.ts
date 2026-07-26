// Интеграционные тесты поиска на фикстурной коллекции.
//
// Требуют сгенерированных фикстур: pnpm fixtures -- --books=300 --no-archives
// Если коллекции нет — тесты пропускаются, а не падают: генерация не входит в
// быстрый прогон.

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createUser } from '../src/auth/users.js';

const collectionDb = join(import.meta.dirname, '../../../data/collection.db');
const hasFixtures = existsSync(collectionDb);

const describeIfFixtures = hasFixtures ? describe : describe.skip;

describeIfFixtures('поиск', () => {
  let fastify: FastifyInstance;
  let cookie: string;
  let appDb: string;

  beforeAll(async () => {
    appDb = join(tmpdir(), `flw-test-${process.pid}.db`);
    rmSync(appDb, { force: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: join(tmpdir(), `flw-test-cache-${process.pid}`),
      SESSION_SECRET: 'test-secret',
      LOG_LEVEL: 'silent',
    });

    const config: Config = loadConfig();
    fastify = await buildServer(config);
    await createUser(fastify.db.write, 'tester', 'password123', 'Тестер');

    const login = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'tester', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.headers['set-cookie'] as string;
  });

  afterAll(async () => {
    await fastify.close();
    rmSync(appDb, { force: true });
    rmSync(`${appDb}-wal`, { force: true });
    rmSync(`${appDb}-shm`, { force: true });
  });

  // Тип payload обязан быть конкретным, иначе TS выбирает перегрузку inject(),
  // возвращающую чейн, — а у него нет ни statusCode, ни json().
  const search = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    fastify.inject({ method: 'POST', url: '/api/v1/search', headers: { cookie }, payload });

  /** Счётчики и total — отдельная операция: они считаются по всему множеству. */
  const counts = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    fastify.inject({ method: 'POST', url: '/api/v1/search/facets', headers: { cookie }, payload });

  it('закрыт без аутентификации', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/search',
      payload: { where: { field: 'any', op: 'match', value: 'берег' } },
    });
    expect(response.statusCode).toBe(401);
  });

  it('находит книги по префиксу названия', async () => {
    const response = await search({
      where: { field: 'title', op: 'prefix', value: 'берег' },
      limit: 5,
      withTotal: true,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.title.toLowerCase()).toContain('берег');
    }
  });

  it('догружает авторов и жанры одним запросом на страницу', async () => {
    const response = await search({
      where: { field: 'lang', op: 'in', values: ['ru'] },
      limit: 3,
    });

    const body = response.json();
    expect(body.items.every((item: { authors: unknown[] }) => item.authors.length > 0)).toBe(true);
  });

  it('пересекает предикаты по AND', async () => {
    const ru = (
      await search({ where: { field: 'lang', op: 'in', values: ['ru'] }, withTotal: true })
    ).json();
    const both = (
      await search({
        where: {
          op: 'and',
          nodes: [
            { field: 'lang', op: 'in', values: ['ru'] },
            { field: 'year', op: 'range', from: 2000, to: 2026 },
          ],
        },
        withTotal: true,
      })
    ).json();

    expect(both.total).toBeLessThanOrEqual(ru.total);
    expect(both.items.every((item: { lang: string }) => item.lang === 'ru')).toBe(true);
    expect(both.items.every((item: { year: number }) => item.year >= 2000)).toBe(true);
  });

  it('исключает по NOT', async () => {
    const notRu = (
      await search({ where: { op: 'not', node: { field: 'lang', op: 'in', values: ['ru'] } } })
    ).json();

    expect(notRu.items.every((item: { lang: string }) => item.lang !== 'ru')).toBe(true);
  });

  it('идёт по страницам keyset-курсором без дублей и потерь', async () => {
    const query = {
      where: { field: 'lang', op: 'in', values: ['ru'] },
      sort: [{ field: 'title', dir: 'asc' }],
      // Размер страницы влияет только на число итераций: тест не должен ломаться
      // от того, что фикстура стала больше.
      limit: 200,
    };

    const first = (await search({ ...query, withTotal: true })).json();
    const collected: number[] = [];
    let cursor: string | null = first.nextCursor;
    collected.push(...first.items.map((item: { bookId: number }) => item.bookId));

    // Ограничение на всякий случай: бесконечный цикл в тесте хуже упавшего теста.
    // Запас на порядок больше, чем нужно для любой разумной фикстуры.
    for (let page = 0; page < 500 && cursor !== null; page += 1) {
      const next = (await search({ ...query, cursor })).json();
      collected.push(...next.items.map((item: { bookId: number }) => item.bookId));
      cursor = next.nextCursor;
    }

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.length).toBe(first.total);
    // Тест обходит всю фикстуру: на 50 000 книг это две сотни запросов, и в дефолтные
    // пять секунд он укладывается впритык — отсюда свой таймаут.
  }, 60_000);

  it('переводит служебного автора «Unknown author»', async () => {
    const body = (
      await search({ where: { field: 'author', op: 'prefix', value: 'unknown' }, limit: 20 })
    ).json();

    expect(body.items.length).toBeGreaterThan(0);
    const names = body.items.flatMap((item: { authors: Array<{ name: string }> }) =>
      item.authors.map((author) => author.name),
    );
    expect(names).toContain('Неизвестный автор');
    expect(names).not.toContain('Unknown author');
  });

  it('отдаёт страницу по номеру через offset', async () => {
    // Постраничная навигация в интерфейсе ходит пропуском, а не курсором: по номеру
    // страницы курсором не попасть. Пропуск обязан давать ровно тот же порядок.
    const query = {
      where: { field: 'lang', op: 'in', values: ['ru'] },
      sort: [{ field: 'title', dir: 'asc' }],
      withTotal: true,
    };

    const firstTwo = (await search({ ...query, limit: 10 })).json();
    const page1 = (await search({ ...query, limit: 5 })).json();
    const page2 = (await search({ ...query, limit: 5, offset: 5 })).json();

    const ids = (body: { items: Array<{ bookId: number }> }): number[] =>
      body.items.map((item) => item.bookId);

    expect(ids(page1)).toEqual(ids(firstTwo).slice(0, 5));
    expect(ids(page2)).toEqual(ids(firstTwo).slice(5));
    // total не зависит от того, какую страницу попросили.
    expect(page2.total).toBe(page1.total);
  });

  it('за концом выдачи отдаёт пустую страницу, а не ошибку', async () => {
    const body = (
      await search({
        where: { field: 'lang', op: 'in', values: ['ru'] },
        offset: 1_000_000,
        withTotal: true,
      })
    ).json();

    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBeGreaterThan(0);
  });

  it('не задваивает книгу, у которой подошли два автора', async () => {
    // Предикат по связке отдаёт BookID на каждое совпадение: у книги два автора,
    // оба на «ова» — и без дедупликации она попадала и в выдачу дважды, и в total.
    const where = { field: 'author', op: 'substring', value: 'ова' };
    const body = (await search({ where, limit: 100 })).json();

    const ids = body.items.map((item: { bookId: number }) => item.bookId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    const aggregated = (await counts({ where, facets: ['lang'] })).json();
    const langSum = aggregated.facets[0].values.reduce(
      (acc: number, value: { count: number }) => acc + value.count,
      0,
    );
    expect(langSum).toBe(aggregated.total);
  });

  it('объясняет, что hasCover ещё не поддержан, а не падает', async () => {
    const response = await search({ where: { field: 'hasCover', op: 'eq', value: true } });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/hasCover/);
  });

  it('не даёт инъекции через значения предикатов', async () => {
    const response = await search({
      where: { field: 'title', op: 'match', value: `'; DROP TABLE Books; --` },
    });

    expect(response.statusCode).toBe(200);
    // Главное: коллекция на месте.
    const health = await fastify.inject({ method: 'GET', url: '/health' });
    expect(health.json().collection.books).toBeGreaterThan(0);
  });

  it('отдаёт карточку книги', async () => {
    const found = (
      await search({ where: { field: 'lang', op: 'in', values: ['ru'] }, limit: 1 })
    ).json();
    const bookId = found.items[0].bookId;

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const book = response.json();
    expect(book.bookId).toBe(bookId);
    expect(book.formats.length).toBeGreaterThan(0);
    // Название жанра, а не код «001.001»: в коллекции оно лежит в GenreAlias.
    expect(book.genres.length).toBeGreaterThan(0);
    expect(
      book.genres.every((genre: { code: string; title: string }) => genre.title !== genre.code),
    ).toBe(true);
  });

  it('отдаёт дерево жанров с названиями, а не кодами', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/genres',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{
      code: string;
      parentCode: string | null;
      title: string;
      children: Array<{ code: string; title: string }>;
    }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((genre) => genre.children.length > 0)).toBe(true);

    const flat = items.flatMap((genre) => [genre, ...genre.children]);
    expect(flat.every((genre) => genre.title !== genre.code)).toBe(true);
    // В коллекции у корневых жанров ParentCode — пустая строка; наружу это null.
    expect(items.every((genre) => genre.parentCode === null)).toBe(true);
  });
  describe('фасеты', () => {
    const ALL_BOOKS = { field: 'deleted', op: 'eq', value: false };

    it('в выдачу не попадают: она отдаёт только страницу', async () => {
      // Счётчики стоят полного прохода по множеству, поэтому /search их не считает
      // даже если попросили — на это есть отдельная операция.
      const body = (await search({ where: ALL_BOOKS, facets: ['lang'], limit: 1 })).json();
      expect(body.facets).toBeUndefined();
      expect(body.total).toBeNull();
    });

    it('не считаются, пока их не попросили', async () => {
      const body = (await counts({ where: ALL_BOOKS })).json();
      expect(body.facets).toEqual([]);
      // total считается всегда: он и есть главная цифра этой операции.
      expect(body.total).toBeGreaterThan(0);
    });

    it('считают по всему совпавшему множеству, а не по странице', async () => {
      const body = (await counts({ where: ALL_BOOKS, facets: ['lang'], limit: 1 })).json();

      const lang = body.facets.find((facet: { field: string }) => facet.field === 'lang');
      const sum = lang.values.reduce(
        (acc: number, value: { count: number }) => acc + value.count,
        0,
      );

      // У каждой книги фикстуры язык заполнен, поэтому сумма — это ровно total.
      expect(sum).toBe(body.total);
    });

    it('не сужают фасет его собственным фильтром', async () => {
      const body = (
        await counts({
          where: { field: 'lang', op: 'in', values: ['ru'] },
          facets: ['lang'],
        })
      ).json();

      const lang = body.facets[0];
      // Выбран ru, но остальные языки должны быть видны — иначе множественный
      // выбор невозможен: список схлопнулся бы до одного значения.
      expect(lang.values.length).toBeGreaterThan(1);
      expect(lang.values.some((value: { value: string }) => value.value === 'ru')).toBe(true);
      expect(lang.values.some((value: { value: string }) => value.value !== 'ru')).toBe(true);
    });

    it('учитывают остальные фильтры запроса', async () => {
      const all = (await counts({ where: ALL_BOOKS, facets: ['lang'] })).json();
      const narrowed = (
        await counts({
          where: {
            op: 'and',
            nodes: [ALL_BOOKS, { field: 'year', op: 'range', from: 2000, to: 2005 }],
          },
          facets: ['lang'],
        })
      ).json();

      const count = (body: {
        facets: Array<{ values: Array<{ value: string; count: number }> }>;
      }) => body.facets[0]!.values.find((value) => value.value === 'ru')!.count;

      expect(count(narrowed)).toBeLessThan(count(all));
      expect(count(narrowed)).toBeGreaterThan(0);
    });

    it('закрепляют выбранное значение в начале списка', async () => {
      const found = (await search({ where: ALL_BOOKS, limit: 1 })).json();
      const authorId = found.items[0].authors[0].authorId;

      const body = (
        await counts({
          where: { field: 'authorId', op: 'in', values: [authorId] },
          facets: ['author'],
        })
      ).json();

      // У автора фикстуры несколько книг, в топ-20 по количеству он бы не попал:
      // без закрепления снять этот фильтр в UI было бы нечем.
      expect(body.facets[0].values[0].value).toBe(String(authorId));
      expect(body.facets[0].values[0].label).toBeTruthy();
    });

    it('честно помечают обрезанный список', async () => {
      const body = (await counts({ where: ALL_BOOKS, facets: ['author', 'lang'] })).json();

      const author = body.facets.find((facet: { field: string }) => facet.field === 'author');
      const lang = body.facets.find((facet: { field: string }) => facet.field === 'lang');

      expect(author.truncated).toBe(true);
      expect(author.values.length).toBe(20);
      // Языков в фикстуре меньше лимита — обрезать нечего.
      expect(lang.truncated).toBe(false);
    });

    it('отдают год шкалой по убыванию, а жанр — с подписью', async () => {
      const body = (await counts({ where: ALL_BOOKS, facets: ['year', 'genre'] })).json();

      const years = body.facets[0].values.map((value: { value: string }) => Number(value.value));
      expect(years).toEqual([...years].sort((left, right) => right - left));

      const genre = body.facets[1].values[0];
      expect(genre.label).toBeTruthy();
      expect(genre.label).not.toBe(genre.value);
    });

    it('кэшируют счётчики: повтор берётся из query_cache', async () => {
      const query = { where: ALL_BOOKS, facets: ['genre', 'series'] };

      const first = (await counts(query)).json();
      const cached = (
        fastify.db.read.prepare('SELECT count(*) AS rows FROM query_cache').get() as {
          rows: number;
        }
      ).rows;
      // Сортировка выдачи на счётчики не влияет — второй запрос обязан попасть в кэш.
      const second = (await counts({ ...query, sort: [{ field: 'year', dir: 'asc' }] })).json();

      expect(cached).toBeGreaterThan(0);
      expect(second.facets).toEqual(first.facets);
      expect(second.total).toBe(first.total);
    });

    it('total не зависит ни от страницы, ни от сортировки', async () => {
      const where = { field: 'lang', op: 'in', values: ['ru'] };

      const direct = (await counts({ where })).json().total;
      const paged = (await counts({ where, offset: 500, limit: 5 })).json().total;
      const inline = (await search({ where, withTotal: true, limit: 5 })).json().total;

      expect(paged).toBe(direct);
      // Та же цифра, что и у /search с withTotal: операции считают одно и то же.
      expect(inline).toBe(direct);
    });
  });
});
