<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import Tag from 'primevue/tag';

import { downloadBook, getBook, getBookDetails, getBookReviews, getCollection } from '@/api/client';
import BookCover from '@/components/BookCover.vue';
import FlagIcon from '@/components/FlagIcon.vue';
import MetaRow from '@/components/MetaRow.vue';
import { formatCount, formatDate, formatSize } from '@/lib/format';
import { languageName } from '@/lib/lang';

const route = useRoute();
const bookId = computed(() => Number(route.params.bookId));

const book = useQuery({
  queryKey: computed(() => ['book', bookId.value]),
  queryFn: () => getBook(bookId.value),
});

// Нужны только сведения о коллекции целиком: есть ли в ней аннотации вообще.
// Запрос кэшируется надолго и разделяется с поиском, лишним походом не будет.
const collection = useQuery({
  queryKey: ['collection'],
  queryFn: getCollection,
  staleTime: 10 * 60_000,
});

/**
 * Издатель, язык оригинала, переводчики, содержание и объём текста лежат не в
 * коллекции, а в самом файле книги, поэтому приходят своим запросом и своим темпом.
 *
 * Ошибку показывать не нужно и повторять запрос тоже: без внутреннего C++-сервера
 * ручка всегда отдаёт 502 (в облачной сессии — всегда), и это не поломка карточки,
 * а отсутствие необязательных полей.
 */
const fileDetails = useQuery({
  queryKey: computed(() => ['book-details', bookId.value]),
  queryFn: () => getBookDetails(bookId.value),
  retry: false,
  staleTime: Infinity,
});

/**
 * Отзывы читателей: исторический слепок с форума библиотеки. Живут в архивах
 * «дополнительной папки» коллекции, которой у большинства коллекций нет, — тогда
 * приходит пустой список и раздела просто не будет.
 */
const bookReviews = useQuery({
  queryKey: computed(() => ['book-reviews', bookId.value]),
  queryFn: () => getBookReviews(bookId.value),
  retry: false,
  staleTime: Infinity,
});

const data = computed(() => book.data.value);
const file = computed(() => (fileDetails.isError.value ? undefined : fileDetails.data.value));
const reviews = computed(() =>
  bookReviews.isError.value ? [] : (bookReviews.data.value?.items ?? []),
);

/** Объём текста — как его показывает FLibrary: «букв ≈ страниц, слов». */
const textSize = computed(() => {
  const details = file.value;
  if (details === undefined || details.letters === 0) return null;
  return `${formatCount(details.letters)} букв ≈ ${formatCount(details.pages)} стр., ${formatCount(
    details.words,
  )} слов`;
});

/** Аннотация из файла — запасной вариант: в коллекции её может не быть вовсе. */
const annotation = computed(() => data.value?.annotation ?? file.value?.annotation ?? null);

/** Книга без названия — не редкость в коллекции; показываем идентификатор, а не пустоту. */
const title = computed(() => {
  if (data.value === undefined) return '';
  return data.value.title?.trim() || `ID: ${data.value.bookId}`;
});

const year = computed(() => data.value?.year ?? null);

/**
 * Кнопки скачивания. В `formats` лежит расширение файла в коллекции, а ручка принимает
 * фиксированный набор: djvu, pdf и прочее качаются как `original`, иначе получили бы 400.
 */
const API_FORMATS = new Set(['original', 'fb2', 'zip', 'epub', 'mobi']);

const downloads = computed(() =>
  (data.value?.formats ?? []).map((label) => ({
    label,
    format: API_FORMATS.has(label) ? label : 'original',
  })),
);

/**
 * Аннотации в коллекции опциональны: inpx импортируют и без них (флаг LoadAnnotations
 * у FLibrary). Тогда её нет ни у одной книги, и «у этой книги нет аннотации» — неправда,
 * которая вдобавок заставляет считать сломанным поиск по аннотации.
 */
