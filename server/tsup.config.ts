import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // shared ist reiner TypeScript-Quellcode -> mitbündeln
  noExternal: ['@kuvert/shared'],
  banner: {
    js: "import { createRequire as __kuvertCreateRequire } from 'module'; const require = __kuvertCreateRequire(import.meta.url);",
  },
});
