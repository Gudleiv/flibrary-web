<script setup lang="ts">
import { computed } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import Slider from 'primevue/slider';
import TreeSelect from 'primevue/treeselect';
import type {
  BookListItem,
  Facet,
  FacetField,
  SearchFacets,
  SearchResult,
} from '@flibrary/contract';

import BookList from '@/components/BookList.vue';
import FacetPanel from '@/components/FacetPanel.vue';
import FlagIcon from '@/components/FlagIcon.vue';
import { getCollection, getGenres, getLanguages, search, searchFacets } from '@/api/client';
import {
  fromSelection,
  genreTitles,
  toSelection,
  toTreeNodes,
  type GenreSelection,
} from '@/lib/genres';
import { compareByLanguageName, languageName } from '@/lib/lang';
import { useSearchState, type SearchForm } from '@/composables/useSearchState';

const { form, applied, query, facetQuery, submit, apply } = useSearchState();

const SORT_FIELDS: Array<{ label: string; value: SearchForm['sortField'] }> = [
  { label: 'релевантность', value: 'relevance' },
  { label: 'название', value: 'title' },
  { label: 'автор', value: 'author' },
  { label: 'год', value: 'year' },
  { label: 'рейтинг', value: 'libRate' },
  { label: 'размер', value: 'size' },
  { label: 'дата добавления', value: 'addedAt' },
];

const CATALOG = { staleTime: 10 * 60_000 };

const languages = useQuery({ queryKey: ['languages'], queryFn: getLanguages, ...CATALOG });
const genres = useQuery({ queryKey: ['genres'], queryFn: getGenres, ...CATALOG });
const collection = useQuery({ queryKey: ['collection'], queryFn: getCollection, ...CATALOG });

/** Языки — по алфавиту названий: искать «Украинский» в списке, отсортированном по
    числу книг, приходится глазами по всему списку. */
const languageOptions = computed(() =>
  [...(languages.data.value?.items ?? [])]
    .sort((a, b) => compareByLanguageName(a.code, b.code))
    .map((item) => ({ ...item, name: languageName(item.code) })),
);

const genreNodes = computed(() => toTreeNodes(genres.data.value?.items ?? []));

/**
 * Галочки дерева ⇄ список кодов в форме.
 *
 * Дерево показывает выбор родителя как галочки на всех потомках, а в запрос уходит
 * только сам родитель: `includeChildren` уже включает поддерево (см. lib/genres).
 */
const genreSelection = computed<GenreSelection>({
  get: () => toSelection(genres.data.value?.items ?? [], form.genres),
  set: (selection) => {
    form.genres = fromSelection(genres.data.value?.items ?? [], selection);
  },
});

/** Границы ползунка. До ответа /collection — заведомо широкие, чтобы он не прыгал. */
const yearBounds = computed(() => ({
  min: collection.data.value?.yearMin ?? 1500,
  max: collection.data.value?.yearMax ?? new Date().getFullYear(),
}));

/**
 * Ползунок работает с парой чисел, а фильтр — с «границей не задана». Диапазон,
 * растянутый на всю шкалу, и есть «не задана»: иначе фильтр по годам оставался бы
 * включённым после того, как пользователь развёл ручки до краёв, и молча выбрасывал
 * книги без года.
 */
