<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';

import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const login = ref('');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function onSubmit(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await auth.login(login.value, password.value);
    const redirect = route.query.redirect;
    await router.push(typeof redirect === 'string' ? redirect : { name: 'search' });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось войти';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <Card style="width: 360px">
      <!-- Про отсутствие регистрации здесь не пишем: кнопки «зарегистрироваться» на форме
           нет, объяснять пользователю нечего. Разработчику это сказано в openapi.yaml. -->
      <template #title>Вход</template>
      <template #content>
        <form class="stack" @submit.prevent="onSubmit">
          <InputText
            v-model="login"
            placeholder="Логин"
            autocomplete="username"
            :disabled="busy"
            required
          />
          <Password
            v-model="password"
            placeholder="Пароль"
            autocomplete="current-password"
            :feedback="false"
            toggle-mask
            :disabled="busy"
            required
          />
          <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
          <Button type="submit" label="Войти" :loading="busy" />
        </form>
      </template>
    </Card>
  </div>
</template>
