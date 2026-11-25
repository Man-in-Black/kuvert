import { lazy, Suspense } from 'react';
import { CalendarDays } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';

const CalendarPage = lazy(() => import('./CalendarPage'));

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
};

export default mod;
