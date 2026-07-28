// Дисковый кэш разбора fb2.
//
// Цена промаха здесь куда выше, чем у обложки: чтобы узнать издателя, нужно вытащить
// через content-service весь файл книги — а он один на все запросы и держит ровно
// столько параллельных задач, сколько у машины ядер. Разбор одной и той же книги при
// каждом открытии карточки съел бы очередь целиком.
//
// Содержимое книги не меняется, поэтому срока годности у записи нет: кэш чистится
// удалением каталога.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import type { Fb2Details } from '../content/fb2.js';

/** Формат записи: при изменении разбора старые записи должны стать негодными. */
const VERSION = 1;

interface Entry {
  version: number;
  details: Fb2Details;
}

export class DetailsCache {
  constructor(private readonly config: Config) {
    mkdirSync(this.directory, { recursive: true });
  }

  private get directory(): string {
    return join(this.config.cacheDir, 'details');
  }

  /** Раскладываем по подкаталогам: 100k файлов в одной директории — плохая идея. */
  private pathFor(bookId: number): string {
    const shard = String(bookId % 100).padStart(2, '0');
    const dir = join(this.directory, shard);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${bookId}.json`);
  }

  async get(bookId: number): Promise<Fb2Details | null> {
    const path = this.pathFor(bookId);
    if (!existsSync(path)) return null;

    try {
      const entry = JSON.parse(await readFile(path, 'utf8')) as Entry;
      // Битую или устаревшую запись просто игнорируем: разберём заново и перезапишем.
      return entry.version === VERSION ? entry.details : null;
    } catch {
      return null;
    }
  }

  async put(bookId: number, details: Fb2Details): Promise<void> {
    const entry: Entry = { version: VERSION, details };
    await writeFile(this.pathFor(bookId), JSON.stringify(entry));
  }
}
