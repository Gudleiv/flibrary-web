<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import Tag from 'primevue/tag';

import { coverUrl, downloadUrl, getBook } from '@/api/client';

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

function hideBrokenCover(event: Event): void {
  (event.target as HTMLImageElement).style.visibility = 'hidden';
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
          <img
            class="book-cover book-cover--large"
            :src="coverUrl(book.data.value.bookId, 'full')"
            :alt="`Обложка: ${title}`"
            loading="lazy"
            @error="hideBrokenCover"
          />

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
              <a
                v-for="format in book.data.value.formats ?? []"
                :key="format"
                :href="downloadUrl(book.data.value.bookId, format)"
              >
                <Button :label="`Скачать ${format}`" icon="pi pi-download" severity="secondary" />
              </a>
            </div>

            <span v-if="book.data.value.archive" class="muted">
              Архив: {{ book.data.value.archive }}
            </span>
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>
