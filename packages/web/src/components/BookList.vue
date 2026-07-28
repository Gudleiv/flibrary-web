<script setup lang="ts">
// Выдача книг: состояние загрузки, пагинация сверху и снизу, карточки.
//
// Одна разметка на все разделы — поиск, авторы, жанры, языки. Скопированная, она бы
// разъехалась: пагинатор внизу забыли бы там, пустое состояние тут.

import { computed, nextTick, ref } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import Paginator, { type PageState } from 'primevue/paginator';
import ProgressSpinner from 'primevue/progressspinner';
import Select from 'primevue/select';
import type { BookListItem } from '@flibrary/contract';

import BookRow from '@/components/BookRow.vue';
import { NARROW, useMediaQuery } from '@/composables/useMediaQuery';
import { PER_PAGE_OPTIONS } from '@/composables/useSearchState';
import { scrollToElement } from '@/lib/scroll';

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

const narrow = useMediaQuery(NARROW);

/**
 * Сколько номеров страниц показывать. Пять номеров плюс четыре кнопки перехода — это
 * 360px только на них, и на телефоне пагинатор переносился на три строки: стрелки
 * «вперёд» отрывались от номеров, а подпись «на странице» улетала отдельно.
 */
const pageLinks = computed(() => (narrow.value ? 3 : 5));

const list = ref<HTMLElement | null>(null);

/** Начало выдачи: без прокрутки следующая страница открывается на середине списка. */
function toTop(): void {
  void nextTick(() => scrollToElement(list.value));
}

function onPage(event: PageState): void {
  emit('page', event.page + 1, event.rows);
  toTop();
}

/** Размер страницы поменялся — счёт страниц другой, начинаем с первой. */
function onPerPage(value: number): void {
  emit('page', 1, value);
  toTop();
}

const pageCount = (): number => (props.total === null ? 0 : Math.ceil(props.total / props.perPage));
</script>

<template>
  <div ref="list" class="stack">
    <!-- Число книг на странице — здесь, а не внутри пагинатора: там оно вставало в один
         ряд с номерами страниц и на телефоне разваливало его на строки. И одного раза
         достаточно — снизу пагинатор повторяется, а настройка одна. -->
    <div class="list-head">
      <span class="muted">
        <template v-if="loading">Ищем…</template>
        <template v-else-if="total !== null">
          Найдено: {{ total.toLocaleString('ru-RU') }}
          <template v-if="tookMs !== null && tookMs !== undefined"> · {{ tookMs }} мс</template>
          <template v-if="pageCount() > 1"> · страница {{ page }} из {{ pageCount() }}</template>
        </template>
      </span>

      <div v-if="!loading && items.length > 0" class="row" style="flex-wrap: nowrap">
        <Select
          :model-value="perPage"
          :options="PER_PAGE_OPTIONS"
          size="small"
          aria-label="Книг на странице"
          @update:model-value="onPerPage"
        />
        <span class="muted">на странице</span>
      </div>
    </div>

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
        :page-link-size="pageLinks"
        template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink"
        @page="onPage"
      />

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
        :page-link-size="pageLinks"
        template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink"
        @page="onPage"
      />
    </template>
  </div>
</template>

<style scoped>
/* Число найденного и размер страницы — по краям строки, а на узком экране друг под
   другом: вместе они длиннее телефона. */
.list-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
}

/* Пагинатор — единственное, чем листают с телефона, поэтому кнопки не меньше пальца:
   рекомендованный минимум цели касания — 44px. */
@media (max-width: 960px) {
  :deep(.p-paginator) {
    padding: 0.25rem;
  }

  :deep(.p-paginator button) {
    min-width: 2.75rem;
    min-height: 2.75rem;
  }
}
</style>
