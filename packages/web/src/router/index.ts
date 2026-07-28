import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/search' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
  },
  // Выбранный элемент раздела — часть пути, а не состояние компонента: тогда «назад»,
  // «вперёд», перезагрузка и отправленная ссылка работают сами, без нашего участия.
  {
    path: '/authors/:authorId?',
    name: 'authors',
    component: () => import('@/views/AuthorsView.vue'),
  },
  {
    path: '/genres/:code?',
    name: 'genres',
    component: () => import('@/views/GenresView.vue'),
  },
  {
    path: '/languages/:code?',
    name: 'languages',
    component: () => import('@/views/LanguagesView.vue'),
  },
  {
    path: '/books/:bookId',
    name: 'book',
    component: () => import('@/views/BookView.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.restore();

  if (to.meta.public === true) {
    return auth.user === null ? true : { name: 'search' };
  }

  if (auth.user === null) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  return true;
});
