<script setup lang="ts">
// Раздел «Языки»: список языков слева, книги выбранного — справа.

import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Message from 'primevue/message';
import type { SearchNode } from '@flibrary/contract';

import BookList from '@/components/BookList.vue';
import BrowseLayout from '@/components/BrowseLayout.vue';
import FlagIcon from '@/components/FlagIcon.vue';
import { getLanguages } from '@/api/client';
import { compareByLanguageName, languageName } from '@/lib/lang';
import { useBrowse } from '@/composables/useBrowse';

const route = useRoute();

// Необязательный параметр маршрута приходит пустой строкой, а не undefined: без этой
// проверки `/languages` без выбора считался выбранным языком «» и открывался пустой
// выдачей вместо приглашения выбрать.
const selected = computed(() => {
  const code = route.params.code;
  return typeof code === 'string' && code !== '' ? code : null;
});

const languages = useQuery({
  queryKey: ['languages'],
  queryFn: getLanguages,
  staleTime: 10 * 60_000,
});

/** А-Я по названию, а не по числу книг: в списке ищут глазами конкретный язык. */
const items = computed(() =>
  [...(languages.data.value?.items ?? [])].sort((a, b) => compareByLanguageName(a.code, b.code)),
);

const where = computed<SearchNode | null>(() =>
  selected.value === null ? null : { field: 'lang', op: 'in', values: [selected.value] },
);

const { page, perPage, results, items: books, total, goToPage } = useBrowse(where);
</script>

<template>
  <BrowseLayout
    title="Языки"
    :subtitle="`${items.length} в коллекции`"
    pick-label="Выбрать язык"
    :selection="selected"
  >
    <template #side>
      <nav class="side-list">
        <!-- RouterLink, а не обработчик клика: должны работать средняя кнопка,
             «открыть в новой вкладке» и обычный «назад». -->
        <RouterLink
          v-for="item in items"
          :key="item.code"
          class="side-item"
          :class="{ 'side-item--on': item.code === selected }"
          :to="{ name: 'languages', params: { code: item.code } }"
        >
          <FlagIcon :code="item.code" :width="20" />
          <span class="side-item__label">{{ languageName(item.code) }}</span>
          <span class="muted">{{ item.books.toLocaleString('ru-RU') }}</span>
        </RouterLink>
      </nav>
    </template>

    <Message v-if="selected === null" severity="secondary" :closable="false">
      Выберите язык.
    </Message>

    <!-- Заголовок с названием языка: на телефоне справочник после выбора свёрнут,
         и без него не видно, чей это список. -->
    <template v-else>
      <h2 class="row" style="margin: 0; gap: 0.5rem">
        <FlagIcon :code="selected" :width="24" />
        {{ languageName(selected) }}
      </h2>
      <BookList
        :items="books"
        :total="total"
        :page="page"
        :per-page="perPage"
        :loading="results.isLoading.value"
        :fetching="results.isFetching.value"
        :took-ms="results.data.value?.tookMs ?? null"
        :error="results.isError.value ? ((results.error.value as Error)?.message ?? null) : null"
        empty-hint="На этом языке книг нет."
        @page="goToPage"
      />
    </template>
  </BrowseLayout>
</template>
