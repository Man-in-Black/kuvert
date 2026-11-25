import { lazy, Suspense } from 'react';
import { Mail } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';
import { ComposerHost } from './compose/ComposerHost';

const MailPage = lazy(() => import('./MailPage').then((m) => ({ default: m.MailPage })));
const ComposeWindowPage = lazy(() => import('./compose/ComposeWindow').then((m) => ({ default: m.ComposeWindowPage })));
const MessageWindowPage = lazy(() => import('./MessageWindow').then((m) => ({ default: m.MessageWindowPage })));

const fallback = (
  <div className="flex h-full items-center justify-center">
    <Spinner />
  </div>
);

/**
 * Mail-Modul: Posteingang, Ordner, Lesen, Verfassen.
 * Der ComposerHost läuft als Dienst, damit openCompose() aus allen Bereichen funktioniert.
 * Verfassen und Lesen im eigenen Browserfenster laufen als eigenständige Fenster (window/compose, window/mail).
 */
const mod: WebModule = {
  id: 'mail',
  nav: [{ path: 'mail', label: 'Mail', icon: Mail, order: 10 }],
  routes: [
    {
      path: 'mail/*',
      element: (
        <Suspense fallback={fallback}>
          <MailPage />
        </Suspense>
      ),
    },
  ],
  windows: [
    {
      path: 'window/compose',
      element: (
        <Suspense fallback={fallback}>
          <ComposeWindowPage />
        </Suspense>
      ),
    },
    {
      path: 'window/mail',
      element: (
        <Suspense fallback={fallback}>
          <MessageWindowPage />
        </Suspense>
      ),
    },
  ],
  services: [ComposerHost],
};

export default mod;
