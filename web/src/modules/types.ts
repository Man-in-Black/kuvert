/**
 * Frontend-Modul-System. Jedes Feature (Mail, Kalender, KI, S/MIME …) ist ein
 * WebModule und kann Navigation, Routen und Erweiterungen für andere Bereiche
 * beisteuern. Neue Module in `modules/index.ts` eintragen.
 */
import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AppInfo, AccountInfo, TtEntry, TtLink } from '@kuvert/shared';
import type {
  AttachmentExtensionProps,
  ComposerAttachSource,
  ComposerExtensionProps,
  ConversationExtensionProps,
  MessageExtensionProps,
} from '@/features/mail/extension-types';

export interface NavItem {
  /** Pfad ohne führenden Slash, z. B. "mail" */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sortierung in der Navigationsleiste */
  order: number;
  /** React-Hook, der eine Zahl für ein Badge liefert (z. B. ungelesene Chatnachrichten); 0 = kein Badge */
  useBadge?: () => number;
  /**
   * Statusanzeige (z. B. laufender Timer), rendert null, wenn nichts anliegt:
   * 'rail' = unter dem Eintrag in der ausgeklappten Leiste, 'dot' = Markierung am Symbol der
   * eingeklappten Leiste, 'icon' = Markierung am Symbol der mobilen Navigation
   */
  Status?: ComponentType<{ variant: 'rail' | 'dot' | 'icon' }>;
}

/** Globale Aktion ohne eigene Seite (z. B. KI-Chat öffnen): Seitenleiste, Befehlspalette, mobil im „Mehr“-Menü */
export interface ShellAction {
  id: string;
  label: string;
  icon: LucideIcon;
  order: number;
  /** Zusätzliche Suchbegriffe für die Befehlspalette */
  keywords?: string;
  run: () => void;
  /** React-Hook: true, solange die Aktion „an“ ist (z. B. Panel geöffnet) */
  useActive?: () => boolean;
  /** Aus einem SidePanelDef erzeugt – am Desktop steckt sie in der Leiste rechts, nicht links */
  sidePanel?: boolean;
}

/**
 * Panel in der Seitenleiste rechts (wie bei Gmail): eingeklappt ein Symbol in der schmalen
 * Leiste, aufgeklappt ein Reiter unten. Der Inhalt wird erst beim Aufklappen geladen und
 * bringt seinen eigenen Kopf mit; Anpinnen und Einklappen übernimmt die Leiste.
 */
export interface SidePanelDef {
  /** Eindeutig, z. B. "calendar" – öffnen per openSidePanel(id) */
  id: string;
  label: string;
  icon: LucideIcon;
  order: number;
  component: ComponentType;
  /** Name als Aktion (Befehlspalette, mobil „Mehr“); Standard: „<label>-Leiste“ */
  actionLabel?: string;
  /** Zusätzliche Suchbegriffe für die Befehlspalette */
  keywords?: string;
  /** React-Hook für ein Badge am Symbol (z. B. ungelesene Chatnachrichten); 0 = keins */
  useBadge?: () => number;
  /** Markierung am Symbol (z. B. Play-Zeichen bei laufendem Timer); small = Reiter unten im Panel */
  Status?: ComponentType<{ small?: boolean }>;
}

/** Erweiterung an einem Zeiteintrag (z. B. Ticket verknüpfen) */
export interface TimeEntryExtensionProps {
  entry: TtEntry;
  /** Verknüpfung hinzufügen; markDone setzt zusätzlich das erste Status-Schlagwort (z. B. „gebucht“) */
  addLink: (link: TtLink, opts?: { markDone?: boolean }) => Promise<void>;
  /** Name des ersten Status-Schlagworts (z. B. „gebucht“) oder null */
  doneTag: string | null;
  compact?: boolean;
}

export interface RouteDef {
  /** z. B. "mail/*" */
  path: string;
  element: ReactNode;
}

export interface SettingsSection {
  id: string;
  label: string;
  icon?: LucideIcon;
  order: number;
  component: ComponentType;
}

export interface ModuleActivationContext {
  app: AppInfo;
  accounts: AccountInfo[];
}

export interface WebModule {
  id: string;
  /** Nur aktiv, wenn der Server dieses Feature-Flag meldet (AppInfo.features) */
  feature?: string;
  /** Feinere Aktivierungslogik, z. B. "nur wenn ein Konto Meetings kann" */
  isActive?(ctx: ModuleActivationContext): boolean;
  nav?: NavItem[];
  routes?: RouteDef[];
  /** Globale Aktionen (siehe ShellAction) */
  actions?: ShellAction[];
  /** Panels der Seitenleiste rechts (siehe SidePanelDef) */
  sidePanels?: SidePanelDef[];
  /**
   * Eigenständige Fenster ohne Navigationsleiste (z. B. Verfassen im Popup).
   * Pfade liegen unter "window/", z. B. "window/compose".
   */
  windows?: RouteDef[];
  /** Einstellungsseiten (für jeden Benutzer) */
  settings?: SettingsSection[];
  /** Seiten im Admin-Bereich (nur Administratoren), z. B. Integrationen */
  admin?: SettingsSection[];
  /** Buttons in der Werkzeugleiste des Editors (z. B. KI, Teams-Meeting) */
  composerToolbar?: ComponentType<ComposerExtensionProps>[];
  /** Zusätzliche Optionen im Verfassen-Dialog (z. B. S/MIME-Schalter) */
  composerOptions?: ComponentType<ComposerExtensionProps>[];
  /** Weitere Quellen im Menü „Anhängen“ des Editors (z. B. Paperless) */
  composerAttachSources?: ComposerAttachSource[];
  /** Knöpfe an Mail-Anhängen in der Nachrichtenansicht (z. B. „An Paperless senden“) */
  attachmentActions?: ComponentType<AttachmentExtensionProps>[];
  /** Aktionen in der Nachrichtenansicht (z. B. "Zusammenfassen") */
  messageActions?: ComponentType<MessageExtensionProps>[];
  /** Hinweise/Banner über dem Nachrichteninhalt (z. B. S/MIME-Status) */
  messageBanners?: ComponentType<MessageExtensionProps>[];
  /** Aktionen für eine ganze Unterhaltung (z. B. KI-Zusammenfassung des Verlaufs) */
  conversationActions?: ComponentType<ConversationExtensionProps>[];
  /** Knöpfe an jedem Zeiteintrag der Zeiterfassung (z. B. Ticket oder Lead verknüpfen) */
  timeEntryActions?: ComponentType<TimeEntryExtensionProps>[];
  /** Wird einmal nach dem Login gerendert (unsichtbare Dienste, z. B. Benachrichtigungen) */
  services?: ComponentType[];
}
