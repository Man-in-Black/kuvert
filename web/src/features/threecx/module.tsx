/**
 * 3CX: Bereich „Telefon“ (Wahlfeld, Anrufliste, Telefonbuch, Kollegen), Einstellungen „Telefonie“
 * (Nebenstelle, bevorzugtes Gerät) und Admin-Seite „3CX“.
 * Die Admin-Seite ist auch ohne aktives Feature erreichbar, sonst ließe sich die Anbindung nie einrichten.
 * Click-to-Call selbst steckt in <PhoneLink>, das Kontakte & Co. für Telefonnummern verwenden.
 */
import { lazy, Suspense } from 'react';
import { Phone, PhoneCall } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Skeleton } from '@/components/ui';

const SettingsLazy = lazy(() => import('./ThreeCxSettings').then((m) => ({ default: m.ThreeCxSettingsSection })));
const PhoneLazy = lazy(() => import('./PhonePage').then((m) => ({ default: m.PhonePage })));
const AdminLazy = lazy(() => import('./ThreeCxSettings').then((m) => ({ default: m.ThreeCxAdminSection })));
/** Panel der Seitenleiste rechts (bringt Kopf und eigene Ladeanzeige mit) */
const PhonePanel = lazy(() => import('./PhonePage').then((m) => ({ default: m.PhonePanel })));

const Fallback = () => <Skeleton className="h-40 w-full rounded-2xl" />;

function ThreeCxSettings() {
  return (
    <Suspense fallback={<Fallback />}>
      <SettingsLazy />
    </Suspense>
  );
}

function PhoneRoute() {
  return (
    <Suspense fallback={<Fallback />}>
      <PhoneLazy />
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

/** Bereich „Telefon“ und Panel rechts nur mit aktiver Anbindung */
export const phoneModule: WebModule = {
  id: 'phone',
  feature: 'threecx',
  nav: [{ path: 'phone', label: 'Telefon', icon: Phone, order: 32 }],
  routes: [{ path: 'phone/*', element: <PhoneRoute /> }],
  sidePanels: [
    {
      id: 'phone',
      label: 'Telefon',
      icon: Phone,
      order: 50,
      component: PhonePanel,
      defaultWidth: 360,
      keywords: 'telefon anrufen 3cx wählen anrufliste kollegen',
    },
  ],
};

export default mod;
