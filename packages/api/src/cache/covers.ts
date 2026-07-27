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

/**
 * Тип картинки по сигнатуре, а не по слову content-service.
 *
 * FLibrary всегда проставляет `image/jpeg`, но отдаёт что нашлось в книге, а вместо
 * отсутствующей обложки — свой PNG-заглушку (`:/images/book.png`). Caddy перед фронтом
 * ставит `X-Content-Type-Options: nosniff`, поэтому PNG, названный jpeg, браузер просто
 * не покажет: обложки нет — и непонятно почему.
 */
export function detectImageType(body: Buffer): string | null {
  const starts = (...bytes: number[]): boolean =>
    bytes.length <= body.length && bytes.every((byte, index) => body[index] === byte);

  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && body.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  // ....ftyp{avif,heic}
  if (body.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = body.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif')) return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('mif1')) return 'image/heic';
  }
  return null;
}

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
    return this.describe(bookId, size, body);
  }

  async put(bookId: number, size: CoverSize, body: Buffer): Promise<CachedCover> {
    const path = this.pathFor(bookId, size);
    await writeFile(path, body);
    this.log.debug({ bookId, size, bytes: body.length }, 'обложка закэширована');
    return this.describe(bookId, size, body);
  }

  /**
   * Тип определяем по самим байтам и на записи, и на чтении: так формат кэша не меняется
   * и уже накопленные файлы начинают отдаваться правильно без пересборки кэша.
   *
   * Пережатие в webp и ресайз — следующий шаг, когда появится обработчик изображений.
   */
  private describe(bookId: number, size: CoverSize, body: Buffer): CachedCover {
    const detected = detectImageType(body);
    if (detected === null) {
      this.log.debug({ bookId, size }, 'формат обложки не опознан, отдаём как jpeg');
    }
    return {
      body,
      contentType: detected ?? 'image/jpeg',
      etag: CoverCache.etagFor(bookId, size, body),
    };
  }

  async putMissing(bookId: number, size: CoverSize): Promise<void> {
    await writeFile(this.pathFor(bookId, size) + MISSING_SUFFIX, '');
  }
}
