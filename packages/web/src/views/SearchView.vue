<script setup lang="ts">
import { computed } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import Paginator, { type PageState } from 'primevue/paginator';
import ProgressSpinner from 'primevue/progressspinner';
import Select from 'primevue/select';
import type {
  BookListItem,
  Facet,
  FacetField,
  SearchFacets,
  SearchResult,
} from '@flibrary/contract';

import BookRow from '@/components/BookRow.vue';
import FacetPanel from '@/components/FacetPanel.vue';
import { getGenres, getLanguages, search, searchFacets } from '@/api/client';
import { PER_PAGE_OPTIONS, useSearchState, type SearchForm } from '@/composables/useSearchState';

const { form, applied, query, facetQuery, submit, apply } = useSearchState();

const TEXT_FIELDS: Array<{ label: string; value: SearchForm['field'] }> = [
  { label: 'в названии', value: 'title' },
  { label: 'везде', value: 'any' },
  { label: 'по автору', value: 'author' },
  { label: 'в серии', value: 'series' },
  { label: 'в аннотации', value: 'annotation' },
  { label: 'в ключевых словах', value: 'keyword' },
];

const SORT_FIELDS: Array<{ label: string; value: SearchForm['sortField'] }> = [
  { label: 'релевантность', value: 'relevance' },
  { label: 'название', value: 'title' },
  { label: 'автор', value: 'author' },
  { label: 'год', value: 'year' },
  { label: 'рейтинг', value: 'libRate' },
  { label: 'размер', value: 'size' },
  { label: 'дата добавления', value: 'addedAt' },
];

const languages = useQuery({
  queryKey: ['languages'],
  queryFn: getLanguages,
  staleTime: 10 * 60_000,
});

const genres = useQuery({ queryKey: ['genres'], queryFn: getGenres, staleTime: 10 * 60_000 });

/** Дерево жанров разворачиваем в плоский список с отступами — для MultiSelect. */
const genreOptions = computed(() => {
  const options: Array<{ label: string; value: string }> = [];
  const walk = (nodes: NonNullable<typeof genres.data.value>['items'], depth: number): void => {
    for (const node of nodes) {
      options.push({
        label: `${'  '.repeat(depth)}${node.title} (${node.books ?? 0})`,
        value: node.code,
      });
      if (node.children && node.children.length > 0) walk(node.children, depth + 1);
    }
  };
  walk(genres.data.value?.items ?? [], 0);
  return options;
});

// Выдача целиком выводится из URL: ключ запроса — сам запрос. Поэтому «назад» из карточки
// книги показывает ту же страницу, а не пустой список.
const results = useQuery<SearchResult>({
  queryKey: computed(() => ['search', query.value]),
  queryFn: () => search(query.value),
  // Пока грузится соседняя страница, на экране остаётся текущая: без этого листание
  // мигает пустым состоянием «ничего не найдено».
  placeholderData: keepPreviousData,
});

// Счётчики и общее число совпадений — вторым запросом, и это не лишний round-trip, а
// экономия: считаются они по всему совпавшему множеству, поэтому от страницы и
// сортировки не зависят. Ключ запроса — только фильтры, так что листание и смена
// сортировки берут их из кэша, а выдача не ждёт, пока они посчитаются.
const counts = useQuery<SearchFacets>({
  queryKey: computed(() => ['facets', facetQuery.value]),
  queryFn: () => searchFacets(facetQuery.value),
  placeholderData: keepPreviousData,
});

const items = computed<BookListItem[]>(() => results.data.value?.items ?? []);
const total = computed(() => counts.data.value?.total ?? null);
const tookMs = computed(() => results.data.value?.tookMs ?? null);

const facets = computed<Facet[]>(() => counts.data.value?.facets ?? []);

const pageCount = computed(() =>
  total.value === null ? 0 : Math.ceil(total.value / applied.value.perPage),
);

/** Сортировка применяется сразу, поэтому читается из применённого запроса, а не из черновика. */
const sortField = computed({
  get: () => applied.value.sortField,
  set: (value: SearchForm['sortField']) => apply({ sortField: value, page: 1 }),
});

function flipSortDir(): void {
  apply({ sortDir: applied.value.sortDir === 'asc' ? 'desc' : 'asc', page: 1 });
}

/** Что уже выбрано — строками, как значения отдаёт фасет. */
const selectedFacets = computed<Partial<Record<FacetField, string[]>>>(() => ({
  genre: applied.value.genres,
  lang: applied.value.languages,
  ext: applied.value.exts,
  author: applied.value.authors.map(String),
  series: applied.value.series.map(String),
  year:
    applied.value.yearFrom !== null && applied.value.yearFrom === applied.value.yearTo
      ? [String(applied.value.yearFrom)]
      : [],
}));

/** Клик по значению фасета: добавляет фильтр или снимает, если он уже стоит. */
function onFacetToggle(field: FacetField, value: string): void {
  const flip = <T,>(list: T[], item: T): T[] =>
    list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];

  switch (field) {
    case 'genre':
      form.genres = flip(form.genres, value);
      break;
    case 'lang':
      form.languages = flip(form.languages, value);
      break;
    case 'ext':
      form.exts = flip(form.exts, value);
      break;
    case 'author':
      form.authors = flip(form.authors, Number(value));
      break;
    case 'series':
      form.series = flip(form.series, Number(value));
      break;
    case 'year': {
      // Год из фасета — это точное значение, то есть диапазон из одного года.
      const year = Number(value);
      const already = form.yearFrom === year && form.yearTo === year;
      form.yearFrom = already ? null : year;
      form.yearTo = already ? null : year;
      break;
    }
  }

  submit();
}

