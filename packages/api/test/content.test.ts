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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createUser } from '../src/auth/users.js';
import { ContentLimiter, ContentServiceBusyError } from '../src/content/opds.js';
import { detectImageType } from '../src/cache/covers.js';
import { contentDisposition } from '../src/routes/books.js';

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
  let cacheDir: string;
  let bookId: number;
  const requests: StubRequest[] = [];
  /** Имя файла, которое «C++-сервер» кладёт в content-disposition. */
  let stubFilename = 'book.fb2';
  /** Тело fb2, которое отдаёт заглушка: тестам разбора нужен не пустой файл. */
  let stubFb2 = '<?xml version="1.0"?><FictionBook/>';

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
      response.end(zip ? 'PKzip' : stubFb2);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;

    appDb = join(tmpdir(), `flw-content-${process.pid}.db`);
    cacheDir = join(tmpdir(), `flw-content-cache-${process.pid}`);
    // Кэш обязательно чистим и до, и после: он переживает процесс, а имя привязано к
    // pid, который система переиспользует. Разбор чужого прогона выглядел бы как
    // сломанный разбор этого.
    rmSync(appDb, { force: true });
    rmSync(cacheDir, { force: true, recursive: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: cacheDir,
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
    rmSync(cacheDir, { force: true, recursive: true });
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

  describe('сведения из файла книги', () => {
    const details = () =>
      fastify.inject({
        method: 'GET',
        url: `/api/v1/books/${bookId}/details`,
        headers: { cookie },
      });

    it('разбирает fb2 из content-service и кэширует разбор', async () => {
      stubFb2 = `<?xml version="1.0" encoding="utf-8"?>
        <FictionBook>
          <description>
            <title-info><src-lang>en</src-lang></title-info>
            <publish-info><publisher>Азбука</publisher><year>2015</year></publish-info>
          </description>
          <body><section><title><p>Пролог</p></title><p>Текст книги.</p></section></body>
        </FictionBook>`;

      requests.length = 0;
      const first = await details();

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        publisher: 'Азбука',
        publishYear: 2015,
        srcLang: 'en',
        chapters: ['Пролог'],
      });
      // Нужен распакованный XML, а не архив: значит /Images/fb2, а не /Images/zip.
      expect(requests.map((request) => request.path)).toEqual([`/Images/fb2/${bookId}`]);

      // Повтор не должен снова дёргать content-service: вытащить файл книги ради
      // издателя дорого, а очередь у C++-сервера размером с число ядер.
      requests.length = 0;
      const second = await details();

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(requests).toHaveLength(0);
    });

    it('несуществующая книга — 404, а не поход за файлом', async () => {
      requests.length = 0;
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/books/999999999/details',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(404);
      expect(requests).toHaveLength(0);
    });

    it('закрыт без аутентификации', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/books/${bookId}/details`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // Последним: закрываем заглушку и проверяем, что недоступный content-service — это 502
  // с объяснением, а не 500 и не пустой ответ.
  it('недоступный content-service — 502', async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));

    const response = await download('?format=original');

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().title).toContain('Не удалось получить файл книги');
    expect(response.json().detail).toContain('недоступен');
  });
});

// Поведение под нагрузкой. Ключевая особенность настоящего C++-сервера: обработчики
// выполняются в пуле фиксированного размера, и всё, что в него не поместилось, стоит в
// очереди без ответа. Именно на этом ломалась страница книги — сетка обложек забивала
// пул, а скачивание уходило в таймаут.

/** Поддельный `opds`: пул на N обработчиков, всё сверх него ждёт в очереди. */
class FakeOpds {
  readonly requests: string[] = [];
  /** Пик числа принятых, но ещё не отвеченных запросов — глубина его очереди. */
  maxInFlight = 0;
  /** Что отвечать: подменяется в тестах про ошибки. */
  handler: (path: string) => { status: number; body: Buffer; type: string } = () => ({
    status: 200,
    body: JPEG,
    type: 'image/jpeg',
  });

  private readonly server: Server;
  private active = 0;
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly poolSize: number,
    private readonly delayMs: number,
  ) {
    this.server = createServer((request, response) => {
      const path = request.url ?? '';
      this.requests.push(path);
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      this.run(() => {
        const { status, body, type } = this.handler(path);
        response.writeHead(status, {
          'content-type': type,
          'content-length': String(body.length),
        });
        response.end(body);
        this.inFlight -= 1;
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('нет адреса');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.maxInFlight = 0;
  }

  private run(task: () => void): void {
    if (this.active >= this.poolSize) {
      this.queue.push(() => this.run(task));
      return;
    }

    this.active += 1;
    setTimeout(() => {
      task();
      this.active -= 1;
      this.queue.shift()?.();
    }, this.delayMs).unref();
  }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');

describe('ContentLimiter', () => {
  it('не пускает в полёт больше разрешённого', async () => {
    const limiter = new ContentLimiter(2);
    const first = await limiter.acquire('cover', 1000);
    const second = await limiter.acquire('file', 1000);
    expect(limiter.busy).toBe(2);

    let third = false;
    void limiter.acquire('cover', 1000).then(
      () => (third = true),
      () => undefined,
    );
    await Promise.resolve();
    expect(third).toBe(false);

    first();
    await new Promise((resolve) => setImmediate(resolve));
    expect(third).toBe(true);
    second();
  });

  it('держит слот под файл: скачивание не ждёт за обложками', async () => {
    const limiter = new ContentLimiter(3);
    // Обложек одновременно не больше limit - 1.
    await limiter.acquire('cover', 1000);
    await limiter.acquire('cover', 1000);
    expect(limiter.busy).toBe(2);

    let coverGranted = false;
    void limiter.acquire('cover', 1000).then(
      () => (coverGranted = true),
      () => undefined,
    );
    const file = await limiter.acquire('file', 1000);
    expect(file).toBeTypeOf('function');
    expect(coverGranted).toBe(false);
  });

  it('не ждёт вечно: очередь ограничена по времени', async () => {
    const limiter = new ContentLimiter(1);
    await limiter.acquire('file', 1000);
    await expect(limiter.acquire('file', 20)).rejects.toBeInstanceOf(ContentServiceBusyError);
  });
});

describe('detectImageType', () => {
  it('узнаёт формат по сигнатуре, а не по слову content-service', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('не картинка'))).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('меняет расширение под формат', () => {
    expect(contentDisposition('book.fb2', 1, 'zip')).toContain('filename="book.zip"');
    expect(contentDisposition('book.fb2', 1, 'original')).toContain('filename="book.fb2"');
    expect(contentDisposition('book.fb2', 1, 'epub')).toContain('filename="book.epub"');
  });

  it('кириллицу отдаёт по RFC 5987, оставляя ASCII-запасной вариант', () => {
    const header = contentDisposition('Тихий берег.fb2', 1, 'original');
    expect(header).toContain("filename*=UTF-8''%D0%A2%D0%B8%D1%85%D0%B8%D0%B9");
    expect(header).toMatch(/filename="_+ _+\.fb2"/);
  });

  it('переживает отсутствие имени в коллекции', () => {
    expect(contentDisposition(null, 42, 'zip')).toContain('filename="book-42.zip"');
  });
});

describeIfFixtures('обложки и файлы под нагрузкой', () => {
  let fastify: FastifyInstance;
  let cookie: string;
  let appDb: string;
  let cacheDir: string;
  let bookId: number;
  const opds = new FakeOpds(2, 40);

  beforeAll(async () => {
    const url = await opds.listen();
    appDb = join(tmpdir(), `flw-content-load-${process.pid}.db`);
    cacheDir = join(tmpdir(), `flw-content-load-cache-${process.pid}`);
    rmSync(appDb, { force: true });
    rmSync(cacheDir, { force: true, recursive: true });

    Object.assign(process.env, {
      COLLECTION_DB: collectionDb,
      APP_DB: appDb,
      CACHE_DIR: cacheDir,
      CONTENT_SERVICE_URL: url,
      // Ровно столько же, сколько у поддельного сервера: обложкам достаётся один слот,
      // второй зарезервирован под файл.
      CONTENT_SERVICE_CONCURRENCY: '2',
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
    bookId = (
      fastify.db.read.prepare('SELECT min(BookID) AS id FROM coll.Books').get() as { id: number }
    ).id;
  });

  afterAll(async () => {
    await fastify.close();
    await opds.close();
    rmSync(appDb, { force: true });
    rmSync(cacheDir, { force: true, recursive: true });
  });

  afterEach(() => {
    opds.reset();
    opds.handler = () => ({ status: 200, body: JPEG, type: 'image/jpeg' });
  });

  const cover = (id: number, size = 'thumb') =>
    fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${id}/cover?size=${size}`,
      headers: { cookie },
    });

  it('тип обложки — по содержимому, а не по слову content-service', async () => {
    // FLibrary всегда проставляет image/jpeg; при nosniff PNG под этим типом не покажется.
    opds.handler = () => ({ status: 200, body: PNG, type: 'image/jpeg' });

    const response = await cover(10, 'full');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('не запоминает «обложки нет» после ошибки сервера', async () => {
    opds.handler = () => ({ status: 500, body: Buffer.from('oops'), type: 'text/plain' });
    expect((await cover(11)).statusCode).toBe(502);

    // Сервер починился — обложка обязана появиться, а не остаться навсегда «отсутствующей».
    opds.handler = () => ({ status: 200, body: JPEG, type: 'image/jpeg' });
    expect((await cover(11)).statusCode).toBe(200);
  });

  it('запоминает отсутствие обложки, когда его подтвердил сам сервер', async () => {
    opds.handler = () => ({ status: 404, body: Buffer.alloc(0), type: 'text/plain' });
    expect((await cover(12)).statusCode).toBe(404);

    opds.reset();
    expect((await cover(12)).statusCode).toBe(404);
    // Второй раз к content-service не ходим: ответ взят из кэша.
    expect(opds.requests).toHaveLength(0);
  });

  it('скачивание не встаёт в очередь за сеткой обложек', async () => {
    // Страница выдачи: сорок обложек разом, по 40 мс каждая, — это 800 мс работы
    // content-service, которому за раз посильны две.
    const covers = Array.from({ length: 40 }, (_, index) => cover(100 + index));
    // Ждём, пока запросы действительно уедут: иначе скачивание обгонит их само собой
    // и тест ничего не проверит.
    while (opds.requests.length < 5) await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    const download = await fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}/content?format=zip`,
      headers: { cookie },
    });
    const elapsed = Date.now() - started;

    expect(download.statusCode).toBe(200);
    // До исправления скачивание стояло в общей очереди и ждало все обложки.
    expect(elapsed).toBeLessThan(400);

    await Promise.all(covers);
    // Очередь держим у себя, а не наваливаем на content-service: у него она не
    // приоритетная, и скачивание из неё уже не вытащить.
    expect(opds.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('подставляет имя файла, если content-service его не прислал', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/v1/books/${bookId}/content?format=zip`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename=".+\.zip"/);
  });
});
