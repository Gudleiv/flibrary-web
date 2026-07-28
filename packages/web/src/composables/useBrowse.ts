// Выдача разделов навигации: авторы, жанры, языки.
//
// От поиска отличается тем, что фильтр здесь один и берётся из пути (`/genres/001`),
// а не из формы. Общее — страница живёт в URL, поэтому «назад» возвращает на неё же,
// а не в начало списка.
//
// Своих ручек выдачи разделы не заводят: это тот же POST /search с одним предикатом.
// Иначе пришлось бы поддерживать четыре способа получить список книг вместо одного.

import { computed, type ComputedRef } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import type { BookListItem, SearchNode, SearchQuery, SearchResult } from '@flibrary/contract';

import { search } from '@/api/client';
import { PER_PAGE_OPTIONS } from '@/composables/useSearchState';

const DEFAULT_PER_PAGE = 50;

export function useBrowse(where: ComputedRef<SearchNode | null>) {
  const route = useRoute();
  const router = useRouter();

  const page = computed(() => {
    // Номер страницы из URL — пользовательский ввод: дробный или отрицательный дал бы
    // отрицательный offset и 400 от API.
    const parsed = Number(route.query.page);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  });

  const perPage = computed(() => {
    const parsed = Number(route.query.per);
    return PER_PAGE_OPTIONS.includes(parsed) ? parsed : DEFAULT_PER_PAGE;
  });

  const query = computed<SearchQuery | null>(() => {
    if (where.value === null) return null;
    return {
      where: where.value,
      sort: [{ field: 'title', dir: 'asc' }],
      limit: perPage.value,
      offset: (page.value - 1) * perPage.value,
      // Фасетов здесь нет, а число совпадений нужно для пагинации, — так что дешевле
      // одним запросом с withTotal, чем вторым походом в POST /search/facets.
      withTotal: true,
    };
  });

  const results = useQuery<SearchResult>({
    queryKey: computed(() => ['browse', query.value]),
    queryFn: () => search(query.value!),
    enabled: computed(() => query.value !== null),
    placeholderData: keepPreviousData,
  });

  const items = computed<BookListItem[]>(() => results.data.value?.items ?? []);
  const total = computed(() => results.data.value?.total ?? null);

  /** Страница — в URL: «назад» из карточки книги возвращает на неё, а не в начало. */
  function goToPage(next: number, nextPerPage: number): void {
    const params: Record<string, string> = { ...(route.query as Record<string, string>) };
    if (next === 1) delete params.page;
    else params.page = String(next);
    if (nextPerPage === DEFAULT_PER_PAGE) delete params.per;
    else params.per = String(nextPerPage);

    void router.replace({ query: params });
  }

  return { page, perPage, results, items, total, goToPage };
}
