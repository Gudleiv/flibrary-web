<script setup lang="ts">
// Раскладка разделов навигации: боковое меню со справочником слева, книги справа.
//
// Та же сетка, что у поиска (`.search-layout`): разделы не должны выглядеть как
// другое приложение.

import Card from 'primevue/card';

defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <div class="search-layout">
    <Card class="browse-side">
      <template #title>{{ title }}</template>
      <template v-if="subtitle" #subtitle>
        <span class="muted">{{ subtitle }}</span>
      </template>
      <template #content>
        <slot name="side" />
      </template>
    </Card>

    <div class="stack">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Меню длинное (авторов тысячи), поэтому прокручивается само, а не тянет страницу:
   иначе выдача справа уезжает вниз на высоту всего списка. */
.browse-side {
  position: sticky;
  top: 0;
  max-height: calc(100vh - 5rem);
  overflow: auto;
}
</style>
