// Дисковый кэш обложек.
//
// Зачем: каждая обложка — это распаковка архива и разбор fb2 в C++, а витрина показывает
// их сетками по 50–100 штук. Кэш в памяти у самого FLibrary живёт минуту, для веба этого
// мало. Обложка книги не меняется, поэтому кэшируем агрессивно и отдаём immutable.
//
// Отрицательный результат («обложки нет») кэшируем тоже — иначе книги без обложки будут
// дёргать content-service при каждом показе списка.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';

export type CoverSize = 'thumb' | 'full';

export interface CachedCover {
  body: Buffer;
  contentType: string;
  etag: string;
}

/** Маркер «обложки у книги нет» — пустой файл рядом с кэшем. */
const MISSING_SUFFIX = '.missing';

export class CoverCache {
  constructor(
    private readonly config: Config,
    private readonly log: { debug(object: unknown, message: string): void },
  ) {
    mkdirSync(this.directory, { recursive: true });
  }

  private get directory(): string {
    return join(this.config.cacheDir, 'covers');
  }

  /** Раскладываем по подкаталогам: 100k файлов в одной директории — плохая идея. */
  private pathFor(bookId: number, size: CoverSize): string {
    const shard = String(bookId % 100).padStart(2, '0');
    const dir = join(this.directory, shard);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${bookId}.${size}`);
  }

  static etagFor(bookId: number, size: CoverSize, body: Buffer): string {
    const digest = createHash('sha1').update(body).digest('base64url').slice(0, 16);
    return `"${bookId}-${size}-${digest}"`;
  }

  async get(bookId: number, size: CoverSize): Promise<CachedCover | 'missing' | null> {
    const path = this.pathFor(bookId, size);

    if (existsSync(path + MISSING_SUFFIX)) return 'missing';
    if (!existsSync(path)) return null;

    const body = await readFile(path);
    return {
      body,
      // Пока храним то, что отдал FLibrary (JPEG). Пережатие в webp и ресайз —
      // следующий шаг, когда появится обработчик изображений.
      contentType: 'image/jpeg',
      etag: CoverCache.etagFor(bookId, size, body),
    };
  }

  async put(bookId: number, size: CoverSize, body: Buffer): Promise<CachedCover> {
    const path = this.pathFor(bookId, size);
    await writeFile(path, body);
    this.log.debug({ bookId, size, bytes: body.length }, 'обложка закэширована');
    return { body, contentType: 'image/jpeg', etag: CoverCache.etagFor(bookId, size, body) };
  }

  async putMissing(bookId: number, size: CoverSize): Promise<void> {
    await writeFile(this.pathFor(bookId, size) + MISSING_SUFFIX, '');
  }
}
