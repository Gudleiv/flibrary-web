<script setup lang="ts">
// Панель уточнения: счётчики по текущей выдаче.
//
// Значения кликабельны — это и есть основной способ сузить поиск, поэтому выбранные
// показываются здесь же и снимаются повторным щелчком. Сервер закрепляет выбранные
// значения в начале списка, так что снять фильтр можно всегда, даже если у автора
// одна книга и в топ-20 по количеству он бы не попал.

import { computed, ref } from 'vue';
import Button from 'primevue/button';
import type { Facet, FacetField } from '@flibrary/contract';

const props = defineProps<{
  facets: Facet[];
  /** Уже выбранные значения по полям — строками, как их отдаёт фасет. */
  selected: Partial<Record<FacetField, string[]>>;
  loading?: boolean;
}>();

const emit = defineEmits<{ toggle: [field: FacetField, value: string] }>();

const TITLES: Record<FacetField, string> = {
  genre: 'Жанр',
  author: 'Автор',
  series: 'Серия',
  lang: 'Язык',
  year: 'Год',
  ext: 'Формат',
  libRate: 'Рейтинг',
};

/** Сколько значений видно до «показать все». */
const COLLAPSED = 8;

const expanded = ref(new Set<FacetField>());

function toggleExpanded(field: FacetField): void {
  const next = new Set(expanded.value);
  if (next.has(field)) next.delete(field);
  else next.add(field);
  expanded.value = next;
}

const sections = computed(() =>
  props.facets
    .filter((facet) => facet.values.length > 0)
    .map((facet) => {
      const field = facet.field as FacetField;
      const isExpanded = expanded.value.has(field);
      return {
        field,
        title: TITLES[field] ?? field,
        truncated: facet.truncated === true,
        hidden: Math.max(0, facet.values.length - COLLAPSED),
        expanded: isExpanded,
        values: isExpanded ? facet.values : facet.values.slice(0, COLLAPSED),
      };
    }),
);

const isSelected = (field: FacetField, value: string): boolean =>
  props.selected[field]?.includes(value) ?? false;
</script>

<template>
  <div class="stack" :class="{ 'facets--loading': loading }">
    <div v-for="section in sections" :key="section.field" class="stack" style="gap: 0.25rem">
      <span style="font-weight: 600">{{ section.title }}</span>

      <button
        v-for="item in section.values"
        :key="item.value"
        type="button"
        class="facet-value"
        :class="{ 'facet-value--on': isSelected(section.field, item.value) }"
        :aria-pressed="isSelected(section.field, item.value)"
        @click="emit('toggle', section.field, item.value)"
      >
        <span class="facet-value__label">{{ item.label ?? item.value }}</span>
        <span class="muted">{{ item.count }}</span>
      </button>

      <Button
        v-if="section.hidden > 0"
        text
        size="small"
        :label="section.expanded ? 'свернуть' : `ещё ${section.hidden}`"
        @click="toggleExpanded(section.field)"
      />
      <!-- Обрезание не замалчиваем: иначе список выглядит исчерпывающим, а он топ-N. -->
      <span v-if="section.truncated && section.expanded" class="muted">
        показаны самые частые значения
      </span>
    </div>

    <span v-if="sections.length === 0" class="muted">Уточнять нечего</span>
  </div>
</template>

<style scoped>
.facets--loading {
  opacity: 0.5;
}

.facet-value {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.2rem 0.35rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.facet-value:hover {
  background: var(--p-content-hover-background);
}

.facet-value--on {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}

.facet-value__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
