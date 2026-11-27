/**
 * Anrufe im Team-Chat (Server-Modul "meet", LiveKit): Dienst für Klingeln und Anruf-Fenster sowie
 * Admin-Seite „Anrufe“. Die Knöpfe zum Anrufen stecken im Chat (ConversationView).
 * Die Admin-Seite ist auch ohne aktives Feature erreichbar, sonst ließe sich die Anbindung nie einrichten.
 */
import { lazy, Suspense } from 'react';
import { Video } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';
import { CallHost } from './CallHost';

const AdminLazy = lazy(() => import('./MeetAdmin').then((m) => ({ default: m.MeetAdminSection })));

function MeetAdmin() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
      <AdminLazy />
    </Suspense>
  );
}

/** Admin-Seite, sobald das Server-Modul geladen ist */
export const meetAdminModule: WebModule = {
  id: 'meet-admin',
  isActive: ({ app }) => !!app.user?.isAdmin && app.modules.some((m) => m.id === 'meet'),
  admin: [{ id: 'meet', label: 'Anrufe', icon: Video, order: 63, component: MeetAdmin }],
};

/** Klingeln und Anruf-Fenster nur bei eingerichteter Anbindung */
const mod: WebModule = {
  id: 'meet',
  feature: 'meet',
  services: [CallHost],
};

export default mod;
