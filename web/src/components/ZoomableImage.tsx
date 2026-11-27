/**
 * Bild in der Großansicht: Mausrad (bzw. Touchpad-Geste) zoomt zur Mausposition,
 * gezoomt lässt es sich mit der Maus verschieben, Doppelklick wechselt zwischen
 * Einpassen und 2,5-fach.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

const MIN = 1;
const MAX = 10;

interface View {
  s: number;
  x: number;
  y: number;
}

const START: View = { s: 1, x: 0, y: 0 };

export function ZoomableImage({ src, alt, className, imgClassName }: { src: string; alt: string; className?: string; imgClassName?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(START);
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Verschiebung begrenzen: größer als die Fläche → Ränder bleiben drin, kleiner → mittig */
  const clamp = useCallback((v: View): View => {
    const b = box.current;
    const i = img.current;
    if (!b || !i || v.s <= MIN) return START;
    const mx = Math.max(0, (i.offsetWidth * v.s - b.clientWidth) / 2);
    const my = Math.max(0, (i.offsetHeight * v.s - b.clientHeight) / 2);
    return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  }, []);

  /** Auf Faktor s zoomen, der Punkt unter (clientX, clientY) bleibt stehen */
  const zoomAt = useCallback(
    (v: View, s: number, clientX: number, clientY: number): View => {
      const b = box.current;
      const next = Math.min(MAX, Math.max(MIN, s));
      if (!b) return { ...v, s: next };
      const r = b.getBoundingClientRect();
      const px = clientX - (r.left + r.width / 2);
      const py = clientY - (r.top + r.height / 2);
      const k = next / v.s;
      return clamp({ s: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    },
    [clamp],
  );

  // Neues Bild → wieder eingepasst
  useEffect(() => setView(START), [src]);

  // React-Wheel-Handler sind passiv – ohne preventDefault würde der Dialog scrollen bzw. die Seite zoomen
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      // Touchpad-Pinch (ctrlKey) liefert kleine Werte → stärker gewichten
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => zoomAt(v, v.s * factor, e.clientX, e.clientY));
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const zoomed = view.s > MIN;

  return (
    <div
      ref={box}
      className={cn('relative flex touch-none select-none items-center justify-center overflow-hidden', zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'), className)}
      onPointerDown={(e) => {
        if (!zoomed || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        setView((v) => clamp({ s: v.s, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={(e) => setView((v) => (v.s > MIN ? START : zoomAt(v, 2.5, e.clientX, e.clientY)))}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        className={cn('max-h-full max-w-full object-contain', !dragging && 'transition-transform duration-75 ease-out', imgClassName)}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
      {zoomed && (
        <button
          type="button"
          onClick={() => setView(START)}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/75"
          title="Zoom zurücksetzen"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {Math.round(view.s * 100)} %
        </button>
      )}
    </div>
  );
}
