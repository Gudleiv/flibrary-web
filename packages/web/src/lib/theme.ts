// Светлая и тёмная тема.
//
// По умолчанию — как в системе: телефон с ночным режимом должен открывать приложение
// тёмным, а не слепить белым. Явный выбор пользователя главнее системной настройки и
// переживает перезагрузку.

import { ref, watchEffect, type Ref } from 'vue';

export type Theme = 'light' | 'dark';

const KEY = 'flibrary.theme';
const DARK_MEDIA = '(prefers-color-scheme: dark)';

/**
 * Что показывать. Отдельная функция без DOM: правило «выбор пользователя главнее
 * системы» — единственное здесь, что имеет смысл проверять тестом.
 */
export function resolveTheme(stored: string | null, systemDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return systemDark ? 'dark' : 'light';
}

/**
 * localStorage бывает недоступен: приватный режим, запрет сторонних данных, iframe.
 * Тема — не та причина, по которой приложению стоит падать при старте.
 */
function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(value: Theme): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Ничего страшного: тема доживёт до перезагрузки, а потом снова спросим систему.
  }
}

let theme: Ref<Theme> | null = null;

/**
 * Включает тему до монтирования приложения — иначе тёмная тема мигает светлой на
 * первом кадре. Вызывается из `main.ts`, повторные вызовы возвращают то же состояние.
 */
export function initTheme(): Ref<Theme> {
  if (theme !== null) return theme;

  const media = window.matchMedia(DARK_MEDIA);
  const state = ref<Theme>(resolveTheme(read(), media.matches));

  // Пока пользователь не выбрал тему сам, идём за системой: в телефоне включился
  // ночной режим — приложение темнеет вместе с ним, не дожидаясь перезагрузки.
  media.addEventListener('change', (event) => {
    if (read() === null) state.value = event.matches ? 'dark' : 'light';
  });

  // Класс на <html> — это и есть переключатель темы PrimeVue (`darkModeSelector`).
  watchEffect(() => {
    document.documentElement.classList.toggle('dark', state.value === 'dark');
  });

  theme = state;
  return state;
}

export function useTheme(): { theme: Ref<Theme>; toggle: () => void } {
  const state = initTheme();

  return {
    theme: state,
    /** Ручное переключение — это и есть «выбор пользователя», поэтому его запоминаем. */
    toggle(): void {
      state.value = state.value === 'dark' ? 'light' : 'dark';
      write(state.value);
    },
  };
}
