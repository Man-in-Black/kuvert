/**
 * Statusanzeigen für laufende Timer:
 *  - links unter „Zeiterfassung“ die laufenden Timer mit Projekt und Zeit (Klick öffnet die Seite),
 *    in der eingeklappten bzw. mobilen Navigation ein grüner Play-Punkt am Symbol,
 *  - rechts am Uhr-Symbol der Seitenleiste dieselbe Play-Markierung.
 */
import { NavLink } from 'react-router-dom';
import { Play } from 'lucide-react';
import type { TtEntry } from '@kuvert/shared';
import { cn } from '@/lib/utils';
import { formatClock, useActiveEntries, useNow } from './api';

const MAX_SHOWN = 3;

function useRunning(): TtEntry[] {
  const { data } = useActiveEntries();
  return data ?? [];
}

function PlayDot({ className, title }: { className?: string; title: string }) {
  return (
    <span
      className={cn('pointer-events-none absolute inline-flex items-center justify-center rounded-full bg-success text-white ring-2 ring-sidebar', className)}
      title={title}
      aria-label={title}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />
      <Play className="relative h-[55%] w-[55%] translate-x-[5%] fill-current" strokeWidth={0} />
    </span>
  );
}

const runningTitle = (list: TtEntry[]) => (list.length === 1 ? `Timer läuft: ${list[0]!.customerName || list[0]!.projectName}` : `${list.length} Timer laufen`);

/** Navigation links (NavItem.Status) */
export function TimerNavStatus({ variant }: { variant: 'rail' | 'dot' | 'icon' }) {
  const list = useRunning();
  if (!list.length) return null;
  if (variant === 'dot') return <PlayDot className="right-1 top-0.5 h-3.5 w-3.5" title={runningTitle(list)} />;
  if (variant === 'icon') return <PlayDot className="-right-2 -top-1.5 h-4 w-4" title={runningTitle(list)} />;
  return <RunningList list={list} />;
}

function RunningList({ list }: { list: TtEntry[] }) {
  const now = useNow(true);
  return (
    <NavLink to="/time" className="-mt-0.5 mb-1 block space-y-0.5 rounded-lg py-1 pl-[2.375rem] pr-2.5 hover:bg-hover" title="Zur Zeiterfassung">
      {list.slice(0, MAX_SHOWN).map((e) => (
        <div key={e.id} className="flex items-center gap-1.5 text-xs">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          <span className="min-w-0 flex-1 truncate text-fg/80" title={[e.customerName, e.projectName, e.activityName, e.description].filter(Boolean).join(' › ')}>
            {e.customerName || e.projectName}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-success">{formatClock(Math.max(0, (now - Date.parse(e.begin)) / 1000))}</span>
        </div>
      ))}
      {list.length > MAX_SHOWN && <div className="text-[11px] text-muted">+ {list.length - MAX_SHOWN} weitere</div>}
    </NavLink>
  );
}

/** Symbol der Seitenleiste rechts (SidePanelDef.Status) */
export function TimerPanelStatus({ small }: { small?: boolean }) {
  const list = useRunning();
  if (!list.length) return null;
  return <PlayDot className={small ? '-bottom-1 -right-2 h-3 w-3' : 'bottom-0.5 right-0.5 h-3.5 w-3.5'} title={runningTitle(list)} />;
}
