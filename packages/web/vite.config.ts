import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Единый origin в разработке: куки сессии httpOnly + SameSite=Lax,
    // через кросс-origin они бы не поехали.
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
