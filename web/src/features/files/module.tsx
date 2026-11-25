import { lazy, Suspense } from 'react';
import { Cloud } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';

const FilesPage = lazy(() => import('./FilesPage'));

const mod: WebModule = {
  id: 'files',
  /** Nur anzeigen, wenn mindestens ein Konto Cloud-Speicher anbietet */
  isActive: ({ accounts }) => accounts.some((a) => a.enabled && a.capabilities.includes('storage')),
  nav: [{ path: 'files', label: 'Dateien', icon: Cloud, order: 50 }],
  routes: [
    {
      path: 'files/*',
      element: (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <FilesPage />
        </Suspense>
      ),
    },
  ],
};

export default mod;
