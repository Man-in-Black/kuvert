/**
 * Mail-Archiv (Mail-Archiver): eigener Bereich „Archiv“ und Benutzer-Einstellungen
 * (persönlicher API-Schlüssel). Die Admin-Einstellungen (Standard-URL, Aktivierung)
 * stellt das mailcow-Modul bereit, da sie auch bei deaktiviertem Feature erreichbar sein müssen.
 * Deep-Link: /archive?q=Suchbegriff
 */
import { lazy, Suspense } from 'react';
import { Archive } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';

const ArchivePageLazy = lazy(() => import('./ArchivePage').then((m) => ({ default: m.ArchivePage })));
const SettingsLazy = lazy(() => import('./ArchiveSettings').then((m) => ({ default: m.ArchiveSettingsSection })));

const Fallback = () => (
  <div className="p-6">
    <Skeleton className="h-40 w-full rounded-2xl" />
  </div>
);

function ArchiveRoute() {
  return (
    <Suspense fallback={<Fallback />}>
      <ArchivePageLazy />
    </Suspense>
  );
}

function ArchiveSettings() {
  return (
    <Suspense fallback={<Fallback />}>
      <SettingsLazy />
    </Suspense>
  );
}

const mod: WebModule = {
  id: 'archive',
  feature: 'mailarchiver',
  nav: [{ path: 'archive', label: 'Archiv', icon: Archive, order: 45 }],
  routes: [{ path: 'archive/*', element: <ArchiveRoute /> }],
  settings: [{ id: 'archive', label: 'Mail-Archiv', icon: Archive, order: 65, component: ArchiveSettings }],
};

export default mod;
