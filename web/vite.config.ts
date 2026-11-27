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

/**
 * MediaPipe (Hintergrund-Weichzeichner und virtuelle Hintergründe im Anruf) selbst ausliefern statt
 * von jsDelivr: WASM-Dateien aus node_modules nach dist/mediapipe/wasm. Das Segmentierungsmodell
 * (selfie_segmenter.tflite, Apache-2.0) liegt in public/mediapipe.
 */
function mediapipeWasm(): Plugin {
  const pkg = path.dirname(fileURLToPath(import.meta.resolve('@mediapipe/tasks-vision')));
  const wasm = path.join(pkg, 'wasm');
  let outDir = '';
  return {
    name: 'kuvert-mediapipe-wasm',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const file = path.join(wasm, decodeURIComponent((req.url ?? '').split('?')[0]!));
        if (!file.startsWith(wasm) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      fs.cpSync(wasm, path.join(outDir, 'mediapipe', 'wasm'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawFonts(), mediapipeWasm()],
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
