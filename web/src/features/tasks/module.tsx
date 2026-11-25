import { lazy, Suspense } from 'react';
import { CheckSquare } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';

const TasksPage = lazy(() => import('./TasksPage'));

const mod: WebModule = {
  id: 'tasks',
  nav: [{ path: 'tasks', label: 'Aufgaben', icon: CheckSquare, order: 40 }],
  routes: [
    {
      path: 'tasks/*',
      element: (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <TasksPage />
        </Suspense>
      ),
    },
  ],
};

export default mod;