const noAnnotationsAtAll = computed(() => collection.data.value?.annotations === 0);

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
    <Button class="self-start" text icon="pi pi-arrow-left" label="Назад" @click="$router.back()" />

    <div v-if="book.isLoading.value" style="display: grid; place-items: center; padding: 2rem">
      <ProgressSpinner style="width: 40px; height: 40px" />
    </div>

    <Message v-else-if="book.isError.value" severity="error" :closable="false">
      {{ (book.error.value as Error)?.message ?? 'Не удалось загрузить книгу' }}
    </Message>

    <Card v-else-if="data">
      <template #content>
        <div class="book-row" style="gap: 1.5rem">
          <div class="stack">
            <BookCover :book-id="data.bookId" :title="title" size="full" large />

            <div class="stack" style="gap: 0.5rem">
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
          </div>

          <div class="stack" style="min-width: 0; flex: 1">
            <h2 style="margin: 0">{{ title }}</h2>

            <Message v-if="downloadError" severity="warn" :closable="false">
              {{ downloadError }}
            </Message>

            <!-- Метаданные — списком определений, а не строкой тегов вперемешку:
                 раньше серия, год, язык и жанры лежали рядом одинаковыми плашками,
                 и что из них что — приходилось угадывать. -->
            <dl class="meta">
              <MetaRow v-if="data.authors.length > 0" label="Автор">
                <RouterLink
                  v-for="author in data.authors"
                  :key="author.authorId"
                  :to="{ name: 'authors', params: { authorId: author.authorId } }"
                >
                  {{ author.name }}
                </RouterLink>
              </MetaRow>

              <MetaRow v-if="data.series" label="Серия">
                <RouterLink
                  :to="{ name: 'search', query: { series: String(data.series.seriesId) } }"
                >
                  {{ data.series.title }}
                </RouterLink>
                <span v-if="data.seqNumber !== null && data.seqNumber !== undefined" class="muted">
                  книга {{ data.seqNumber }}
                </span>
              </MetaRow>

              <MetaRow v-if="data.genres?.length" label="Жанр">
                <RouterLink
                  v-for="genre in data.genres ?? []"
                  :key="genre.code"
                  :to="{ name: 'genres', params: { code: genre.code } }"
                >
                  {{ genre.title }}
                </RouterLink>
              </MetaRow>

              <MetaRow v-if="year" label="Год издания">
                <!-- Год — диапазон из одного года: ровно то, что понимает форма поиска. -->
                <RouterLink
                  :to="{ name: 'search', query: { from: String(year), to: String(year) } }"
                >
                  {{ year }}
                </RouterLink>
              </MetaRow>

              <MetaRow v-if="data.lang" label="Язык">
                <RouterLink
                  class="row"
                  style="gap: 0.4rem"
                  :to="{ name: 'languages', params: { code: data.lang } }"
                >
                  <FlagIcon :code="data.lang" :width="18" />
                  {{ languageName(data.lang) }}
                </RouterLink>
              </MetaRow>

              <!-- Дальше — то, чего в коллекционной БД нет: это разбор самого файла
                   книги, и он приходит своим запросом. Полей может не быть вовсе. -->
              <MetaRow v-if="file?.srcLang" label="Язык оригинала">
                <RouterLink
                  class="row"
                  style="gap: 0.4rem"
                  :to="{ name: 'languages', params: { code: file.srcLang } }"
                >
                  <FlagIcon :code="file.srcLang" :width="18" />
                  {{ languageName(file.srcLang) }}
                </RouterLink>
              </MetaRow>

              <MetaRow v-if="file?.translators?.length" label="Перевод">
                {{ file.translators.join(', ') }}
              </MetaRow>

              <MetaRow v-if="file?.publisher" label="Издатель">
                {{ file.publisher }}
                <span v-if="file.publishCity" class="muted">{{ file.publishCity }}</span>
                <span v-if="file.publishYear" class="muted">{{ file.publishYear }}</span>
              </MetaRow>

              <MetaRow v-if="file?.isbn" label="ISBN">{{ file.isbn }}</MetaRow>

              <MetaRow v-if="textSize" label="Объём текста">{{ textSize }}</MetaRow>

              <MetaRow v-if="data.ext" label="Формат">
                <RouterLink :to="{ name: 'search', query: { ext: data.ext } }">
                  {{ data.ext }}
                </RouterLink>
              </MetaRow>

              <MetaRow v-if="formatSize(data.size)" label="Размер">
                {{ formatSize(data.size) }}
              </MetaRow>

              <MetaRow v-if="data.libRate" label="Оценка библиотеки">
                ★ {{ data.libRate }}
              </MetaRow>

              <MetaRow v-if="data.keywords?.length" label="Ключевые слова">
                <Tag
                  v-for="keyword in data.keywords"
                  :key="keyword"
                  severity="secondary"
                  :value="keyword"
                />
              </MetaRow>

              <MetaRow v-if="formatDate(data.updateDate)" label="Дата обновления">
                {{ formatDate(data.updateDate) }}
              </MetaRow>

              <MetaRow v-if="data.sourceLib" label="Источник">{{ data.sourceLib }}</MetaRow>
              <MetaRow v-if="data.libId" label="ID в источнике">{{ data.libId }}</MetaRow>
              <MetaRow v-if="data.archive" label="Архив">{{ data.archive }}</MetaRow>
              <MetaRow v-if="data.fileName" label="Файл">{{ data.fileName }}</MetaRow>
            </dl>

            <section class="stack" style="gap: 0.35rem">
              <h3 style="margin: 0; font-size: 1rem">Аннотация</h3>
              <p v-if="annotation" style="margin: 0; white-space: pre-line">{{ annotation }}</p>
              <!-- Пока файл книги не разобран, «аннотации нет» говорить рано: она может
                   найтись в нём даже там, где в коллекции её не было. -->
              <span v-else-if="fileDetails.isLoading.value" class="muted">Читаем файл книги…</span>
              <!-- Разные вещи: у книги нет аннотации / коллекция собрана без аннотаций.
                   Вторая заодно объясняет, почему поиск по аннотации ничего не находит. -->
              <span v-else-if="noAnnotationsAtAll" class="muted">
                Коллекция импортирована без аннотаций — их нет ни у одной книги, и поиск по
                аннотации в ней ничего не найдёт.
              </span>
              <span v-else class="muted">У этой книги аннотации нет.</span>
            </section>

            <!-- Содержание — как в десктопном FLibrary. Заголовки берутся из файла, так
                 что без внутреннего C++-сервера раздела просто не будет. -->
            <section v-if="file?.chapters?.length" class="stack" style="gap: 0.35rem">
              <h3 style="margin: 0; font-size: 1rem">Содержание</h3>
              <ol class="chapters">
                <li v-for="(chapter, index) in file.chapters" :key="`${index}-${chapter}`">
                  {{ chapter }}
                </li>
              </ol>
            </section>

            <!-- Отзывы: слепок с форума библиотеки. Их нет у большинства коллекций,
                 поэтому пустой раздел не рисуем вовсе. -->
            <section v-if="reviews.length > 0" class="stack" style="gap: 0.5rem">
              <h3 style="margin: 0; font-size: 1rem">Отзывы · {{ reviews.length }}</h3>
              <article
                v-for="(review, index) in reviews"
                :key="`${index}-${review.name}`"
                class="review"
              >
                <div class="row" style="gap: 0.5rem">
                  <span style="font-weight: 600">{{ review.name }}</span>
                  <span class="muted">{{ formatDate(review.time) ?? review.time }}</span>
                </div>
                <p style="margin: 0.25rem 0 0; white-space: pre-line">{{ review.text }}</p>
              </article>
            </section>
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.meta {
  margin: 0;
}

.chapters {
  margin: 0;
  padding-left: 1.5rem;
}

.chapters li {
  padding: 0.1rem 0;
}

/* Отзывов бывает много — разделяем их линией, иначе стена текста без границ. */
.review {
  padding: 0.5rem 0;
  border-top: 1px solid var(--p-content-border-color);
}
</style>
