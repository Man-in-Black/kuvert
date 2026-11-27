/**
 * Kamera-Effekte im Anruf: Hintergrund weichzeichnen oder ersetzen (LiveKit Track-Processors mit
 * MediaPipe-Segmentierung, läuft vollständig im Browser). MediaPipe-WASM und Modell liefert Kuvert
 * selbst aus (/mediapipe/…, siehe vite.config.ts) – es geht nichts an Dritte.
 *
 * Die Hintergrundbilder entstehen per Canvas im Browser (keine Bilddateien, keine Lizenzfragen);
 * ein eigenes Bild bleibt verkleinert im Browser gespeichert.
 */
import { Track, type LocalVideoTrack, type Room } from 'livekit-client';
import type { BackgroundProcessorWrapper } from '@livekit/track-processors';

export type EffectId = 'none' | 'blur-light' | 'blur' | `bg:${string}` | 'custom';

const EFFECT_KEY = 'kuvert.meet.effect';
const CUSTOM_KEY = 'kuvert.meet.customBackground';

const W = 1280;
const H = 720;

/* ───────────── Gespeicherte Auswahl ───────────── */

export function savedEffect(): EffectId {
  try {
    const v = localStorage.getItem(EFFECT_KEY) as EffectId | null;
    if (!v) return 'none';
    if (v === 'custom' && !customBackground()) return 'none';
    if (v.startsWith('bg:') && !BACKGROUNDS.some((b) => `bg:${b.id}` === v)) return 'none';
    return v;
  } catch {
    return 'none';
  }
}

function saveEffect(id: EffectId) {
  try {
    localStorage.setItem(EFFECT_KEY, id);
  } catch {
    /* privates Fenster o. Ä. */
  }
}

export function customBackground(): string | null {
  try {
    return localStorage.getItem(CUSTOM_KEY);
  } catch {
    return null;
  }
}

/** Eigenes Bild übernehmen: auf 1280×720 zuschneiden (wie „cover“) und als JPEG speichern */
export async function setCustomBackground(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.85);
    try {
      localStorage.setItem(CUSTOM_KEY, data);
    } catch {
      throw new Error('Das Bild lässt sich im Browser nicht speichern (Speicher voll?)');
    }
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Das Bild lässt sich nicht lesen'));
    img.src = src;
  });
}

/* ───────────── Hintergründe (per Canvas gezeichnet) ───────────── */

type Draw = (ctx: CanvasRenderingContext2D) => void;

/** Reproduzierbarer Zufall, damit Sterne & Co. bei jedem Aufruf gleich aussehen */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function linear(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

/** Weicher Lichtfleck; rgb = "r,g,b" – läuft in dieselbe Farbe mit Deckkraft 0 aus (nicht nach Schwarz) */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Weiche Lichtpunkte (Bokeh) */
function bokeh(ctx: CanvasRenderingContext2D, seed: number, colors: string[], count: number) {
  const rand = rng(seed);
  ctx.save();
  ctx.filter = 'blur(6px)';
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = 0.15 + rand() * 0.35;
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * H, 20 + rand() * 70, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const drawOffice: Draw = (ctx) => {
  // Wand und Boden
  ctx.fillStyle = linear(ctx, 0, 0, 0, H, [
    [0, '#ece6dc'],
    [1, '#ddd4c6'],
  ]);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b89b7a';
  ctx.fillRect(0, H * 0.82, W, H * 0.18);
  // Fenster mit Himmel
  const fx = 90;
  const fy = 90;
  const fw = 420;
  const fh = 360;
  ctx.fillStyle = linear(ctx, 0, fy, 0, fy + fh, [
    [0, '#8ec5ee'],
    [1, '#d9eefb'],
  ]);
  ctx.fillRect(fx, fy, fw, fh);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (const [x, y, r] of [
    [180, 190, 38],
    [220, 175, 48],
    [265, 192, 34],
    [380, 300, 28],
    [410, 290, 36],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#f7f4ef';
  ctx.lineWidth = 14;
  ctx.strokeRect(fx, fy, fw, fh);
  ctx.beginPath();
  ctx.moveTo(fx + fw / 2, fy);
  ctx.lineTo(fx + fw / 2, fy + fh);
  ctx.moveTo(fx, fy + fh / 2);
  ctx.lineTo(fx + fw, fy + fh / 2);
  ctx.stroke();
  // Regal mit Büchern
  const sx = 760;
  ctx.fillStyle = '#8a6a4a';
  for (const y of [230, 400]) ctx.fillRect(sx, y, 400, 14);
  const rand = rng(7);
  const colors = ['#5b6c8f', '#c46a4a', '#e2b04a', '#4f8a6b', '#8b5a8c', '#d8d0c0', '#3f4a5c'];
  for (const y of [230, 400]) {
    let x = sx + 12;
    while (x < sx + 380) {
      const w = 18 + rand() * 18;
      const h = 90 + rand() * 50;
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)]!;
      ctx.fillRect(x, y - h, w, h);
      x += w + 3;
      if (rand() > 0.85) x += 30;
    }
  }
  // Pflanze
  ctx.fillStyle = '#c9b29a';
  ctx.fillRect(600, H * 0.82 - 90, 80, 90);
  ctx.fillStyle = '#4f8a5b';
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i - 4) * 0.28;
    ctx.beginPath();
    ctx.ellipse(640 + Math.cos(a) * 70, H * 0.82 - 110 + Math.sin(a) * 90, 16, 55, a + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Leicht unscharf wie bei echter Tiefenschärfe
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  copy.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
  ctx.filter = 'blur(3px)';
  ctx.drawImage(copy, 0, 0);
  ctx.filter = 'none';
};

const drawSunrise: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, 0, H, [
    [0, '#ffd3a5'],
    [0.55, '#fd9f8f'],
    [1, '#c86b98'],
  ]);
  ctx.fillRect(0, 0, W, H);
  glow(ctx, W * 0.72, H * 0.42, 260, '255,240,200', 0.9);
  bokeh(ctx, 3, ['#fff3d6', '#ffd1c2', '#ffe9a8'], 26);
};

