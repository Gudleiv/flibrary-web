<script setup lang="ts">
// Раздел «Жанры»: аккордеон по дереву слева, книги выбранного жанра — справа.
//
// Аккордеон, а не плоский список: у корневого жанра нет своих книг (их проставляют
// поджанрам), поэтому корень — это заголовок группы, а выбирают обычно поджанр.
// Сам корень выбрать тоже можно — «весь жанр целиком» первым пунктом внутри панели.

import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Accordion from 'primevue/accordion';
import AccordionContent from 'primevue/accordioncontent';
import AccordionHeader from 'primevue/accordionheader';
import AccordionPanel from 'primevue/accordionpanel';
import Message from 'primevue/message';
import type { Genre, SearchNode } from '@flibrary/contract';

import BookList from '@/components/BookList.vue';
import BrowseLayout from '@/components/BrowseLayout.vue';
import { getGenres } from '@/api/client';
import { genreTitles } from '@/lib/genres';
import { useBrowse } from '@/composables/useBrowse';

const route = useRoute();
const selected = computed(() => (route.params.code as string | undefined) ?? null);

const genres = useQuery({ queryKey: ['genres'], queryFn: getGenres, staleTime: 10 * 60_000 });

const roots = computed<Genre[]>(() => genres.data.value?.items ?? []);
const titles = computed(() => genreTitles(roots.value));

/** Раскрытой держим панель выбранного жанра: иначе после перезагрузки не видно, где мы. */
const openPanels = computed<string[]>(() => {
  const code = selected.value;
  if (code === null) return [];
  const root = roots.value.find(
    (node) => node.code === code || (node.children ?? []).some((child) => child.code === code),
  );
  return root === undefined ? [] : [root.code];
});

const where = computed<SearchNode | null>(() =>
  selected.value === null
    ? null
    : // includeChildren: выбранный корень — это «жанр целиком, с поджанрами».
      { field: 'genre', op: 'in', values: [selected.value], includeChildren: true },
);

const { page, perPage, results, items: books, total, goToPage } = useBrowse(where);

const count = (value: number | undefined): string => (value ?? 0).toLocaleString('ru-RU');
</script>

<template>
  <BrowseLayout title="Жанры">
    <template #side>
      <Accordion :value="openPanels" multiple>
        <AccordionPanel v-for="root in roots" :key="root.code" :value="root.code">
          <AccordionHeader>
            <span class="genre-header">
              {{ root.title }} <span class="muted">{{ count(root.books) }}</span>
            </span>
          </AccordionHeader>
          <AccordionContent>
            <nav class="side-list">
              <RouterLink
                class="side-item"
                :class="{ 'side-item--on': root.code === selected }"
                :to="{ name: 'genres', params: { code: root.code } }"
              >
                <span class="side-item__label">Весь жанр</span>
                <span class="muted">{{ count(root.books) }}</span>
              </RouterLink>
              <RouterLink
                v-for="child in root.children ?? []"
                :key="child.code"
                class="side-item"
                :class="{ 'side-item--on': child.code === selected }"
                :to="{ name: 'genres', params: { code: child.code } }"
              >
                <span class="side-item__label">{{ child.title }}</span>
                <span class="muted">{{ count(child.books) }}</span>
              </RouterLink>
            </nav>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </template>

    <Message v-if="selected === null" severity="secondary" :closable="false">
      Выберите жанр слева.
    </Message>

    <template v-else>
      <h2 style="margin: 0">{{ titles.get(selected) ?? selected }}</h2>
      <BookList
        :items="books"
        :total="total"
        :page="page"
        :per-page="perPage"
        :loading="results.isLoading.value"
        :fetching="results.isFetching.value"
        :took-ms="results.data.value?.tookMs ?? null"
        :error="results.isError.value ? ((results.error.value as Error)?.message ?? null) : null"
        empty-hint="В этом жанре книг нет."
        @page="goToPage"
      />
    </template>
  </BrowseLayout>
</template>

<style scoped>
/* Заголовок жанра — такая же строка, как пункт списка: подпись слева, счётчик
   у правого края. Без `flex: 1` заголовок сжимался по тексту, и счётчики стояли
   лесенкой — каждый на своём отступе, а стрелка прыгала вслед за длиной названия. */
.genre-header {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 0.5rem;
  align-items: baseline;
  justify-content: space-between;
}

/* Отступы аккордеона выравниваем сами: по умолчанию у заголовка и содержимого они
   свои (18px), из-за чего счётчик жанра и счётчики его поджанров оказывались в
   разных колонках, а раскрытая панель выглядела съехавшей. */
:deep(.p-accordionheader) {
  padding: 0.55rem 0.4rem;
  gap: 0.5rem;
}

:deep(.p-accordioncontent-content) {
  /* Справа — место под стрелку заголовка, чтобы счётчики встали в одну колонку. */
  padding: 0 calc(0.4rem + 14px + 0.5rem) 0.5rem 0.9rem;
}
</style>
