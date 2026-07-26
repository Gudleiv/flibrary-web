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

export const coverUrl = (bookId: number, size: 'thumb' | 'full' = 'thumb'): string =>
  `/api/v1/books/${bookId}/cover?size=${size}`;

export const downloadUrl = (bookId: number, format = 'original'): string =>
  `/api/v1/books/${bookId}/content?format=${format}`;
