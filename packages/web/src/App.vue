<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Menubar from 'primevue/menubar';
import Toast from 'primevue/toast';

import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const showChrome = computed(() => route.name !== 'login');

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
    <Menubar v-if="showChrome">
      <template #start>
        <RouterLink to="/search" style="text-decoration: none; font-weight: 600; padding: 0 0.5rem">
          FLibrary
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
