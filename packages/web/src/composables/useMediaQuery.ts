// Медиазапрос как реактивное значение.
//
// Нужен там, где раскладка на телефоне отличается не стилями, а поведением: в
// пагинаторе меньше номеров страниц, справочник разделов сворачивается, форма поиска
// уводит экран к выдаче. Такое CSS не выразить.

import { onBeforeUnmount, readonly, ref, type Ref } from 'vue';

export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const media = window.matchMedia(query);
  const matches = ref(media.matches);

  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches;
  };

  media.addEventListener('change', onChange);
  onBeforeUnmount(() => media.removeEventListener('change', onChange));

  return readonly(matches);
}

/** Тот же порог, что и у одноколоночной раскладки в `main.css`. */
export const NARROW = '(max-width: 960px)';
