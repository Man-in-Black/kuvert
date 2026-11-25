import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@kuvert/shared': r('../shared/src/index.ts'),
      '@': r('./src'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8080' } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
});
