/**
 * Anrufe im Team-Chat (Server-Modul "meet", LiveKit): Dienst für Klingeln und Anruf-Fenster,
 * Seite für Einladungslinks sowie Admin-Seite „Anrufe“. Die Knöpfe zum Anrufen stecken im Chat (ConversationView).
 * Die Admin-Seite ist auch ohne aktives Feature erreichbar, sonst ließe sich die Anbindung nie einrichten.
 */
import { lazy, Suspense } from 'react';
import { Video, Zap } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';
import { CallHost } from './CallHost';
import { startAdhocMeeting } from './store';

const AdminLazy = lazy(() => import('./MeetAdmin').then((m) => ({ default: m.MeetAdminSection })));
const JoinLazy = lazy(() => import('./JoinPages').then((m) => ({ default: m.MemberJoinPage })));

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

/** Klingeln, Anruf-Fenster und Einladungslinks (/join/<token>) nur bei eingerichteter Anbindung */
const mod: WebModule = {
  id: 'meet',
  feature: 'meet',
  services: [CallHost],
  // Spontanmeeting ohne Termin: Seitenleiste, Befehlspalette, mobil im „Mehr“-Menü
  actions: [
    {
      id: 'meet-adhoc',
      label: 'Spontanmeeting',
      icon: Zap,
      order: 40,
      keywords: 'meeting anruf video konferenz besprechung call jetzt gast link',
      run: () => void startAdhocMeeting({ video: true }),
    },
  ],
  routes: [
    {
      path: 'join/:token',
      element: (
        <Suspense fallback={<Skeleton className="m-6 h-40 w-full max-w-md rounded-2xl" />}>
          <JoinLazy />
        </Suspense>
      ),
    },
  ],
};

export default mod;
