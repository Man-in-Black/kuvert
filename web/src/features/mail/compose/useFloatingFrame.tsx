/**
 * Verschieben und Größe ändern des Verfassen-Fensters im Hauptfenster.
 * Die Position gilt für alle Verfassen-Fenster und wird gemerkt.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { clampRect, COMPOSER_MIN, getComposerRect, setComposerRect, useComposerRect, type ComposerRect } from './store';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGES: Record<Edge, string> = {
  n: 'inset-x-3 top-0 h-1.5 cursor-ns-resize',
  s: 'inset-x-3 bottom-0 h-1.5 cursor-ns-resize',
  e: 'inset-y-3 right-0 w-1.5 cursor-ew-resize',
  w: 'inset-y-3 left-0 w-1.5 cursor-ew-resize',
  ne: 'right-0 top-0 h-3 w-3 cursor-nesw-resize',
  nw: 'left-0 top-0 h-3 w-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
  sw: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize',
};

const NO_DRAG = 'button, a, input, select, textarea, [role="menu"], [role="menuitem"]';

/** Kanten beim Vergrößern am Fensterrand abschneiden, Mindestgröße einhalten */
function clampResize(r: ComposerRect, edge: Edge): ComposerRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let { x, y, w, h } = r;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  w = Math.min(w, vw - x);
  h = Math.min(h, vh - y);
  if (w < COMPOSER_MIN.w) {
    if (edge.includes('w')) x -= COMPOSER_MIN.w - w;
    w = COMPOSER_MIN.w;
  }
  if (h < COMPOSER_MIN.h) {
    if (edge.includes('n')) y -= COMPOSER_MIN.h - h;
    h = COMPOSER_MIN.h;
  }
  return clampRect({ x, y, w, h });
}

export function useFloatingFrame(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const stored = useComposerRect();
  const [live, setLive] = useState<ComposerRect | null>(null);

  // Browserfenster verkleinert → Verfassen-Fenster im sichtbaren Bereich halten
  useEffect(() => {
    if (!enabled) return;
    const fit = () => {
      const r = getComposerRect();
      if (!r) return;
      const c = clampRect(r);
      if (c.x !== r.x || c.y !== r.y || c.w !== r.w || c.h !== r.h) setComposerRect(c);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [enabled]);

  const begin = (e: ReactPointerEvent<HTMLElement>, edge: Edge | 'move') => {
    if (!enabled || e.button !== 0 || !ref.current) return;
    if (edge === 'move' && (e.target as HTMLElement).closest(NO_DRAG)) return;
    if (edge !== 'move') e.preventDefault();
    const b = ref.current.getBoundingClientRect();
    const start: ComposerRect = { x: b.left, y: b.top, w: b.width, h: b.height };
    const sx = e.clientX;
    const sy = e.clientY;
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    let last: ComposerRect | null = null;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!last && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!last) {
        handle.setPointerCapture(pointerId);
        document.body.style.userSelect = 'none';
      }
      if (edge === 'move') {
        last = clampRect({ ...start, x: start.x + dx, y: start.y + dy });
      } else {
        let { x, y, w, h } = start;
        if (edge.includes('e')) w += dx;
        if (edge.includes('s')) h += dy;
        if (edge.includes('w')) {
          w -= dx;
          x += dx;
        }
        if (edge.includes('n')) {
          h -= dy;
          y += dy;
        }
        last = clampResize({ x, y, w, h }, edge);
      }
      setLive(last);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.style.userSelect = '';
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (last) setComposerRect(last);
      setLive(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const rect = enabled ? (live ?? stored) : null;

  return {
    /** Verschieben/Größe ändern möglich (nicht mobil, nicht maximiert) */
    enabled,
    /** Aktuelle Position/Größe; null = angedockt */
    rect,
    /** Gerade beim Ziehen (Iframes dürfen dann keine Zeigerereignisse schlucken) */
    interacting: live !== null,
    /** onPointerDown für die Kopfzeile */
    onDragStart: (e: ReactPointerEvent<HTMLElement>) => begin(e, 'move'),
    /** Zurück an den Standardplatz unten rechts */
    dock: () => setComposerRect(null),
    handles: enabled ? (
      <>
        {(Object.keys(EDGES) as Edge[]).map((edge) => (
          <div key={edge} aria-hidden onPointerDown={(e) => begin(e, edge)} className={cn('absolute z-30 touch-none', EDGES[edge])} />
        ))}
      </>
    ) : null,
  };
}
