/**
 * Integrationen im Frontend:
 *  - Admin-Bereich „mailcow" (Instanzen, Postfächer, Domains, Aliasse, Quarantäne, Provisionierung)
 *  - Admin-Bereich „Mail-Archiver" (Standard-URL, Aktivierung – muss auch bei
 *    deaktiviertem Archiv-Feature erreichbar sein, daher hier)
 *  - Einstellungen „Mein Postfach" (Self-Service für verknüpfte mailcow-Postfächer)
 */
import { lazy, Suspense } from 'react';
import { Archive, Inbox, Server } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { EmptyState, Skeleton } from '@/components/ui';
import { useFeature } from '@/lib/queries';

const MailcowAdminLazy = lazy(() => import('./MailcowAdmin').then((m) => ({ default: m.MailcowAdmin })));
const MyMailboxLazy = lazy(() => import('./MyMailbox').then((m) => ({ default: m.MyMailbox })));
const ArchiveAdminLazy = lazy(() => import('../archive/ArchiveSettings').then((m) => ({ default: m.ArchiveAdminSection })));

const Fallback = () => <Skeleton className="h-40 w-full rounded-2xl" />;

function MailcowAdminSection() {
  const enabled = useFeature('mailcow');
  if (!enabled) return <EmptyState icon={<Server />} title="mailcow-Modul deaktiviert">Das Server-Modul „mailcow“ ist per KUVERT_DISABLED_MODULES abgeschaltet.</EmptyState>;
  return (
    <Suspense fallback={<Fallback />}>
      <MailcowAdminLazy />
    </Suspense>
  );
}

function ArchiveAdminSection() {
  return (
    <Suspense fallback={<Fallback />}>
      <ArchiveAdminLazy />
    </Suspense>
  );
}

function MyMailboxSection() {
  return (
    <Suspense fallback={<Fallback />}>
      <MyMailboxLazy />
    </Suspense>
  );
}

const mod: WebModule = {
  id: 'mailcow',
  /** Für Admins immer; sonst nur, wenn ein mailcow- oder IMAP-Konto existiert (mögliche Verknüpfung) */
  isActive: ({ app, accounts }) =>
    !!app.user?.isAdmin || (!!app.features.mailcow && accounts.some((a) => a.type === 'mailcow' || a.type === 'imap')),
  settings: [{ id: 'mailbox', label: 'Mein Postfach', icon: Inbox, order: 15, component: MyMailboxSection }],
  admin: [
    { id: 'mailcow', label: 'mailcow', icon: Server, order: 60, component: MailcowAdminSection },
    { id: 'mailarchiver', label: 'Mail-Archiver', icon: Archive, order: 61, component: ArchiveAdminSection },
  ],
};

export default mod;
