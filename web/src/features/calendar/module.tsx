import { lazy, Suspense } from 'react';
import { CalendarDays, PanelRight } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';
import { toggleCalendarPanel, useCalendarPanelOpen } from './panel-store';

const CalendarPage = lazy(() => import('./CalendarPage'));
const CalendarPanel = lazy(() => import('./CalendarPanel'));

/** Kalender als Seitenleiste (nur geladen, solange sie offen ist) */
function CalendarPanelService() {
  const open = useCalendarPanelOpen();
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CalendarPanel />
    </Suspense>
  );
}

const mod: WebModule = {
  id: 'calendar',
  nav: [{ path: 'calendar', label: 'Kalender', icon: CalendarDays, order: 20 }],
  routes: [
    {
      path: 'calendar/*',
      element: (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <CalendarPage />
        </Suspense>
      ),
    },
  ],
  actions: [
    {
      id: 'calendar-panel',
      label: 'Kalender-Leiste',
      icon: PanelRight,
      order: 20,
      keywords: 'kalender termine seitenleiste sidebar agenda heute',
      run: toggleCalendarPanel,
      useActive: useCalendarPanelOpen,
    },
  ],
  services: [CalendarPanelService],
};

export default mod;
