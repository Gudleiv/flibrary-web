<script setup lang="ts">
// Раздел «Авторы»: боковой список с поиском, книги выбранного автора — рядом.
//
// Авторов в коллекции десятки тысяч, поэтому список постраничный (`GET /authors`),
// а не «загрузить всё и фильтровать на клиенте».

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import type { SearchNode } from '@flibrary/contract';

import BookList from '@/components/BookList.vue';
import BrowseLayout from '@/components/BrowseLayout.vue';
import { getAuthors } from '@/api/client';
import { useBrowse } from '@/composables/useBrowse';

const SIDE_PAGE = 50;

const route = useRoute();
const selected = computed(() => {
  const raw = Number(route.params.authorId);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
});

const filter = ref('');
const sidePage = ref(0);

/**
 * Запрос отстаёт от ввода: поиск по любой части имени — это скан справочника,
 * индексом его не ускорить, и посылать его на каждую букву незачем.
 */
const query = ref('');
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(filter, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (query.value = value), 250);
});
onBeforeUnmount(() => clearTimeout(debounce));

// Новый фильтр — снова с первой страницы: иначе «Толстой» на третьей странице
// прошлого фильтра открывается пустым списком.
watch(query, () => {
  sidePage.value = 0;
});

const authors = useQuery({
  queryKey: computed(() => ['authors', query.value, sidePage.value]),
  queryFn: () =>
    getAuthors({ q: query.value.trim() || undefined, limit: SIDE_PAGE, offset: sidePage.value }),
  placeholderData: keepPreviousData,
  staleTime: 5 * 60_000,
});

const items = computed(() => authors.data.value?.items ?? []);
const sideTotal = computed(() => authors.data.value?.total ?? 0);
const hasMore = computed(() => sidePage.value + SIDE_PAGE < sideTotal.value);

/** Имя выбранного автора берём из списка, а из выдачи — если он на другой странице. */
const selectedName = computed(() => {
  const id = selected.value;
  if (id === null) return null;
  return (
    items.value.find((item) => item.authorId === id)?.name ??
    books.value[0]?.authors.find((author) => author.authorId === id)?.name ??
    null
  );
});

const where = computed<SearchNode | null>(() =>
  selected.value === null ? null : { field: 'authorId', op: 'in', values: [selected.value] },
);

const { page, perPage, results, items: books, total, goToPage } = useBrowse(where);
</script>

<template>
  <BrowseLayout title="Авторы" :subtitle="`${sideTotal.toLocaleString('ru-RU')} в коллекции`">
    <template #side>
      <div class="stack" style="gap: 0.5rem">
        <InputText v-model="filter" placeholder="Фамилия или имя" />

        <div v-if="authors.isLoading.value" style="display: grid; place-items: center">
          <ProgressSpinner style="width: 28px; height: 28px" />
        </div>

        <span v-else-if="items.length === 0" class="muted">Никого не нашлось</span>

        <nav v-else class="side-list" :style="{ opacity: authors.isFetching.value ? 0.6 : 1 }">
          <!-- RouterLink, а не обработчик клика: должны работать средняя кнопка,
               «открыть в новой вкладке» и обычный «назад». -->
          <RouterLink
            v-for="item in items"
            :key="item.authorId"
            class="side-item"
            :class="{ 'side-item--on': item.authorId === selected }"
            :to="{ name: 'authors', params: { authorId: item.authorId } }"
          >
            <span class="side-item__label">{{ item.name }}</span>
            <span class="muted">{{ item.books }}</span>
          </RouterLink>
        </nav>

        <div v-if="sideTotal > SIDE_PAGE" class="row" style="justify-content: space-between">
          <Button
            text
            size="small"
            icon="pi pi-chevron-left"
            :disabled="sidePage === 0"
            aria-label="Предыдущие авторы"
            @click="sidePage = Math.max(0, sidePage - SIDE_PAGE)"
          />
          <span class="muted">
            {{ sidePage + 1 }}–{{ Math.min(sidePage + SIDE_PAGE, sideTotal) }}
          </span>
          <Button
            text
            size="small"
            icon="pi pi-chevron-right"
            :disabled="!hasMore"
            aria-label="Следующие авторы"
            @click="sidePage += SIDE_PAGE"
          />
        </div>
      </div>
    </template>

    <Message v-if="selected === null" severity="secondary" :closable="false">
      Выберите автора.
    </Message>

    <template v-else>
      <h2 v-if="selectedName" style="margin: 0">{{ selectedName }}</h2>
      <BookList
        :items="books"
        :total="total"
        :page="page"
        :per-page="perPage"
        :loading="results.isLoading.value"
        :fetching="results.isFetching.value"
        :took-ms="results.data.value?.tookMs ?? null"
        :error="results.isError.value ? ((results.error.value as Error)?.message ?? null) : null"
        empty-hint="У этого автора книг нет."
        @page="goToPage"
      />
    </template>
  </BrowseLayout>
</template>
