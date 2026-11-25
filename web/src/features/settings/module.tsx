import { CalendarClock, Info, Plane, Plug, Settings, SlidersHorizontal, FileSignature, FileText } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { SettingsPage } from './SettingsPage';
import { AccountsSection } from './accounts/AccountsSection';
import { GeneralSection } from './sections/GeneralSection';
import { SignaturesSection } from './sections/SignaturesSection';
import { TemplatesSection } from './sections/TemplatesSection';
import { OutOfOfficeSection } from './sections/OutOfOfficeSection';
import { ScheduledSection } from './sections/ScheduledSection';
import { InfoSection } from './sections/InfoSection';

/**
 * Einstellungen. Weitere Module steuern eigene Abschnitte über `settings` bei
 * (z. B. Profil/Sicherheit, S/MIME, Benachrichtigungen, KI) – sie erscheinen automatisch hier.
 * Benutzerverwaltung liegt im Admin-Bereich (features/admin).
 */
const mod: WebModule = {
  id: 'settings',
  nav: [{ path: 'settings', label: 'Einstellungen', icon: Settings, order: 100 }],
  routes: [{ path: 'settings/*', element: <SettingsPage /> }],
  settings: [
    { id: 'accounts', label: 'Konten', icon: Plug, order: 10, component: AccountsSection },
    { id: 'general', label: 'Allgemein', icon: SlidersHorizontal, order: 20, component: GeneralSection },
    { id: 'signatures', label: 'Signaturen', icon: FileSignature, order: 30, component: SignaturesSection },
    { id: 'templates', label: 'Vorlagen', icon: FileText, order: 40, component: TemplatesSection },
    { id: 'out-of-office', label: 'Abwesenheit', icon: Plane, order: 50, component: OutOfOfficeSection },
    { id: 'scheduled', label: 'Geplanter Versand', icon: CalendarClock, order: 60, component: ScheduledSection },
    { id: 'info', label: 'Info', icon: Info, order: 99, component: InfoSection },
  ],
};

export default mod;
