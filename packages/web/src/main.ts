import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import { VueQueryPlugin } from '@tanstack/vue-query';

import 'primeicons/primeicons.css';
import '@/assets/main.css';

import App from '@/App.vue';
import { router } from '@/router';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        // Тёмная тема включается классом на <html>, а не отдельной сборкой стилей.
        darkModeSelector: '.dark',
        cssLayer: false,
      },
    },
    locale: {
      emptyMessage: 'Ничего не найдено',
      emptySearchMessage: 'Ничего не найдено',
      clear: 'Очистить',
      apply: 'Применить',
    },
  })
  .use(ToastService)
  .use(ConfirmationService)
  .use(VueQueryPlugin, {
    queryClientConfig: {
      defaultOptions: {
        queries: {
          // Каталог меняется только при обновлении коллекции — перезапрашивать
          // при каждом фокусе окна незачем.
          refetchOnWindowFocus: false,
          staleTime: 60_000,
          retry: 1,
        },
      },
    },
  })
  .mount('#app');
