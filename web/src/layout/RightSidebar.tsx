/**
 * Seitenleiste rechts (wie bei Gmail) mit den Panels der Module (Kalender, Kontakte, Chat,
 * KI-Chat, Telefon …):
 * - eingeklappt: schmale Leiste mit den Symbolen untereinander
 * - aufgeklappt: das gewählte Panel, unten kleine Reiter zum Wechseln, Anpinnen und Einklappen
 * Angepinnt sitzt das Panel neben <main> und der Inhalt rückt zur Seite; sonst schwebt es
 * über dem Inhalt (Esc schließt). Alle Panels teilen sich eine Breite. Mobil gibt es keine
 * Leiste – Panels öffnen bildschirmfüllend über die Aktionen im „Mehr“-Menü bzw. die
 * Befehlspalette.
 */
import { Suspense, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronsRight, Pin, PinOff, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import type { SidePanelDef } from '@/modules/types';
import { useSidePanels } from './shell-helpers';
import {
  closeSidePanel,
  openSidePanel,
  persistSidebarWidth,
  setSidebarPinned,
  setSidebarWidth,
  toggleSidePanel,
  useActiveSidePanel,
  useSidePanelState,
} from './side-panel-store';

/** Eine Breite für alle Panels (ziehbar, gilt dann für alle) */
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;
const MAX_WIDTH = 760;

export function RightSidebar() {
  const panels = useSidePanels();
  const mobile = useIsMobile();
  const active = useActiveSidePanel();
  const pinned = useSidePanelState((s) => s.pinned) && !mobile;
  // Panel eines (noch) nicht aktiven Moduls zählt als eingeklappt
  const current = panels.find((p) => p.id === active) ?? null;

  if (!panels.length) return null;
  return (
    <>
      {/* Schwebend bleibt die schmale Leiste im Layout stehen, damit der Inhalt nicht springt */}
      {!mobile && (!current || !pinned) && <Rail panels={panels} active={current?.id ?? null} />}
      {current && <PanelFrame panel={current} panels={panels} pinned={pinned} mobile={mobile} />}
    </>
  );
}

/* ═════════════════════════════ Eingeklappt: Symbole untereinander ═════════════════════════════ */

function Rail({ panels, active }: { panels: SidePanelDef[]; active: string | null }) {
  return (
    <aside className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-sidebar py-3 md:flex" aria-label="Seitenleiste">
      {panels.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => toggleSidePanel(p.id)}
          title={p.label}
          aria-label={p.label}
          aria-pressed={active === p.id}
          className={cn(
            'group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
            active === p.id ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-hover hover:text-fg',
          )}
        >
          <p.icon className="h-[18px] w-[18px] transition-transform group-hover:scale-105" />
          {p.useBadge && <PanelBadge useCount={p.useBadge} />}
        </button>
      ))}
    </aside>
  );
}

/* ═════════════════════════════ Aufgeklappt: Panel mit Reitern unten ═════════════════════════════ */

function PanelFrame({ panel, panels, pinned, mobile }: { panel: SidePanelDef; panels: SidePanelDef[]; pinned: boolean; mobile: boolean }) {
  const width = useSidePanelState((s) => s.width) ?? DEFAULT_WIDTH;
  const Body = panel.component;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Dialoge (Portal) liegen im React-Baum darunter, aber nicht in der Leiste
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.key === 'Escape' && !pinned && !e.defaultPrevented) closeSidePanel();
  };

  return (
    <aside
      // Angepinnt höchstens 60 % der Fensterbreite, damit Liste und Lesefenster bedienbar bleiben
      style={mobile ? undefined : { width: pinned ? `min(${width}px, 60vw)` : `min(${width}px, 100vw)` }}
      className={cn(
        'flex flex-col bg-surface',
        pinned
          ? 'relative h-full shrink-0 border-l border-border'
          : cn(
              'fixed z-40 animate-slide-in-right border-border shadow-pop',
              mobile ? 'inset-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : 'inset-y-0 right-0 border-l',
            ),
      )}
      role="complementary"
      aria-label={panel.label}
      onKeyDown={onKeyDown}
    >
      {!mobile && <ResizeHandle width={width} />}
      <div className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary key={panel.id} label={panel.label}>
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            }
          >
            <Body />
          </Suspense>
        </ErrorBoundary>
      </div>
      <TabBar panels={panels} active={panel.id} pinned={pinned} mobile={mobile} />
    </aside>
  );
}

function TabBar({ panels, active, pinned, mobile }: { panels: SidePanelDef[]; active: string; pinned: boolean; mobile: boolean }) {
  const pinLabel = pinned ? 'Lösen (schwebend über dem Inhalt)' : 'Anpinnen (Inhalt rückt zur Seite)';
  return (
    <nav className="flex h-12 shrink-0 items-stretch border-t border-border bg-sidebar" aria-label="Seitenleiste">
      <div role="tablist" className="flex min-w-0 flex-1">
        {panels.map((p) => {
          const on = p.id === active;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => openSidePanel(p.id)}
              title={p.label}
              className={cn(
                'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-medium transition-colors',
                on ? 'text-primary before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-b-full before:bg-primary' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              <span className="relative">
                <p.icon className="h-4 w-4" />
                {p.useBadge && <PanelBadge useCount={p.useBadge} small />}
              </span>
              <span className="max-w-full truncate">{p.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1">
        {!mobile && (
          <button
            type="button"
            onClick={() => setSidebarPinned(!pinned)}
            title={pinLabel}
            aria-label={pinLabel}
            aria-pressed={pinned}
            className={cn('rounded-md p-1.5 transition-colors hover:bg-hover hover:text-fg', pinned ? 'bg-primary-soft text-primary' : 'text-muted')}
          >
            {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={closeSidePanel}
          title={mobile ? 'Schließen' : 'Einklappen'}
          aria-label={mobile ? 'Schließen' : 'Einklappen'}
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {mobile ? <X className="h-4 w-4" /> : <ChevronsRight className="h-4 w-4" />}
        </button>
      </div>
    </nav>
  );
}

function PanelBadge({ useCount, small }: { useCount: () => number; small?: boolean }) {
  const n = useCount();
  if (!n) return null;
  const label = n > 99 ? '99+' : String(n);
  return (
    <span
      className={cn(
        'absolute inline-flex items-center justify-center rounded-full bg-primary font-semibold tabular-nums text-primary-fg ring-2 ring-sidebar',
        small ? '-right-2.5 -top-1.5 h-3.5 min-w-3.5 px-0.5 text-[9px]' : 'right-0 top-0 h-4 min-w-4 px-1 text-[10px]',
      )}
      aria-label={`${label} ungelesen`}
    >
      {label}
    </span>
  );
}

/** Ziehen am linken Rand ändert die Breite (Doppelklick: Standardbreite) */
function ResizeHandle({ width }: { width: number }) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setSidebarWidth(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + startX - ev.clientX))), false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.removeProperty('cursor');
      persistSidebarWidth();
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
      onDoubleClick={() => setSidebarWidth(null, true)}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/20 active:bg-primary/30"
    />
  );
}
