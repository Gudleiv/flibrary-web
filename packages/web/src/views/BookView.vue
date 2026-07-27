<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import Tag from 'primevue/tag';

import { downloadBook, getBook } from '@/api/client';
import BookCover from '@/components/BookCover.vue';

const route = useRoute();
const bookId = computed(() => Number(route.params.bookId));

const book = useQuery({
  queryKey: computed(() => ['book', bookId.value]),
  queryFn: () => getBook(bookId.value),
});

/** Книга без названия — не редкость в коллекции; показываем идентификатор, а не пустоту. */
const title = computed(() => {
  const data = book.data.value;
  if (data === undefined) return '';
  return data.title?.trim() || `ID: ${data.bookId}`;
});

const authors = computed(
  () => book.data.value?.authors.map((author) => author.name).join(', ') || 'Неизвестный автор',
);

/**
 * Кнопки скачивания. В `formats` лежит расширение файла в коллекции, а ручка принимает
 * фиксированный набор: djvu, pdf и прочее качаются как `original`, иначе получили бы 400.
 */
const API_FORMATS = new Set(['original', 'fb2', 'zip', 'epub', 'mobi']);

const downloads = computed(() =>
  (book.data.value?.formats ?? []).map((label) => ({
    label,
    format: API_FORMATS.has(label) ? label : 'original',
  })),
);

/** Формат, который сейчас качается: файл собирается на стороне FLibrary не мгновенно. */
const downloading = ref<string | null>(null);
const downloadError = ref<string | null>(null);

async function download(format: string): Promise<void> {
  downloading.value = format;
  downloadError.value = null;
  try {
    await downloadBook(bookId.value, format);
  } catch (error) {
    downloadError.value = (error as Error).message;
  } finally {
    downloading.value = null;
  }
}
</script>

<template>
  <div class="stack">
    <Button text icon="pi pi-arrow-left" label="К результатам" @click="$router.back()" />

    <div v-if="book.isLoading.value" style="display: grid; place-items: center; padding: 2rem">
      <ProgressSpinner style="width: 40px; height: 40px" />
    </div>

    <Message v-else-if="book.isError.value" severity="error" :closable="false">
      {{ (book.error.value as Error)?.message ?? 'Не удалось загрузить книгу' }}
    </Message>

    <Card v-else-if="book.data.value">
      <template #content>
        <div class="book-row" style="gap: 1.5rem">
          <BookCover :book-id="book.data.value.bookId" :title="title" size="full" large />

          <div class="stack" style="min-width: 0">
            <h2 style="margin: 0">{{ title }}</h2>
            <span class="muted">{{ authors }}</span>

            <div class="row" style="gap: 0.35rem">
              <Tag
                v-if="book.data.value.series"
                severity="secondary"
                :value="book.data.value.series.title"
              />
              <Tag
                v-if="book.data.value.year"
                severity="secondary"
                :value="String(book.data.value.year)"
              />
              <Tag v-if="book.data.value.lang" severity="secondary" :value="book.data.value.lang" />
              <Tag
                v-for="genre in book.data.value.genres"
                :key="genre.code"
                severity="secondary"
                :value="genre.title"
              />
              <Tag
                v-if="book.data.value.libRate"
                severity="info"
                :value="`★ ${book.data.value.libRate}`"
              />
            </div>

            <p v-if="book.data.value.annotation" style="white-space: pre-line">
              {{ book.data.value.annotation }}
            </p>
            <span v-else class="muted">Аннотации нет</span>

            <div v-if="book.data.value.keywords?.length" class="row" style="gap: 0.35rem">
              <Tag
                v-for="keyword in book.data.value.keywords"
                :key="keyword"
                severity="secondary"
                :value="keyword"
              />
            </div>

            <div class="row">
              <Button
                v-for="item in downloads"
                :key="item.label"
                :label="`Скачать ${item.label}`"
                icon="pi pi-download"
                severity="secondary"
                :loading="downloading === item.format"
                :disabled="downloading !== null"
                @click="download(item.format)"
              />
            </div>

            <Message v-if="downloadError" severity="warn" :closable="false">
              {{ downloadError }}
            </Message>

            <span v-if="book.data.value.archive" class="muted">
              Архив: {{ book.data.value.archive }}
            </span>
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>