const drawOcean: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, W, H, [
    [0, '#0f2b4c'],
    [0.6, '#145c7a'],
    [1, '#1d8c97'],
  ]);
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = i % 2 ? '#7fd6e0' : '#bdeff3';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const y0 = 140 + i * 80;
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, y0 + Math.sin(x / 120 + i) * 22);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  glow(ctx, W * 0.2, H * 0.15, 320, '160,230,255', 0.35);
};

const drawForest: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, 0, H, [
    [0, '#d8ecd2'],
    [1, '#6e9f74'],
  ]);
  ctx.fillRect(0, 0, W, H);
  const rand = rng(11);
  for (const [shade, base, scale] of [
    ['#9cc29a', 0.55, 0.8],
    ['#6d9e72', 0.7, 1],
    ['#3f6e4c', 0.85, 1.25],
  ] as const) {
    ctx.fillStyle = shade;
    for (let i = 0; i < 9; i++) {
      const x = rand() * W;
      const h = (180 + rand() * 160) * scale;
      const y = H * base;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x - h * 0.3, y);
      ctx.lineTo(x + h * 0.3, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(0, H * base, W, H);
  }
  glow(ctx, W * 0.8, H * 0.1, 300, '255,255,230', 0.6);
};

const drawSunset: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, 0, H, [
    [0, '#2b1b4f'],
    [0.5, '#8a3d74'],
    [0.8, '#f0855a'],
    [1, '#ffc46b'],
  ]);
  ctx.fillRect(0, 0, W, H);
  glow(ctx, W * 0.5, H * 0.78, 220, '255,214,140', 0.95);
  ctx.fillStyle = '#ffd28a';
  ctx.beginPath();
  ctx.arc(W * 0.5, H * 0.78, 80, 0, Math.PI * 2);
  ctx.fill();
  for (const [color, amp, base, f] of [
    ['#4a2a5c', 50, 0.78, 260],
    ['#2c1a3d', 70, 0.88, 330],
  ] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, H * base + Math.sin(x / f) * amp + Math.sin(x / 97) * 12);
    ctx.lineTo(W, H);
    ctx.fill();
  }
};

const drawNight: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, 0, H, [
    [0, '#060b1f'],
    [1, '#1b2550'],
  ]);
  ctx.fillRect(0, 0, W, H);
  glow(ctx, W * 0.3, H * 0.6, 420, '110,80,200', 0.25);
  glow(ctx, W * 0.75, H * 0.3, 360, '60,140,220', 0.18);
  const rand = rng(42);
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.3 + rand() * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * H, rand() * 1.6 + 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