function onPage(event: PageState): void {
  apply({ page: event.page + 1, perPage: event.rows });
}

function reset(): void {
  Object.assign(form, {
    text: '',
    languages: [],
    genres: [],
    exts: [],
    authors: [],
    series: [],
    yearFrom: null,
    yearTo: null,
  });
  submit();
}
</script>

<template>
  <div class="search-layout">
    <div class="stack">
      <Card>
        <template #title>Фильтры</template>
        <template #content>
          <form class="stack" @submit.prevent="submit">
            <InputText v-model="form.text" placeholder="Что ищем" />
            <Select
              v-model="form.field"
              :options="TEXT_FIELDS"
              option-label="label"
              option-value="value"
            />

            <MultiSelect
              v-model="form.languages"
              :options="languages.data.value?.items ?? []"
              option-label="code"
              option-value="code"
              placeholder="Язык"
              :loading="languages.isLoading.value"
              display="chip"
              filter
            />

            <MultiSelect
              v-model="form.genres"
              :options="genreOptions"
              option-label="label"
              option-value="value"
              placeholder="Жанр"
              :loading="genres.isLoading.value"
              display="chip"
              filter
            />

            <div class="row">
              <InputNumber
                v-model="form.yearFrom"
                placeholder="Год от"
                :use-grouping="false"
                :min="1000"
                :max="2100"
                :input-style="{ width: '6rem' }"
              />
              <InputNumber
                v-model="form.yearTo"
                placeholder="до"
                :use-grouping="false"
                :min="1000"
                :max="2100"
                :input-style="{ width: '6rem' }"
              />
            </div>

            <div class="row">
              <Button type="submit" label="Найти" icon="pi pi-search" />
              <Button type="button" label="Сбросить" severity="secondary" text @click="reset" />
            </div>
          </form>
        </template>
      </Card>

      <Card>
        <template #title>Сортировка</template>
        <template #content>
          <div class="row">
            <Select
              v-model="sortField"
              :options="SORT_FIELDS"
              option-label="label"
              option-value="value"
              style="flex: 1"
            />
            <Button
              text
              :icon="applied.sortDir === 'asc' ? 'pi pi-sort-amount-up' : 'pi pi-sort-amount-down'"
              :aria-label="applied.sortDir === 'asc' ? 'по возрастанию' : 'по убыванию'"
              @click="flipSortDir"
            />
          </div>
        </template>
      </Card>

      <Card v-if="facets.length > 0">
        <template #title>Уточнить</template>
        <template #content>
          <FacetPanel
            :facets="facets"
            :selected="selectedFacets"
            :loading="counts.isFetching.value"
            @toggle="onFacetToggle"
          />
        </template>
      </Card>
    </div>

    <div class="stack">
      <div class="row" style="justify-content: space-between">
        <span class="muted">
          <template v-if="results.isLoading.value">Ищем…</template>
          <template v-else-if="total !== null">
            Найдено: {{ total }}<template v-if="tookMs !== null"> · {{ tookMs }} мс</template>
            <template v-if="pageCount > 1">
              · страница {{ applied.page }} из {{ pageCount }}
            </template>
          </template>
        </span>
      </div>

      <Message v-if="results.isError.value" severity="error" :closable="false">
        {{ (results.error.value as Error)?.message ?? 'Ошибка поиска' }}
      </Message>

      <div v-if="results.isLoading.value" style="display: grid; place-items: center; padding: 2rem">
        <ProgressSpinner style="width: 40px; height: 40px" />
      </div>

      <!-- Пусто или нет, видно по самой выдаче: total приходит отдельным запросом и на
           момент отрисовки списка может ещё не прийти. -->
      <Message
        v-else-if="items.length === 0 && applied.page === 1"
        severity="secondary"
        :closable="false"
      >
        Ничего не найдено. Попробуйте ослабить фильтры.
      </Message>

      <template v-else>
        <Paginator
          :rows="applied.perPage"
          :first="(applied.page - 1) * applied.perPage"
          :total-records="total ?? 0"
          :rows-per-page-options="PER_PAGE_OPTIONS"
          template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
          @page="onPage"
        >
          <!-- У RowsPerPageDropdown нет своей подписи: без неё это просто число рядом с
               номерами страниц, и непонятно, что оно значит. -->
          <template #end><span class="muted">на странице</span></template>
        </Paginator>

        <!-- Страница за концом выдачи (например, по старой ссылке): выдача не пустая,
             поэтому показываем не «ничего не найдено», а способ вернуться. -->
        <Message v-if="items.length === 0" severity="secondary" :closable="false">
          На этой странице пусто: выдача короче.
          <Button label="К первой странице" text @click="apply({ page: 1 })" />
        </Message>

        <!-- Ссылка вокруг всей карточки: кликом открывается книга, а не только заголовок. -->
        <RouterLink
          v-for="book in items"
          :key="book.bookId"
          class="book-card"
          :to="{ name: 'book', params: { bookId: book.bookId } }"
        >
          <Card :style="{ opacity: results.isFetching.value ? 0.6 : 1 }">
            <template #content>
              <BookRow :book="book" />
            </template>
          </Card>
        </RouterLink>

        <Paginator
          :rows="applied.perPage"
          :first="(applied.page - 1) * applied.perPage"
          :total-records="total ?? 0"
          :rows-per-page-options="PER_PAGE_OPTIONS"
          template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
          @page="onPage"
        >
          <!-- У RowsPerPageDropdown нет своей подписи: без неё это просто число рядом с
               номерами страниц, и непонятно, что оно значит. -->
          <template #end><span class="muted">на странице</span></template>
        </Paginator>
      </template>
    </div>
  </div>
</template>
