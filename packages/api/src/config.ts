// Конфигурация из переменных окружения. Валидируется на старте: лучше упасть сразу,
// чем отдавать 500 на каждый запрос из-за неверного пути к БД.

import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** Коллекция FLibrary. Открывается ТОЛЬКО на чтение: её схемой владеет FLibrary. */
  collectionDb: string;
  /** Наша БД: пользователи, сессии, их данные, поисковые индексы. */
  appDb: string;
  /** Дисковый кэш обложек. */
  cacheDir: string;
  /** Внутренний C++-сервер FLibrary (`opds`) — источник обложек и файлов книг. */
  contentServiceUrl: string;
  /**
   * Сколько запросов к content-service можно держать в полёте одновременно.
   * Не тюнинг, а защита: каждый его обработчик занимает поток из глобального
   * QThreadPool, см. комментарий в `src/content/opds.ts`.
   */
  contentServiceConcurrency: number;
  /** Секрет для подписи идентификаторов сессий. */
  sessionSecret: string;
  sessionTtlDays: number;
  cookieName: string;
  cookieSecure: boolean;
  /**
   * «Дополнительная папка» коллекции — та же, что в настройках FLibrary
   * (`additional`). Отзывы читателей лежат в её подкаталоге `reviews` архивами 7z.
   * Пусто — отзывов у коллекции нет, и раздел не показывается.
   */
  additionalDir: string;
  /** Скрывать книги, помеченные в коллекции удалёнными. */
  hideDeleted: boolean;
  /** Время жизни кэша счётчиков фасетов, секунды. 0 — считать всегда заново. */
  queryCacheTtlSeconds: number;
  logLevel: string;
  isProduction: boolean;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} должно быть числом, получено "${raw}"`);
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';

  const config: Config = {
    host: process.env.HOST ?? '127.0.0.1',
    port: number('PORT', 3000),
    collectionDb: resolve(required('COLLECTION_DB', '../../data/collection.db')),
    appDb: resolve(required('APP_DB', '../../data/app.db')),
    cacheDir: resolve(required('CACHE_DIR', '../../data/cache')),
    contentServiceUrl: required('CONTENT_SERVICE_URL', 'http://127.0.0.1:12791'),
    contentServiceConcurrency: number('CONTENT_SERVICE_CONCURRENCY', 4),
    // Не required: коллекции без дополнительной папки — обычное дело.
    additionalDir:
      process.env.ADDITIONAL_DIR === undefined ? '' : resolve(process.env.ADDITIONAL_DIR),
    // В проде секрет обязателен; в разработке допускаем предсказуемый, иначе
    // каждый перезапуск разлогинивает.
    sessionSecret: isProduction
      ? required('SESSION_SECRET')
      : (process.env.SESSION_SECRET ?? 'dev-secret-not-for-production'),
    sessionTtlDays: number('SESSION_TTL_DAYS', 30),
    cookieName: process.env.COOKIE_NAME ?? 'flw_session',
    cookieSecure: boolean('COOKIE_SECURE', isProduction),
    hideDeleted: boolean('HIDE_DELETED', true),
    queryCacheTtlSeconds: number('QUERY_CACHE_TTL_SECONDS', 300),
    logLevel: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    isProduction,
  };

  if (isProduction && config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET в проде должен быть не короче 32 символов');
  }

  // Единицу оставляем допустимой (полная сериализация), а вот ноль или дробь — это
  // молча неработающий сервис.
  if (!Number.isInteger(config.contentServiceConcurrency) || config.contentServiceConcurrency < 1) {
    throw new Error('CONTENT_SERVICE_CONCURRENCY должно быть целым числом не меньше 1');
  }

  return config;
}
