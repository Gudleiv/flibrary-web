<script setup lang="ts">
import { computed } from 'vue';
import Tag from 'primevue/tag';
import type { BookListItem } from '@flibrary/contract';

import BookCover from '@/components/BookCover.vue';
import FlagIcon from '@/components/FlagIcon.vue';
import { formatSize } from '@/lib/format';
import { languageName } from '@/lib/lang';

const props = defineProps<{ book: BookListItem }>();

/**
 * В коллекции попадаются книги без названия (в нашей — два десятка на 700 тысяч).
 * Пустая строка в списке выглядит как сломанная вёрстка, поэтому показываем хотя бы
 * идентификатор: по нему книгу можно найти и открыть.
 */
const title = computed(() => props.book.title?.trim() || `ID: ${props.book.bookId}`);

// «Неизвестный автор» подставляет API: в коллекции это отдельная запись справочника
// с английским именем, а не отсутствие данных.
const authors = computed(
  () => props.book.authors.map((author) => author.name).join(', ') || 'Неизвестный автор',
);

const seriesLabel = computed(() => {
  const series = props.book.series;
  if (!series) return null;
  return props.book.seqNumber === null || props.book.seqNumber === undefined
    ? series.title
    : `${series.title} #${props.book.seqNumber}`;
});

const sizeLabel = computed(() => formatSize(props.book.size));
</script>

<template>
  <div class="book-row">
    <!-- Ленивая загрузка: на странице до сотни обложек, каждая — распаковка архива. -->
    <BookCover :book-id="book.bookId" :title="title" />
    <div class="stack" style="gap: 0.25rem; min-width: 0">
      <!-- Ссылка не здесь, а на всей карточке (SearchView): кликабельным должен быть
           весь блок, а вложенная ссылка внутри ссылки — невалидная разметка. -->
      <span style="font-weight: 600">{{ title }}</span>
      <span class="muted">{{ authors }}</span>
      <div class="row" style="gap: 0.35rem">
        <Tag v-if="seriesLabel" severity="secondary" :value="seriesLabel" />
        <Tag v-if="book.year" severity="secondary" :value="String(book.year)" />
        <Tag v-if="book.lang" severity="secondary">
          <FlagIcon :code="book.lang" :width="14" />
          {{ languageName(book.lang) }}
        </Tag>
        <Tag v-if="book.ext" severity="secondary" :value="book.ext" />
        <Tag v-if="sizeLabel" severity="secondary" :value="sizeLabel" />
        <Tag v-if="book.libRate" severity="info" :value="`★ ${book.libRate}`" />
        <Tag v-if="book.favorite" severity="warn" value="избранное" />
      </div>
    </div>
  </div>
</template>
