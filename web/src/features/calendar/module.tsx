import { lazy, Suspense } from 'react';
import { CalendarDays } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';

const CalendarPage = lazy(() => import('./CalendarPage'));
/** Panel der Seitenleiste rechts (erst beim Aufklappen geladen) */
const CalendarPanel = lazy(() => import('./CalendarPanel'));

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
  sidePanels: [
    {
      id: 'calendar',
      label: 'Kalender',
      icon: CalendarDays,
      order: 10,
      component: CalendarPanel,
      keywords: 'kalender termine agenda heute',
    },
  ],
};

export default mod;
