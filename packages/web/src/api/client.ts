// Типизированный клиент API.
//
// Типы приходят из @flibrary/contract, сгенерированные из openapi.yaml, — руками
// формы ответов не описываем, иначе клиент и сервер разъедутся.

import createClient from 'openapi-fetch';
import type {
  paths,
  SearchQuery,
  SearchResult,
  SearchFacets,
  BookDetail,
} from '@flibrary/contract';

export const api = createClient<paths>({
  baseUrl: '/api/v1',
  // Сессия — в httpOnly-куке, поэтому запросы должны её отправлять.
  credentials: 'same-origin',
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Разворачивает ответ openapi-fetch: либо данные, либо понятная ошибка. */
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;

  const problem = result.error as { title?: string; detail?: string } | undefined;
  throw new ApiError(
    problem?.detail ?? problem?.title ?? `Ошибка запроса (${result.response.status})`,
    result.response.status,
  );
}

export async function login(loginName: string, password: string) {
  return unwrap(await api.POST('/auth/login', { body: { login: loginName, password } }));
}

export async function logout(): Promise<void> {
  await api.POST('/auth/logout');
}

export async function me() {
  return unwrap(await api.GET('/me'));
}

export async function search(query: SearchQuery): Promise<SearchResult> {
  return unwrap(await api.POST('/search', { body: query })) as SearchResult;
}

/**
 * Счётчики фасетов и общее число совпадений. Отдельный запрос, потому что это работа
 * по всему совпавшему множеству: она не зависит от страницы и сортировки, поэтому
 * спрашивается один раз на набор фильтров, а не на каждую страницу.
 */
export async function searchFacets(query: SearchQuery): Promise<SearchFacets> {
  return unwrap(await api.POST('/search/facets', { body: query })) as SearchFacets;
}

export async function getBook(bookId: number): Promise<BookDetail> {
  return unwrap(await api.GET('/books/{bookId}', { params: { path: { bookId } } })) as BookDetail;
}

export async function getCollection() {
  return unwrap(await api.GET('/collection'));
}

export async function getGenres() {
  return unwrap(await api.GET('/genres'));
}

export async function getLanguages() {
  return unwrap(await api.GET('/languages'));
}

/** Алфавитный список авторов для раздела «Авторы» — с листанием, а не топ-N подсказок. */
export async function getAuthors(query: { q?: string; limit?: number; offset?: number }) {
  return unwrap(await api.GET('/authors', { params: { query } }));
}

export const coverUrl = (bookId: number, size: 'thumb' | 'full' = 'thumb'): string =>
  `/api/v1/books/${bookId}/cover?size=${size}`;

export const downloadUrl = (bookId: number, format = 'original'): string =>
  `/api/v1/books/${bookId}/content?format=${format}`;

/**
 * Скачивание через fetch, а не обычной ссылкой.
 *
 * По ссылке браузер уходит на URL ручки, и при ошибке (content-service занят или
 * недоступен) пользователь видит problem+json как страницу вместо сообщения. Файл книги
 * невелик, так что цена буфера в памяти — внятная ошибка и возможность её показать.
 */
export async function downloadBook(bookId: number, format: string): Promise<void> {
  const response = await fetch(downloadUrl(bookId, format), { credentials: 'same-origin' });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      title?: string;
      detail?: string;
    } | null;
    throw new ApiError(
      problem?.detail ?? problem?.title ?? `Не удалось скачать файл (${response.status})`,
      response.status,
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download =
    fileNameFromDisposition(response.headers.get('content-disposition')) ??
    `book-${bookId}.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  // Сразу отзывать нельзя: часть браузеров не успевает начать сохранение.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** `filename*` (RFC 5987) важнее: имена книг обычно кириллические. */
function fileNameFromDisposition(header: string | null): string | null {
  if (header === null) return null;

  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Битую кодировку игнорируем и пробуем обычный filename.
    }
  }

  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim() ?? null;
}
