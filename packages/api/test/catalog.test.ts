// Интеграционные тесты справочников: жанры, авторы, языки, сведения о коллекции.
//
// Требуют сгенерированных фикстур: pnpm fixtures -- --books=300 --no-archives
// Если коллекции нет — тесты пропускаются, а не падают.

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Genre } from '@flibrary/contract';

import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createUser } from '../src/auth/users.js';

const collectionDb = join(import.meta.dirname, '../../../data/collection.db');
const describeIfFixtures = existsSync(collectionDb) ? describe : describe.skip;

describeIfFixtures('справочники', () => {
  let fastify: FastifyInstance;
  let cookie: string;
  let appDb: string;
  let cacheDir: string;

  beforeAll(async () => {
    appDb = join(tmpdir(), `flw-catalog-${process.pid}.db`);
    cacheDir = join(tmpdir(), `flw-catalog-cache-${process.pid}`);
    rmSync(appDb, { force: true });
    rmSync(cacheDir, { force: true, recursive: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: cacheDir,
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
    cookie = login.headers['set-cookie'] as string;
  });

  afterAll(async () => {
    await fastify.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${appDb}${suffix}`, { force: true });
    rmSync(cacheDir, { force: true, recursive: true });
  });

  const get = (url: string): Promise<LightMyRequestResponse> =>
    fastify.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });

  describe('жанры', () => {
    it('считает книги по поддереву, а не по прямым связям', async () => {
      const response = await get('/genres');
      expect(response.statusCode).toBe(200);

      const items = response.json<{ items: Genre[] }>().items;
      const root = items.find((node) => (node.children?.length ?? 0) > 0);
      expect(root).toBeDefined();

      // Книге проставляют листовые жанры, поэтому у корня прямых связей нет —
      // но книги в нём есть, и раньше пользователь видел на этом месте ноль.
      expect(root?.ownBooks).toBe(0);
      expect(root?.books ?? 0).toBeGreaterThan(0);
    });

    it('не считает книгу дважды, если у неё два поджанра одного корня', async () => {
      const items = (await get('/genres')).json<{ items: Genre[] }>().items;
      const root = items.find((node) => (node.children?.length ?? 0) > 1);
      expect(root).toBeDefined();

      const childrenSum = (root?.children ?? []).reduce(
        (sum, child) => sum + (child.books ?? 0),
        0,
      );

      // Сумма по детям книгу с двумя поджанрами считает дважды, count(DISTINCT) — один
      // раз. Значит, поддерево не может быть больше суммы, и на реальных данных строго
      // меньше — иначе DISTINCT потерялся бы незаметно.
      expect(root?.books ?? 0).toBeLessThan(childrenSum);
    });

    it('закрыт без аутентификации', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/genres' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('авторы', () => {
    it('отдаёт страницу списка и общее число', async () => {
      const response = await get('/authors?limit=5');
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        items: Array<{ name: string; books: number }>;
        total: number;
      }>();
      expect(body.items).toHaveLength(5);
      expect(body.total).toBeGreaterThan(5);
      // Авторы без книг в список не попадают.
      expect(body.items.every((item) => item.books > 0)).toBe(true);
    });

    it('листается без повторов', async () => {
      const first = (await get('/authors?limit=5')).json<{ items: Array<{ authorId: number }> }>();
      const second = (await get('/authors?limit=5&offset=5')).json<{
        items: Array<{ authorId: number }>;
      }>();

      const ids = new Set(first.items.map((item) => item.authorId));
      expect(second.items.some((item) => ids.has(item.authorId))).toBe(false);
    });

    it('фильтрует по префиксу имени', async () => {
      const all = (await get('/authors?limit=200')).json<{ items: Array<{ name: string }> }>();
      const letter = all.items[0]?.name.charAt(0) ?? 'А';

      const filtered = (await get(`/authors?q=${encodeURIComponent(letter)}&limit=200`)).json<{
        items: Array<{ name: string }>;
        total: number;
      }>();

      expect(filtered.total).toBeGreaterThan(0);
      expect(filtered.items.every((item) => item.name.startsWith(letter))).toBe(true);
    });

    it('не даёт спецсимволам LIKE утечь во фильтр', async () => {
      // '%' во вводе означал бы «любой остаток» и вернул бы всех авторов подряд.
      const response = await get('/authors?q=%25');
      expect(response.statusCode).toBe(200);
      expect(response.json<{ total: number }>().total).toBe(0);
    });
  });

  describe('сведения о коллекции', () => {
    it('отдаёт границы годов и число аннотаций', async () => {
      const body = (await get('/collection')).json<{
        yearMin: number | null;
        yearMax: number | null;
        annotations: number;
      }>();

      expect(body.yearMin).toBeGreaterThan(1400);
      expect(body.yearMax).toBeLessThan(2200);
      expect(body.yearMin ?? 0).toBeLessThanOrEqual(body.yearMax ?? 0);
      // В фикстурах аннотации есть; ноль здесь означал бы коллекцию без них.
      expect(body.annotations).toBeGreaterThan(0);
    });
  });
});
