<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Menubar from 'primevue/menubar';
import Toast from 'primevue/toast';
import type { MenuItem } from 'primevue/menuitem';

import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const showChrome = computed(() => route.name !== 'login');

const sections: MenuItem[] = [
  { label: 'Поиск', icon: 'pi pi-search', route: { name: 'search' } },
  { label: 'Авторы', icon: 'pi pi-user', route: { name: 'authors' } },
  { label: 'Жанры', icon: 'pi pi-tags', route: { name: 'genres' } },
  { label: 'Языки', icon: 'pi pi-globe', route: { name: 'languages' } },
];

async function onLogout(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

function toggleDark(): void {
  document.documentElement.classList.toggle('dark');
}
</script>

<template>
  <div class="app-shell">
    <Menubar v-if="showChrome" :model="sections">
      <template #start>
        <RouterLink to="/search" style="text-decoration: none; font-weight: 600; padding: 0 0.5rem">
          FLibrary
        </RouterLink>
      </template>
      <!-- Пункты меню — настоящие ссылки: иначе не работают средняя кнопка мыши,
           «открыть в новой вкладке» и предпросмотр адреса в строке состояния. -->
      <template #item="{ item, props }">
        <RouterLink v-slot="{ href, navigate, isActive }" :to="item.route!" custom>
          <a
            :href="href"
            v-bind="props.action"
            :class="{ 'menu-item--on': isActive }"
            @click="navigate"
          >
            <span :class="item.icon" />
            <span>{{ item.label }}</span>
          </a>
        </RouterLink>
      </template>
      <template #end>
        <div class="row">
          <Button text rounded icon="pi pi-moon" aria-label="Тема" @click="toggleDark" />
          <span v-if="auth.user" class="muted">{{ auth.user.displayName }}</span>
          <Button text icon="pi pi-sign-out" label="Выйти" @click="onLogout" />
        </div>
      </template>
    </Menubar>

    <main class="app-body">
      <div class="app-container">
        <RouterView />
      </div>
    </main>

    <Toast />
  </div>
</template>