const yearRange = computed<number[]>({
  get: () => [form.yearFrom ?? yearBounds.value.min, form.yearTo ?? yearBounds.value.max],
  set: ([from, to]) => {
    form.yearFrom = from === undefined || from <= yearBounds.value.min ? null : from;
    form.yearTo = to === undefined || to >= yearBounds.value.max ? null : to;
  },
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

const titles = computed(() => genreTitles(genres.data.value?.items ?? []));

/**
 * Счётчики панели плюс выбранные жанры, под которые не попало ни одной книги.
 *
 * Такой жанр исчезает из панели ровно тогда, когда выдача из-за него и опустела, —
 * и снять уточнение становится нечем. Для остальных полей это делает сервер
 * (закреплённые значения), а жанр он не закрепляет: его фасет считается по полному
 * фильтру. Подписи берём из справочника — он и так загружен ради дерева.
 */
const facets = computed<Facet[]>(() => {
  const counted = counts.data.value?.facets ?? [];
  const selected = applied.value.refineGenres;
  if (selected.length === 0) return counted;

  return counted.map((facet) => {
    if (facet.field !== 'genre') return facet;

    const present = new Set(facet.values.map((value) => value.value));
    const missing = selected.filter((code) => !present.has(code));
    if (missing.length === 0) return facet;

    return {
      ...facet,
      values: [
        ...missing.map((code) => ({
          value: code,
          label: titles.value.get(code) ?? code,
          count: 0,
        })),
        ...facet.values,
      ],
    };
  });
});

/** Сортировка применяется сразу, поэтому читается из применённого запроса, а не из черновика. */
const sortField = computed({
  get: () => applied.value.sortField,
  set: (value: SearchForm['sortField']) => apply({ sortField: value, page: 1 }),
});

function flipSortDir(): void {
  apply({ sortDir: applied.value.sortDir === 'asc' ? 'desc' : 'asc', page: 1 });
}

/**
 * Что уже выбрано — строками, как значения отдаёт фасет. Жанры формы сюда тоже
 * входят: в панели они показаны выбранными, и снимать их щелчком логично там же.
 */
const selectedFacets = computed<Partial<Record<FacetField, string[]>>>(() => ({
  genre: [...applied.value.genres, ...applied.value.refineGenres],
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
      // Жанр из формы панель тоже показывает выбранным — щелчок по нему должен
      // снимать фильтр там, где он стоит, а не заводить второе такое же условие.
      if (form.genres.includes(value)) {
        form.genres = form.genres.filter((code) => code !== value);
      } else {
        form.refineGenres = flip(form.refineGenres, value);
      }
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

/**
 * Уточнения переживают новый поиск — так и задумано: найдя автора, дальше ищут его
 * же книги. Но когда из-за них не находится ничего, «ослабьте фильтры» звучит как
 * совет про поля формы, а виноваты отметки в панели, куда никто не смотрит.
 */
const emptyHint = computed(() => {
  const { authors, series, exts, refineGenres } = applied.value;
  const refined = authors.length + series.length + exts.length + refineGenres.length > 0;
  return refined
    ? 'Ничего не найдено. Уточнения слева при новом поиске не сбрасываются — возможно, дело в них.'
    : 'Ничего не найдено. Попробуйте ослабить фильтры.';
});

function onPage(page: number, perPage: number): void {
  apply({ page, perPage });
}

function reset(): void {
  Object.assign(form, {
    title: '',
    author: '',
    languages: [],
    genres: [],
    refineGenres: [],
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
        <template #title>Поиск</template>
        <template #content>
          <form class="stack" @submit.prevent="submit">
            <!-- Два поля вместо «строки и селекта где искать»: так спрашивают почти
                 всегда, а выбирать поле перед вводом приходилось каждый раз. -->
            <InputText v-model="form.title" placeholder="Название" autofocus />
            <InputText v-model="form.author" placeholder="Автор" />

            <MultiSelect
              v-model="form.languages"
              :options="languageOptions"
              option-label="name"
              option-value="code"
              placeholder="Язык"
              :loading="languages.isLoading.value"
              display="chip"
              filter
              filter-placeholder="Найти язык"
            >
              <template #option="{ option }">
                <span class="row" style="gap: 0.5rem">
                  <FlagIcon :code="option.code" />
                  {{ option.name }}
                  <span class="muted">{{ option.books }}</span>
                </span>
              </template>
              <template #chip="{ value }">
                <span class="row" style="gap: 0.35rem">
                  <FlagIcon :code="value" :width="14" />
                  {{ languageName(value) }}
                </span>
              </template>
            </MultiSelect>

            <!-- Дерево, а не плоский список: жанров в коллекции под сотню, и выбрать
                 «Фантастику целиком» без иерархии значит отметить два десятка строк. -->
            <TreeSelect
              v-model="genreSelection"
              :options="genreNodes"
              selection-mode="checkbox"
              display="chip"
              placeholder="Жанр"
              :loading="genres.isLoading.value"
            >
              <template #option="{ node }">
                {{ node.label }} <span class="muted">{{ node.books }}</span>
              </template>
            </TreeSelect>

            <!-- Ползунок отдельной строкой, поля под ним: зажатый между двумя полями
                 ввода, он в колонке шириной 280px оставался шириной в пару сантиметров,
                 и попасть ручкой в нужный год было нечем. -->
            <div class="stack" style="gap: 0.5rem">
              <span class="muted">Год издания</span>
              <Slider
                v-model="yearRange"
                range
                :min="yearBounds.min"
                :max="yearBounds.max"
                style="margin: 0.35rem 0.5rem"
              />
              <div class="row" style="flex-wrap: nowrap">
                <InputNumber
                  v-model="form.yearFrom"
                  :placeholder="String(yearBounds.min)"
                  :use-grouping="false"
                  :min="yearBounds.min"
                  :max="yearBounds.max"
                  :input-style="{ width: '100%' }"
                  size="small"
                  fluid
                />
                <span class="muted">—</span>
                <InputNumber
                  v-model="form.yearTo"
                  :placeholder="String(yearBounds.max)"
                  :use-grouping="false"
                  :min="yearBounds.min"
                  :max="yearBounds.max"
                  :input-style="{ width: '100%' }"
                  size="small"
                  fluid
                />
              </div>
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

    <BookList
      :items="items"
      :total="total"
      :page="applied.page"
      :per-page="applied.perPage"
      :loading="results.isLoading.value"
      :fetching="results.isFetching.value"
      :took-ms="tookMs"
      :empty-hint="emptyHint"
      :error="
        results.isError.value ? ((results.error.value as Error)?.message ?? 'Ошибка поиска') : null
      "
      @page="onPage"
    />
  </div>
</template>
