/**
 * 3CX: Einstellungen „Telefonie“ (Nebenstelle, bevorzugtes Gerät) und Admin-Seite „3CX“.
 * Die Admin-Seite ist auch ohne aktives Feature erreichbar, sonst ließe sich die Anbindung nie einrichten.
 * Click-to-Call selbst steckt in <PhoneLink>, das Kontakte & Co. für Telefonnummern verwenden.
 */
import { lazy, Suspense } from 'react';
import { PhoneCall } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';

const SettingsLazy = lazy(() => import('./ThreeCxSettings').then((m) => ({ default: m.ThreeCxSettingsSection })));
const AdminLazy = lazy(() => import('./ThreeCxSettings').then((m) => ({ default: m.ThreeCxAdminSection })));

const Fallback = () => <Skeleton className="h-40 w-full rounded-2xl" />;

function ThreeCxSettings() {
  return (
    <Suspense fallback={<Fallback />}>
      <SettingsLazy />
    </Suspense>
  );
}

function ThreeCxAdmin() {
  return (
    <Suspense fallback={<Fallback />}>
      <AdminLazy />
    </Suspense>
  );
}

const mod: WebModule = {
  id: 'threecx',
  isActive: ({ app }) => !!app.user?.isAdmin || !!app.features.threecx,
  settings: [{ id: 'telephony', label: 'Telefonie', icon: PhoneCall, order: 69, component: ThreeCxSettings }],
  admin: [{ id: 'threecx', label: '3CX', icon: PhoneCall, order: 64, component: ThreeCxAdmin }],
};

export default mod;
