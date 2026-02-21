import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
      '/admin/config.json': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    manifest: true,
    sourcemap: true,
  },
});
