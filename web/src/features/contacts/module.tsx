import { lazy, Suspense } from 'react';
import { Users } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';

const ContactsPage = lazy(() => import('./ContactsPage'));

const mod: WebModule = {
  id: 'contacts',
  nav: [{ path: 'contacts', label: 'Kontakte', icon: Users, order: 30 }],
  routes: [
    {
      path: 'contacts/*',
      element: (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <ContactsPage />
        </Suspense>
      ),
    },
  ],
};

export default mod;
