// Сборка Fastify-приложения. Отдельно от точки входа, чтобы тесты могли поднять
// сервер без слушающего сокета (fastify.inject).

import { Ajv2020 } from 'ajv/dist/2020.js';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { Config } from './config.js';
import { openDatabase, type DbHandle } from './db/index.js';
import { IndexStatus } from './indexer/index.js';
import authPlugin from './auth/plugin.js';
import { ContentService } from './content/opds.js';
import { CoverCache } from './cache/covers.js';
import { QueryCache } from './cache/queries.js';
import { EmptyQueryError, UnsupportedPredicateError } from './search/compile.js';
import { InvalidCursorError } from './search/cursor.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import searchRoutes from './routes/search.js';
import bookRoutes from './routes/books.js';
import catalogRoutes from './routes/catalog.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: DbHandle;
    /** Готовность собственного поискового индекса (см. src/indexer). */
    searchIndex: IndexStatus;
    content: ContentService;
    covers: CoverCache;
    /** Кэш счётчиков фасетов в app.db. */
    queries: QueryCache;
  }
}

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.isProduction
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    // Тела запросов у нас небольшие (дерево предикатов), большие payload'ы не нужны.
    bodyLimit: 256 * 1024,
    trustProxy: config.isProduction,
  });

  // Схема поискового запроса — JSON Schema 2020-12, поэтому нужен Ajv2020,
  // а не встроенный в Fastify Ajv 8 с draft-07.
  //
  // Валидаторов два, и это принципиально: path- и query-параметры всегда приходят
  // строками, их нужно приводить к типам; а в теле приведение вредно — "5" вместо 5
  // в дереве предикатов должно быть ошибкой, а не молча исправляться.
  const ajvBody = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
  const ajvParams = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true });
  fastify.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'body' ? ajvBody : ajvParams).compile(schema),
  );

  const db = openDatabase(config, {
    info: (message) => fastify.log.info(message),
    warn: (message) => fastify.log.warn(message),
  });

  const searchIndex = new IndexStatus(db.read);
  if (!searchIndex.isReady()) {
    fastify.log.warn(
      'Поисковый индекс не собран: поиск идёт по FTS коллекции, без морфологии и ' +
        'ранжирования. Соберите: pnpm --filter @flibrary/api reindex',
    );
  }

  fastify.decorate('config', config);
  fastify.decorate('db', db);
  fastify.decorate('searchIndex', searchIndex);
  fastify.decorate('content', new ContentService(config, fastify.log));
  fastify.decorate('covers', new CoverCache(config, fastify.log));
  fastify.decorate(
    'queries',
    new QueryCache(db.read, db.write, {
      ttlSeconds: config.queryCacheTtlSeconds,
      collectionDb: config.collectionDb,
      log: fastify.log,
    }),
  );

  fastify.addHook('onClose', async () => {
    db.close();
  });

  await fastify.register(cookie);
  await fastify.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });
  await fastify.register(authPlugin, {
    cookieName: config.cookieName,
    sessionSecret: config.sessionSecret,
  });

  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    // Ошибки компиляции запроса — это ошибки клиента, а не сервера.
    if (
      error instanceof UnsupportedPredicateError ||
      error instanceof EmptyQueryError ||
      error instanceof InvalidCursorError
    ) {
      return reply.status(400).type('application/problem+json').send({
        title: 'Некорректный поисковый запрос',
        status: 400,
        detail: error.message,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'Необработанная ошибка');

    // Валидация дерева предикатов через oneOf порождает десятки сообщений — по одному
    // на каждый неподошедший вариант. Тащить это в title нельзя: короткий заголовок,
    // а разбор — структурированным списком.
    if (error.validation) {
      const first = error.validation[0];
      return reply
        .status(400)
        .type('application/problem+json')
        .send({
          title: 'Некорректный запрос',
          status: 400,
          detail: `${first?.instancePath || '/'}: ${first?.message ?? 'не проходит валидацию'}`,
          errors: error.validation.slice(0, 20).map((item) => ({
            path: item.instancePath || '/',
            message: item.message ?? 'некорректное значение',
          })),
        });
    }

    return reply
      .status(status)
      .type('application/problem+json')
      .send({
        title: status >= 500 ? 'Внутренняя ошибка' : error.message,
        status,
        ...(status >= 500 && config.isProduction ? {} : { detail: error.message }),
      });
  });

  fastify.setNotFoundHandler((_request, reply) =>
    reply.status(404).type('application/problem+json').send({ title: 'Не найдено', status: 404 }),
  );

  await fastify.register(healthRoutes);
  await fastify.register(
    async (instance) => {
      await instance.register(authRoutes);
      await instance.register(searchRoutes);
      await instance.register(bookRoutes);
      await instance.register(catalogRoutes);
    },
    { prefix: '/api/v1' },
  );

  return fastify;
}
