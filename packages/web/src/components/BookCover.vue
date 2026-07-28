<script setup lang="ts">
import { computed } from 'vue';

import { coverUrl } from '@/api/client';
import { useCoverQueue } from '@/composables/useCoverQueue';

const props = withDefaults(
  defineProps<{ bookId: number; title: string; size?: 'thumb' | 'full'; large?: boolean }>(),
  { size: 'thumb', large: false },
);

/**
 * Обложка есть не у всякой книги, а content-service может быть занят или недоступен.
 * Прятать картинку нельзя: на её месте останется дыра, и страница выглядит сломанной —
 * показываем заглушку того же размера.
 *
 * Пока обложка стоит в очереди (см. useCoverQueue), на её месте крутится индикатор:
 * пустой серый прямоугольник читается как «загрузилось, и там ничего нет».
 */
const { box, src, ready, failed, settle } = useCoverQueue(
  computed(() => coverUrl(props.bookId, props.size)),
);
</script>

<template>
  <div
    ref="box"
    class="book-cover"
    :class="{ 'book-cover--large': large, 'book-cover--empty': failed }"
    :role="failed ? 'img' : undefined"
    :aria-label="failed ? `Обложка недоступна: ${title}` : undefined"
  >
    <img
      v-if="src !== null"
      v-show="ready"
      class="book-cover__image"
      :src="src"
      :alt="`Обложка: ${title}`"
      decoding="async"
      @load="settle(true)"
      @error="settle(false)"
    />
    <i v-if="failed" class="pi pi-book" aria-hidden="true" />
    <i v-else-if="!ready" class="pi pi-spin pi-spinner book-cover__wait" aria-hidden="true" />
  </div>
</template>