const drawStudio: Draw = (ctx) => {
  const g = ctx.createRadialGradient(W * 0.5, H * 0.4, 50, W * 0.5, H * 0.5, W * 0.75);
  g.addColorStop(0, '#f3f1ee');
  g.addColorStop(0.6, '#d6d2cc');
  g.addColorStop(1, '#a9a49d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
};

const drawBrand: Draw = (ctx) => {
  ctx.fillStyle = linear(ctx, 0, 0, W, H, [
    [0, '#4f46e5'],
    [0.55, '#6366f1'],
    [1, '#06b6d4'],
  ]);
  ctx.fillRect(0, 0, W, H);
  glow(ctx, W * 0.9, H * 0.05, 380, '255,255,255', 0.22);
  glow(ctx, W * 0.05, H * 1.0, 420, '103,232,249', 0.3);
  bokeh(ctx, 5, ['#ffffff', '#a5f3fc'], 14);
};

export const BACKGROUNDS: { id: string; label: string; draw: Draw }[] = [
  { id: 'office', label: 'Büro', draw: drawOffice },
  { id: 'studio', label: 'Studio', draw: drawStudio },
  { id: 'sunrise', label: 'Morgenlicht', draw: drawSunrise },
  { id: 'ocean', label: 'Ozean', draw: drawOcean },
  { id: 'forest', label: 'Wald', draw: drawForest },
  { id: 'sunset', label: 'Abendrot', draw: drawSunset },
  { id: 'night', label: 'Sternennacht', draw: drawNight },
  { id: 'brand', label: 'Kuvert', draw: drawBrand },
];

const rendered = new Map<string, string>();

/** Hintergrund als Bild-URL (einmal gezeichnet, dann zwischengespeichert) */
export function backgroundUrl(id: string): string {
  const cached = rendered.get(id);
  if (cached) return cached;
  const bg = BACKGROUNDS.find((b) => b.id === id);
  if (!bg) throw new Error('Unbekannter Hintergrund');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  bg.draw(canvas.getContext('2d')!);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  rendered.set(id, url);
  return url;
}

/* ───────────── Anwenden ───────────── */

const ASSETS = { tasksVisionFileSet: '/mediapipe/wasm', modelAssetPath: '/mediapipe/selfie_segmenter.tflite' };

type ProcessorModule = typeof import('@livekit/track-processors');
let modulePromise: Promise<ProcessorModule> | null = null;
const loadModule = () => (modulePromise ??= import('@livekit/track-processors'));

function cameraTrack(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
}

function options(id: EffectId) {
  if (id === 'blur-light') return { mode: 'background-blur' as const, blurRadius: 6 };
  if (id === 'blur') return { mode: 'background-blur' as const, blurRadius: 16 };
  if (id === 'custom') {
    const img = customBackground();
    return img ? { mode: 'virtual-background' as const, imagePath: img } : null;
  }
  if (id.startsWith('bg:')) return { mode: 'virtual-background' as const, imagePath: backgroundUrl(id.slice(3)) };
  return null;
}

/**
 * Effekt auswählen (wird gespeichert) und – falls die Kamera läuft – sofort anwenden.
 * Läuft die Kamera nicht, greift er beim nächsten Einschalten (ensureEffect).
 */
export async function selectEffect(room: Room, id: EffectId): Promise<void> {
  saveEffect(id);
  await ensureEffect(room, id);
}

/** Gespeicherten bzw. angegebenen Effekt auf die laufende Kamera anwenden */
export async function ensureEffect(room: Room, id: EffectId = savedEffect()): Promise<void> {
  const track = cameraTrack(room);
  if (!track) return;
  const opts = options(id);
  const current = track.getProcessor() as BackgroundProcessorWrapper | undefined;
  if (!opts) {
    if (current) await track.stopProcessor();
    return;
  }
  const mod = await loadModule();
  if (!mod.supportsBackgroundProcessors()) throw new Error('Dieser Browser unterstützt keine Hintergrund-Effekte');
  if (current && typeof current.switchTo === 'function') {
    await current.switchTo(opts);
    return;
  }
  await track.setProcessor(mod.BackgroundProcessor({ ...opts, assetPaths: ASSETS }));
}
