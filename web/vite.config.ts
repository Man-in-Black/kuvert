import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Schriften des Whiteboards (Excalidraw) selbst ausliefern statt vom CDN zu laden:
 * im Build nach dist/excalidraw/fonts kopieren, im Dev-Server direkt aus node_modules.
 * Xiaolai (CJK, 13 MB) bleibt außen vor – nur dafür greift Excalidraw auf esm.sh zurück.
 */
function excalidrawFonts(): Plugin {
  // Paket-Einstieg = dist/prod/index.js, daneben liegt fonts/
  const src = path.dirname(fileURLToPath(import.meta.resolve('@excalidraw/excalidraw')));
  const fonts = path.join(src, 'fonts');
  const skip = (p: string) => path.relative(fonts, p).startsWith('Xiaolai');
  let outDir = '';
  return {
    name: 'kuvert-excalidraw-fonts',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const file = path.join(fonts, decodeURIComponent((req.url ?? '').split('?')[0]!));
        if (!file.startsWith(fonts) || skip(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'font/woff2');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      fs.cpSync(fonts, path.join(outDir, 'excalidraw', 'fonts'), { recursive: true, filter: (p) => !skip(p) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawFonts()],
  resolve: {
    alias: {
      '@kuvert/shared': r('../shared/src/index.ts'),
      '@': r('./src'),
    },
  },
  server: {
    port: 5173,
    // ws: Anrufe verbinden sich über /api/meet/lk per WebSocket mit LiveKit
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
});
