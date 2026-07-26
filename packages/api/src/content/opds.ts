// Клиент внутреннего C++-сервера FLibrary (`opds`).
//
// Это единственное место, которое знает его контракт (`/Images/*`). Всё, что связано с
// распаковкой архивов, восстановлением картинок в fb2, извлечением обложек и внешними
// конвертерами, уже реализовано там и переписывать это незачем.
//
// Контракт внутренний и может поехать при обновлении upstream — поэтому он изолирован
// здесь и должен быть закрыт контрактным тестом.

import { request } from 'undici';
import type { Readable } from 'node:stream';

import type { Config } from '../config.js';

export interface ContentResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

export class ContentServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Внутренний content-service недоступен');
    this.name = 'ContentServiceUnavailableError';
    this.cause = cause;
  }
}

/** Формат, в котором отдаётся книга. */
export type BookFormat = 'original' | 'fb2' | 'zip' | 'epub' | 'mobi';

export class ContentService {
  constructor(
    private readonly config: Config,
    private readonly log: { warn(object: unknown, message: string): void },
  ) {}

  /** Обложка в оригинальном виде, как её извлёк FLibrary. */
  cover(bookId: number): Promise<ContentResponse> {
    return this.get(`/Images/covers/${bookId}`);
  }

  /**
   * Файл книги. `zip` — исходник в архиве, `fb2` — с восстановленными картинками,
   * epub/mobi требуют настроенных в FLibrary конвертеров (параметр профиля).
   */
  book(bookId: number, format: BookFormat): Promise<ContentResponse> {
    switch (format) {
      case 'zip':
        return this.get(`/Images/zip/${bookId}`);
      case 'epub':
      case 'mobi':
        // У FLibrary конвертер выбирается профилем в настройках; имя профиля совпадает
        // с расширением в дефолтной конфигурации.
        return this.get(`/Images/fb2/${bookId}`, { profile: format });
      case 'fb2':
      case 'original':
      default:
        return this.get(`/Images/fb2/${bookId}`);
    }
  }

  private async get(path: string, query?: Record<string, string>): Promise<ContentResponse> {
    const url = new URL(path, this.config.contentServiceUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    try {
      const response = await request(url, {
        method: 'GET',
        // Распаковка большой книги с восстановлением картинок бывает небыстрой.
        headersTimeout: 30_000,
        bodyTimeout: 120_000,
      });
      return {
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
      };
    } catch (error) {
      this.log.warn({ err: error, url: url.toString() }, 'content-service недоступен');
      throw new ContentServiceUnavailableError(error);
    }
  }
}
