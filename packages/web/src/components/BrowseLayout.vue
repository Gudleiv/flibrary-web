<script setup lang="ts">
// Раскладка разделов навигации: боковое меню со справочником слева, книги справа.
//
// Та же сетка, что у поиска (`.search-layout`): разделы не должны выглядеть как
// другое приложение.
//
// На телефоне колонка одна, и справочник с выдачей идут друг под другом. Раскрытый
// список авторов — это несколько экранов прокрутки перед книгами, поэтому после выбора
// он сворачивается в заголовок с кнопкой, а экран уезжает к выдаче.

import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';

import { NARROW, useMediaQuery } from '@/composables/useMediaQuery';
import { scrollToElement } from '@/lib/scroll';

const props = defineProps<{
  title: string;
  subtitle?: string;
  /** Подпись кнопки раскрытия на телефоне: «Выбрать автора», «Выбрать жанр». */
  pickLabel: string;
  /** Что выбрано сейчас; null — ничего, тогда справочник раскрыт: за ним и пришли. */
  selection: string | number | null;
}>();

const narrow = useMediaQuery(NARROW);

const open = ref(props.selection === null);
const side = ref<ComponentPublicInstance | null>(null);
const results = ref<HTMLElement | null>(null);

/** Свёрнутым справочник бывает только на телефоне: на десктопе он в своей колонке. */
const showSide = computed(() => !narrow.value || open.value);

watch(
  () => props.selection,
  (value) => {
    if (value === null) {
      open.value = true;
      return;
    }
    open.value = false;
    // Иначе после выбора экран остаётся на середине справочника, и кажется, что
    // ничего не произошло: выдача — ниже, за краем экрана.
    void nextTick(() => scrollToElement(results.value));
  },
);

function toggle(): void {
  open.value = !open.value;
  if (open.value) void nextTick(() => scrollToElement(side.value?.$el as HTMLElement | undefined));
}
</script>

<template>
  <div class="search-layout">
    <Card ref="side" class="browse-side">
      <template #title>
        <div class="browse-side__head">
          <span>{{ title }}</span>
          <!-- Только на телефоне: в двухколоночной раскладке сворачивать нечего. -->
          <Button
            v-if="narrow"
            :label="open ? 'Свернуть' : pickLabel"
            :icon="open ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
            severity="secondary"
            text
            @click="toggle"
          />
        </div>
      </template>
      <template v-if="subtitle && showSide" #subtitle>
        <span class="muted">{{ subtitle }}</span>
      </template>
      <template #content>
        <slot v-if="showSide" name="side" />
      </template>
    </Card>

    <div ref="results" class="stack">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Меню длинное (авторов тысячи), поэтому прокручивается само, а не тянет страницу:
   иначе выдача справа уезжает вниз на высоту всего списка.

   Только в две колонки: на телефоне карточка залипала у верхнего края во всю высоту
   экрана и полностью закрывала собой выдачу, до которой прокручивали. */
@media (min-width: 961px) {
  .browse-side {
    position: sticky;
    top: 0;
    max-height: calc(100vh - 5rem);
    overflow: auto;
  }
}

/* Заголовок раздела и кнопка раскрытия — по краям строки, как в списке. */
.browse-side__head {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
}
</style>
