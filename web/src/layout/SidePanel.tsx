/**
 * Seitenleisten rechts (KI-Chat, Kalender …): entweder schwebend über dem Inhalt oder
 * „angepinnt“ – dann sitzen sie im Dock neben <main>, und der Inhalt (Liste, Lesefenster)
 * rückt zur Seite, statt verdeckt zu werden. Angepinnt-Status und Breite bleiben pro
 * Leiste im Browser gespeichert. Mobil immer bildschirmfüllend und nie angepinnt.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pin, PinOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';

const PINNED_KEY = 'kuvert.panels.pinned';
const WIDTH_KEY = 'kuvert.panels.width';
const MIN_WIDTH = 300;
const MAX_WIDTH = 760;

function load<V>(key: string): Record<string, V> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, V>) : {};
  } catch {
    return {};
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

interface State {
  pinned: Record<string, boolean>;
  width: Record<string, number>;
  dock: HTMLElement | null;
}

let state: State = { pinned: load<boolean>(PINNED_KEY), width: load<number>(WIDTH_KEY), dock: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state));
}

export function isPanelPinned(id: string): boolean {
  return !!state.pinned[id];
}

export function setPanelPinned(id: string, pinned: boolean) {
  const next = { ...state.pinned, [id]: pinned };
  save(PINNED_KEY, next);
  set({ pinned: next });
}

/** Schwebende Leisten liegen alle am rechten Rand – beim Öffnen einer neuen schließen die anderen */
const overlays = new Map<string, () => void>();

/** Platz neben dem Inhalt für angepinnte Leisten (einmal in der AppShell) */
export function SidePanelDock() {
  const ref = useCallback((el: HTMLDivElement | null) => set({ dock: el }), []);
  return <div ref={ref} className="flex min-h-0 shrink-0" />;
}

export function SidePanel({
  id,
  label,
  defaultWidth = 400,
  onClose,
  canClose = true,
  className,
  children,
}: {
  id: string;
  label: string;
  defaultWidth?: number;
  onClose: () => void;
  /** false: Esc schließt nicht (z. B. während eine Antwort läuft) */
  canClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const dock = useStore((s) => s.dock);
  const pinned = useStore((s) => !!s.pinned[id]) && !mobile;
  const width = useStore((s) => s.width[id]) ?? defaultWidth;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Schwebend: andere schwebende Leisten schließen und sich selbst anmelden
  useEffect(() => {
    if (pinned) return;
    overlays.forEach((close, other) => other !== id && close());
    const close = () => closeRef.current();
    overlays.set(id, close);
    return () => {
      if (overlays.get(id) === close) overlays.delete(id);
    };
  }, [id, pinned]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Dialoge (Portal) liegen im React-Baum darunter, aber nicht in der Leiste
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.key === 'Escape' && !pinned && canClose) onClose();
  };

  // Ohne Dock (noch nicht eingehängt, eigenständiges Fenster) schwebend in <body>
  const target = dock ?? document.body;

  return createPortal(
    <aside
      // Angepinnt höchstens 60 % der Fensterbreite, damit Liste und Lesefenster bedienbar bleiben
      style={mobile ? undefined : { width: pinned && dock ? `min(${width}px, 60vw)` : `min(${width}px, 100vw)` }}
      className={cn(
        'flex flex-col bg-surface',
        pinned && dock
          ? 'relative h-full shrink-0 border-l border-border'
          : cn('fixed z-40 animate-slide-in-right border-border shadow-pop', mobile ? 'inset-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : 'inset-y-0 right-0 border-l'),
        className,
      )}
      role="complementary"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {!mobile && <ResizeHandle id={id} width={width} />}
      {children}
    </aside>,
    target,
  );
}

/** Ziehen am linken Rand ändert die Breite (Doppelklick: Standardbreite) */
function ResizeHandle({ id, width }: { id: string; width: number }) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let next = width;
    const move = (ev: PointerEvent) => {
      next = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + startX - ev.clientX)));
      set({ width: { ...state.width, [id]: next } });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.removeProperty('cursor');
      save(WIDTH_KEY, state.width);
    };
    document.body.style.cursor = 'col-resize';
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Breite ziehen (Doppelklick: zurücksetzen)"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const rest = { ...state.width };
        delete rest[id];
        set({ width: rest });
        save(WIDTH_KEY, rest);
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/20 active:bg-primary/30"
    />
  );
}

/** Pinnadel-Knopf für den Kopf einer Leiste (mobil ausgeblendet) */
export function PinPanelButton({ id, className }: { id: string; className?: string }) {
  const mobile = useIsMobile();
  const pinned = useStore((s) => !!s.pinned[id]);
  if (mobile) return null;
  const label = pinned ? 'Lösen (schwebend über dem Inhalt)' : 'Anpinnen (Inhalt rückt zur Seite)';
  return (
    <button
      type="button"
      onClick={() => setPanelPinned(id, !pinned)}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      className={cn(
        'rounded-md p-1.5 transition-colors hover:bg-hover hover:text-fg',
        pinned ? 'bg-primary-soft text-primary' : 'text-muted',
        className,
      )}
    >
      {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
    </button>
  );
}
