// Контрактный тест клиента C++-сервера FLibrary и бинарных ручек поверх него.
//
// Смысл в том, чтобы зафиксировать внутренний контракт `/Images/*`: он чужой, версионируется
// вместе с upstream и молча поехать не должен. Здесь на месте C++-сервера стоит заглушка,
// которая записывает, куда мы постучались; проверка против настоящего сервера — руками,
// `scripts/opds-local.sh` (см. docs/deploy.md).
//
// Требуют фикстур: pnpm fixtures -- --books=300 --no-archives

import { createServer, type Server } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createUser } from '../src/auth/users.js';

const collectionDb = join(import.meta.dirname, '../../../data/collection.db');
const describeIfFixtures = existsSync(collectionDb) ? describe : describe.skip;

/** Что заглушка отдаёт и что при этом запросили. */
interface StubRequest {
  path: string;
}

describeIfFixtures('бинарные ручки поверх content-service', () => {
  let fastify: FastifyInstance;
  let stub: Server;
  let cookie: string;
  let appDb: string;
  let bookId: number;
  const requests: StubRequest[] = [];
  /** Имя файла, которое «C++-сервер» кладёт в content-disposition. */
  let stubFilename = 'book.fb2';

  beforeAll(async () => {
    stub = createServer((request, response) => {
      requests.push({ path: request.url ?? '' });

      if (request.url?.startsWith('/Images/covers/')) {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end(Buffer.from('\xff\xd8\xff\xd9', 'binary'));
        return;
      }
      const zip = request.url?.startsWith('/Images/zip/') ?? false;
      response.writeHead(200, {
        'content-type': zip ? 'application/zip' : 'application/fb2',
        'content-disposition': `attachment; filename="${stubFilename}${zip ? '.zip' : ''}"`,
      });
      response.end(zip ? 'PKzip' : '<?xml version="1.0"?><FictionBook/>');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;

    appDb = join(tmpdir(), `flw-content-${process.pid}.db`);
    rmSync(appDb, { force: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: join(tmpdir(), `flw-content-cache-${process.pid}`),
      CONTENT_SERVICE_URL: `http://127.0.0.1:${port}`,
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

    bookId = (
      fastify.db.read.prepare('SELECT min(BookID) AS id FROM coll.Books').get() as { id: number }
    ).id;
  });

  afterAll(async () => {
    await fastify?.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    rmSync(appDb, { force: true });
  });

  const download = (query: string) =>
    fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}/content${query}`,
      headers: { cookie },
    });

  it('исходный формат берётся из /Images/fb2 — там fb2 с восстановленными картинками', async () => {
    requests.length = 0;
    const response = await download('?format=original');

    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.path)).toEqual([`/Images/fb2/${bookId}`]);
    // Заголовки content-service проксируются как есть: имя файла знает он, не мы.
    expect(response.headers['content-type']).toBe('application/fb2');
    expect(response.headers['content-disposition']).toBe('attachment; filename="book.fb2"');
    expect(response.body).toContain('FictionBook');
  });

  it('формат по умолчанию — тоже исходный', async () => {
    requests.length = 0;
    expect((await download('')).statusCode).toBe(200);
    expect(requests.map((r) => r.path)).toEqual([`/Images/fb2/${bookId}`]);
  });

  it('zip отдаёт файл в архиве, как он лежит в коллекции', async () => {
    requests.length = 0;
    const response = await download('?format=zip');

    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.path)).toEqual([`/Images/zip/${bookId}`]);
    expect(response.headers['content-type']).toBe('application/zip');
  });

  it('percent-кодированное имя файла переносится в filename*', async () => {
    // Так его отдаёт настоящий C++-сервер: «Последний берег.fb2».
    stubFilename =
      '%D0%9F%D0%BE%D1%81%D0%BB%D0%B5%D0%B4%D0%BD%D0%B8%D0%B9%20%D0%B1%D0%B5%D1%80%D0%B5%D0%B3.fb2';
    try {
      const disposition = (await download('?format=original')).headers['content-disposition'];

      // Percent-escape внутри filename= декодирует не каждый браузер: это эвристика,
      // а не RFC 6266.
      expect(disposition).toContain("filename*=UTF-8''%D0%9F%D0%BE%D1%81%D0%BB%D0%B5%D0%B4");
      expect(disposition).toContain(`filename="book-${bookId}.fb2"`);
    } finally {
      stubFilename = 'book.fb2';
    }
  });

  it('epub и mobi — тот же /Images/fb2, но с профилем конвертера', async () => {
    requests.length = 0;
    await download('?format=epub');
    await download('?format=mobi');

    expect(requests.map((r) => r.path)).toEqual([
      `/Images/fb2/${bookId}?profile=epub`,
      `/Images/fb2/${bookId}?profile=mobi`,
    ]);
  });

  it('неизвестный формат отвергается схемой, а не уходит в content-service', async () => {
    requests.length = 0;
    expect((await download('?format=djvu')).statusCode).toBe(400);
    expect(requests).toEqual([]);
  });

  it('обложка идёт за /Images/covers', async () => {
    requests.length = 0;
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}/cover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.path)).toEqual([`/Images/covers/${bookId}`]);
    expect(response.headers['content-type']).toBe('image/jpeg');
  });

  it('несуществующая книга — 404, без обращения к content-service', async () => {
    requests.length = 0;
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/books/99999999/content',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(requests).toEqual([]);
  });

  it('без авторизации файл не отдаётся', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}/content`,
    });

    expect(response.statusCode).toBe(401);
  });

  // Последним: закрываем заглушку и проверяем, что недоступный content-service — это 502
  // с объяснением, а не 500 и не пустой ответ.
  it('недоступный content-service — 502', async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));

    const response = await download('?format=original');

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().title).toContain('Content-service');
  });
});
