/**
 * Zeiterfassung: Bereich links („Zeiterfassung“), Panel in der Seitenleiste rechts,
 * Einstellungsseite mit Kimai-Import und Abgleich über Server-Ereignisse.
 */
import { lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';
import { useServerEvent } from '@/lib/events';
import { TimerNavStatus, TimerPanelStatus } from './status';

const PageLazy = lazy(() => import('./TimePage').then((m) => ({ default: m.TimePage })));
const PanelLazy = lazy(() => import('./TimePanel').then((m) => ({ default: m.TimePanel })));
const SettingsLazy = lazy(() => import('./KimaiImport').then((m) => ({ default: m.TimetrackSettingsSection })));

const Fallback = () => <Skeleton className="m-4 h-40 rounded-2xl" />;

function TimeRoute() {
  return (
    <Suspense fallback={<Fallback />}>
      <PageLazy />
    </Suspense>
  );
}

function TimetrackSettings() {
  return (
    <Suspense fallback={<Fallback />}>
      <SettingsLazy />
    </Suspense>
  );
}

/** Andere Fenster/Geräte: Timer, Einträge und Stammdaten aktuell halten */
function TimetrackSync() {
  const qc = useQueryClient();
  useServerEvent('timetrack.changed', (e) => {
    if (e.scope === 'masterdata') void qc.invalidateQueries({ queryKey: ['timetrack', 'master'] });
    else if (e.scope === 'import') void qc.invalidateQueries({ queryKey: ['timetrack', 'kimai'] });
    else void qc.invalidateQueries({ queryKey: ['timetrack'], predicate: (q) => q.queryKey[1] !== 'master' && q.queryKey[1] !== 'kimai' });
  });
  return null;
}

const mod: WebModule = {
  id: 'timetrack',
  feature: 'timetrack',
  nav: [{ path: 'time', label: 'Zeiterfassung', icon: Timer, order: 42, Status: TimerNavStatus }],
  routes: [{ path: 'time/*', element: <TimeRoute /> }],
  sidePanels: [
    {
      id: 'timetrack',
      label: 'Zeit',
      actionLabel: 'Zeiterfassung-Leiste',
      icon: Timer,
      order: 45,
      component: PanelLazy,
      Status: TimerPanelStatus,
      keywords: 'zeiterfassung timer stoppuhr kimai stunden arbeitszeit projekt',
    },
  ],
  settings: [{ id: 'timetrack', label: 'Zeiterfassung', icon: Timer, order: 70, component: TimetrackSettings }],
  services: [TimetrackSync],
};

export default mod;
