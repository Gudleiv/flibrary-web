<script setup lang="ts">
import { ref, watch } from 'vue';

import { coverUrl } from '@/api/client';

const props = withDefaults(
  defineProps<{ bookId: number; title: string; size?: 'thumb' | 'full'; large?: boolean }>(),
  { size: 'thumb', large: false },
);

/**
 * Обложка есть не у всякой книги, а content-service может быть занят или недоступен.
 * Прятать картинку нельзя: на её месте останется дыра, и страница выглядит сломанной —
 * показываем заглушку того же размера.
 */
const failed = ref(false);

// Один и тот же компонент переиспользуется под другую книгу при листании выдачи.
watch(
  () => props.bookId,
  () => (failed.value = false),
);
</script>

<template>
  <img
    v-if="!failed"
    class="book-cover"
    :class="{ 'book-cover--large': large }"
    :src="coverUrl(bookId, size)"
    :alt="`Обложка: ${title}`"
    loading="lazy"
    decoding="async"
    @error="failed = true"
  />
  <div
    v-else
    class="book-cover book-cover--empty"
    :class="{ 'book-cover--large': large }"
    role="img"
    :aria-label="`Обложка недоступна: ${title}`"
  >
    <i class="pi pi-book" aria-hidden="true" />
  </div>
</template>
