/**
 * Paperless-ngx: eigener Bereich „Paperless“ (Dokumente durchsuchen, ansehen, per Mail senden),
 * Dokumente im Editor anhängen oder verlinken („Anhängen → Aus Paperless …“),
 * Mail-Anhänge an Paperless übergeben (Blatt-Symbol am Anhang) und Benutzer-Einstellungen
 * (persönlicher API-Token). Die Admin-Einstellungen (Standard-URL, Aktivierung) stecken in einem
 * eigenen Modul, da sie auch bei deaktiviertem Feature erreichbar sein müssen.
 */
import { lazy, Suspense } from 'react';
import { Leaf } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';
import type { AttachSourceDialogProps } from '@/features/mail/extension-types';
import { SaveToPaperlessAction } from './SaveToPaperless';

const PageLazy = lazy(() => import('./PaperlessPage').then((m) => ({ default: m.PaperlessPage })));
const SettingsLazy = lazy(() => import('./PaperlessSettings').then((m) => ({ default: m.PaperlessSettingsSection })));
const AdminLazy = lazy(() => import('./PaperlessSettings').then((m) => ({ default: m.PaperlessAdminSection })));
const PickerLazy = lazy(() => import('./PaperlessPicker').then((m) => ({ default: m.PaperlessPicker })));

const Fallback = () => <Skeleton className="h-40 w-full rounded-2xl" />;

function PaperlessRoute() {
  return (
    <Suspense fallback={<div className="p-6"><Fallback /></div>}>
      <PageLazy />
    </Suspense>
  );
}

function PaperlessSettings() {
  return (
    <Suspense fallback={<Fallback />}>
      <SettingsLazy />
    </Suspense>
  );
}

function PaperlessAdmin() {
  return (
    <Suspense fallback={<Fallback />}>
      <AdminLazy />
    </Suspense>
  );
}

/** Dialog erst beim Öffnen nachladen */
function PaperlessPickerDialog(props: AttachSourceDialogProps) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <PickerLazy {...props} />
    </Suspense>
  );
}

export const paperlessAdminModule: WebModule = {
  id: 'paperless-admin',
  isActive: ({ app }) => !!app.user?.isAdmin && app.modules.some((m) => m.id === 'paperless'),
  admin: [{ id: 'paperless', label: 'Paperless', icon: Leaf, order: 64, component: PaperlessAdmin }],
};

const mod: WebModule = {
  id: 'paperless',
  feature: 'paperless',
  nav: [{ path: 'paperless', label: 'Paperless', icon: Leaf, order: 46 }],
  routes: [{ path: 'paperless/*', element: <PaperlessRoute /> }],
  settings: [{ id: 'paperless', label: 'Paperless', icon: Leaf, order: 66, component: PaperlessSettings }],
  composerAttachSources: [{ id: 'paperless', label: 'Aus Paperless …', icon: <Leaf />, dialog: PaperlessPickerDialog }],
  attachmentActions: [SaveToPaperlessAction],
};

export default mod;
