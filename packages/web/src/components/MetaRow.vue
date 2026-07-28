<script setup lang="ts">
// Одна строка таблицы метаданных: подпись слева, значение справа.
//
// Именно таблица, а не строка тегов: тег «1947» рядом с тегом «Русский» не говорит,
// что первое — год издания, а не номер серии.

defineProps<{ label: string }>();
</script>

<template>
  <div class="meta-row">
    <dt class="meta-row__label">{{ label }}</dt>
    <dd class="meta-row__value"><slot /></dd>
  </div>
</template>

<style scoped>
.meta-row {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.5rem;
  padding: 0.2rem 0;
}

@media (max-width: 600px) {
  .meta-row {
    grid-template-columns: 1fr;
    gap: 0;
  }
}

.meta-row__label {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}

.meta-row__value {
  margin: 0;
  min-width: 0;
  /* Значения бывают списками ссылок (авторы, жанры) — они переносятся. */
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.5rem;
  align-items: center;
}
</style>
