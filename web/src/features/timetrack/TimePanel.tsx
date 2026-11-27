/**
 * Zeiterfassung als Panel der Seitenleiste rechts: Timer (laufend oder Startformular),
 * zuletzt verwendete Kombinationen zum schnellen Neustart und die Einträge von heute.
 */
import { useNavigate } from 'react-router-dom';
import { startOfDay, addDays } from 'date-fns';
import { Maximize2, Plus, Timer } from 'lucide-react';
import { useState } from 'react';
import { Button, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { useIsMobile } from '@/lib/useIsMobile';
import { closeSidePanel, isSidebarPinned } from '@/layout/side-panel-store';
import { formatDuration, useActiveEntry, useElapsed, useEntries, useMasterData } from './api';
import { EntryDays, EntryEditor, RecentList, TimerCard } from './components';

export function TimePanel() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [adding, setAdding] = useState(false);
  const { data: master, isLoading } = useMasterData();
  const today = startOfDay(new Date());
  const { data: todays } = useEntries({ from: today.toISOString(), to: addDays(today, 1).toISOString() });
  const { data: active } = useActiveEntry();
  const elapsed = useElapsed(active);
  const runningToday = todays?.items.find((e) => !e.end);
  const total = (todays?.total ?? 0) - (runningToday?.duration ?? 0) + (runningToday ? elapsed : 0);

  const open = (path: string) => {
    navigate(path);
    if (mobile || !isSidebarPinned()) closeSidePanel();
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Timer className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">Zeiterfassung</div>
          <div className="truncate text-xs tabular-nums text-muted">Heute {formatDuration(total)} h</div>
        </div>
        <IconButton label="Zeit nachtragen" size="icon-sm" onClick={() => setAdding(true)} disabled={!master?.projects.length}>
          <Plus className="h-4 w-4" />
        </IconButton>
        <IconButton label="In der Zeiterfassung öffnen" size="icon-sm" onClick={() => open('/time')}>
          <Maximize2 className="h-4 w-4" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-3">
            <Skeleton className="h-32 w-full rounded-2xl" />
          </div>
        ) : !master?.projects.length ? (
          <EmptyState icon={<Timer />} title="Noch keine Projekte">
            <p>Lege Kunden und Projekte an oder importiere sie aus Kimai.</p>
            <Button size="sm" className="mt-3" onClick={() => open('/time?tab=masterdata')}>
              Einrichten
            </Button>
          </EmptyState>
        ) : (
          <div className="space-y-4 p-3">
            <TimerCard compact />
            <section>
              <h3 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted">Zuletzt</h3>
              <RecentList limit={5} />
            </section>
            <section>
              <EntryDays entries={todays?.items ?? []} compact empty={<p className="px-1 py-2 text-xs text-muted">Heute noch keine Einträge.</p>} />
            </section>
          </div>
        )}
      </div>
      {adding && <EntryEditor entry={null} onClose={() => setAdding(false)} />}
    </>
  );
}
