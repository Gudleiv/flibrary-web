<script setup lang="ts">
// Выдача книг: состояние загрузки, пагинация сверху и снизу, карточки.
//
// Одна разметка на все разделы — поиск, авторы, жанры, языки. Скопированная, она бы
// разъехалась: пагинатор внизу забыли бы там, пустое состояние тут.

import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import Paginator, { type PageState } from 'primevue/paginator';
import ProgressSpinner from 'primevue/progressspinner';
import type { BookListItem } from '@flibrary/contract';

import BookRow from '@/components/BookRow.vue';
import { PER_PAGE_OPTIONS } from '@/composables/useSearchState';

const props = withDefaults(
  defineProps<{
    items: BookListItem[];
    /** null — ещё не посчитано: число совпадений приходит своим запросом. */
    total: number | null;
    page: number;
    perPage: number;
    loading?: boolean;
    /** Грузится соседняя страница: список гасим, но не убираем. */
    fetching?: boolean;
    error?: string | null;
    tookMs?: number | null;
    /** Чем занят раздел, пока фильтр ничего не выбрал. */
    emptyHint?: string;
  }>(),
  {
    error: null,
    tookMs: null,
    emptyHint: 'Ничего не найдено. Попробуйте ослабить фильтры.',
  },
);

const emit = defineEmits<{ page: [page: number, perPage: number] }>();

const onPage = (event: PageState): void => emit('page', event.page + 1, event.rows);

const pageCount = (): number => (props.total === null ? 0 : Math.ceil(props.total / props.perPage));
</script>

<template>
  <div class="stack">
    <span class="muted">
      <template v-if="loading">Ищем…</template>
      <template v-else-if="total !== null">
        Найдено: {{ total.toLocaleString('ru-RU') }}
        <template v-if="tookMs !== null && tookMs !== undefined"> · {{ tookMs }} мс</template>
        <template v-if="pageCount() > 1"> · страница {{ page }} из {{ pageCount() }}</template>
      </template>
    </span>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="loading" style="display: grid; place-items: center; padding: 2rem">
      <ProgressSpinner style="width: 40px; height: 40px" />
    </div>

    <!-- Пусто или нет, видно по самой выдаче: total приходит отдельным запросом и на
         момент отрисовки списка может ещё не прийти. -->
    <Message v-else-if="items.length === 0 && page === 1" severity="secondary" :closable="false">
      {{ emptyHint }}
    </Message>

    <template v-else>
      <Paginator
        :rows="perPage"
        :first="(page - 1) * perPage"
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
        <Button label="К первой странице" text @click="emit('page', 1, perPage)" />
      </Message>

      <!-- Ссылка вокруг всей карточки: кликом открывается книга, а не только заголовок. -->
      <RouterLink
        v-for="book in items"
        :key="book.bookId"
        class="book-card"
        :to="{ name: 'book', params: { bookId: book.bookId } }"
      >
        <Card :style="{ opacity: fetching ? 0.6 : 1 }">
          <template #content>
            <BookRow :book="book" />
          </template>
        </Card>
      </RouterLink>

      <Paginator
        :rows="perPage"
        :first="(page - 1) * perPage"
        :total-records="total ?? 0"
        :rows-per-page-options="PER_PAGE_OPTIONS"
        template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
        @page="onPage"
      >
        <template #end><span class="muted">на странице</span></template>
      </Paginator>
    </template>
  </div>
</template>
