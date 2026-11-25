import { Tags } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { TriageBanner, TriageConversationMenu, TriageMenu } from './TriageMenu';
import { TriageService } from './TriageService';
import { TriageSettings } from './TriageSettings';

/**
 * KI-Triage: Priorität/Kategorie für neue Mails. Badge und Filter „Wichtig“ stecken
 * im Mail-Bereich (Daten aus `MessageSummary.triage`), hier liegen Einstellungen,
 * Korrektur in der Leseansicht und die Live-Aktualisierung.
 */
const mod: WebModule = {
  id: 'triage',
  feature: 'triage',
  messageActions: [TriageMenu],
  messageBanners: [TriageBanner],
  conversationActions: [TriageConversationMenu],
  services: [TriageService],
  settings: [{ id: 'triage', label: 'KI-Triage', icon: Tags, order: 71, component: TriageSettings }],
};

export default mod;
