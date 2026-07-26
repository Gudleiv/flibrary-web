import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { User } from '@flibrary/contract';

import * as apiClient from '@/api/client';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const checked = ref(false);

  /** Пробует восстановить сессию по куке. Вызывается роутером до первого перехода. */
  async function restore(): Promise<void> {
    if (checked.value) return;
    try {
      user.value = await apiClient.me();
    } catch {
      user.value = null;
    } finally {
      checked.value = true;
    }
  }

  async function login(login: string, password: string): Promise<void> {
    user.value = await apiClient.login(login, password);
    checked.value = true;
  }

  async function logout(): Promise<void> {
    await apiClient.logout();
    user.value = null;
  }

  return { user, checked, restore, login, logout };
});
