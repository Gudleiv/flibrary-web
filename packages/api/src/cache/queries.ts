// Кэш дорогих агрегатов (счётчики фасетов) в таблице query_cache.
//
// Зачем: фасет — это GROUP BY по всему отфильтрованному множеству, то есть работа
// порядка «все совпадения», тогда как выдача читает только страницу. На сотнях
// тысяч книг запрос вида «показать всё» считает фасеты заметно дольше, чем сами
// результаты, а пользователь при листании и правках сортировки просит одно и то же.
//
// Ключ — хеш от того, что реально влияет на цифру: SQL с параметрами, пользователь
// (у предикатов favorite/read/userRate свои данные) и отпечаток файла коллекции.
// Поэтому обновление коллекции обесценивает кэш само собой, без инвалидации.
//
// TTL нужен из-за того, чего в ключе нет: пользовательские данные меняются, а SQL
// при этом тот же. Лучше показать счётчик минутной давности, чем городить точную
// инвалидацию ради цифры рядом с фильтром.

import type { Database as Db } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

export interface QueryCacheOptions {
  /** Время жизни записи. 0 и меньше — кэш выключен. */
  ttlSeconds: number;
  /** Файл коллекции: его mtime и размер входят в ключ. */
  collectionDb: string;
  log: { warn(object: unknown, message: string): void };
}

/** Как часто вычищаем протухшее — на каждой записи это лишние удаления. */
const PURGE_INTERVAL_MS = 60_000;

export class QueryCache {
  private lastPurge = 0;

  constructor(
    /** app.db только на чтение — то же соединение, что и у поиска. */
    private readonly read: Db,
    /** app.db на запись: писать можно только сюда. */
    private readonly write: Db,
    private readonly options: QueryCacheOptions,
  ) {}

  get enabled(): boolean {
    return this.options.ttlSeconds > 0;
  }

  /** Ключ кэша: всё, от чего зависит результат, сводится в один хеш. */
  key(parts: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify([this.collectionFingerprint(), parts]))
      .digest('hex');
  }

  get<T>(key: string): T | null {
    if (!this.enabled) return null;

    const row = this.read
      .prepare(
        `SELECT payload FROM query_cache
          WHERE query_hash = ? AND created_at > datetime('now', ?)`,
      )
      .get(key, `-${this.options.ttlSeconds} seconds`) as { payload: string } | undefined;

    if (row === undefined) return null;

    try {
      return JSON.parse(row.payload) as T;
    } catch {
      // Битая строка кэша — не повод ронять поиск: считаем это промахом.
      return null;
    }
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;

    try {
      this.write
        .prepare(
          `INSERT INTO query_cache (query_hash, payload, created_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (query_hash) DO UPDATE
              SET payload = excluded.payload, created_at = excluded.created_at`,
        )
        .run(key, JSON.stringify(value));
      this.purge();
    } catch (error) {
      // Кэш — оптимизация: если app.db занят или недоступен на запись, поиск
      // обязан продолжить работать.
      this.options.log.warn({ err: error }, 'Не удалось записать кэш агрегатов');
    }
  }

  private purge(): void {
    const now = Date.now();
    if (now - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now;

    this.write
      .prepare(`DELETE FROM query_cache WHERE created_at <= datetime('now', ?)`)
      .run(`-${this.options.ttlSeconds} seconds`);
  }

  /**
   * Отпечаток коллекции. Файл открыт READONLY и меняется только при обновлении
   * коллекции, поэтому mtime с размером — достаточная и очень дешёвая метка версии.
   */
  private collectionFingerprint(): string {
    try {
      const stat = statSync(this.options.collectionDb);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Коллекция недоступна — пусть ключ будет уникальным, чем неверным.
      return `unknown:${Date.now()}`;
    }
  }
}
