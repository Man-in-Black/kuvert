/**
 * KI-Triage: automatische Priorität und Kategorie für neue Mails.
 * Die Einordnung liegt serverseitig (Tabelle "triage") und wird beim Abruf
 * der Listen an `MessageSummary.triage` gehängt.
 */
import type { UserSettings } from './app';

export type TriagePriority = 'high' | 'normal' | 'low';

export const TRIAGE_PRIORITIES: TriagePriority[] = ['high', 'normal', 'low'];

export const TRIAGE_PRIORITY_LABELS: Record<TriagePriority, string> = {
  high: 'Hoch',
  normal: 'Normal',
  low: 'Niedrig',
};

export interface TriageInfo {
  priority: TriagePriority;
  category: string;
  /** Kurze Begründung des Modells (ein Satz) */
  reason?: string;
  /** ai = vom Sprachmodell, manual = vom Benutzer korrigiert */
  source: 'ai' | 'manual';
  /** Vom Benutzer als erledigt markiert – zählt nicht mehr als „Wichtig“ */
  done?: boolean;
  /** ISO-8601 */
  at: string;
}

/** Benutzereinstellungen (liegen unter `UserSettings.modules.triage`) */
export interface TriageSettings {
  /** Neue Mails im Posteingang automatisch einordnen */
  enabled: boolean;
  /** Eigenes Modell für die Triage (leer = Modell des KI-Assistenten) */
  model?: string | null;
  categories: string[];
  /** Zusätzliche Hinweise für das Modell, z. B. „Mails von @kunde.de sind immer wichtig“ */
  instructions: string;
  /** Konten, deren neue Mails nicht automatisch eingeordnet werden */
  excludedAccounts: string[];
}

/** Fallback-Kategorie, wenn das Modell keine der vorgegebenen wählt */
export const TRIAGE_FALLBACK_CATEGORY = 'Sonstiges';

export const DEFAULT_TRIAGE_CATEGORIES = [
  'Aktion erforderlich',
  'Antwort erwartet',
  'Termin',
  'Rechnung & Finanzen',
  'Info',
  'Benachrichtigung',
  'Newsletter',
  'Werbung',
  'Persönlich',
  TRIAGE_FALLBACK_CATEGORY,
];

export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = {
  enabled: false,
  model: null,
  categories: DEFAULT_TRIAGE_CATEGORIES,
  instructions: '',
  excludedAccounts: [],
};

/** Triage-Einstellungen eines Benutzers inkl. Standardwerten */
export function getTriageSettings(settings: Pick<UserSettings, 'modules'> | undefined | null): TriageSettings {
  const raw = (settings?.modules?.triage ?? {}) as Partial<TriageSettings>;
  const categories = Array.isArray(raw.categories) ? raw.categories.map((c) => String(c).trim()).filter(Boolean) : [];
  return {
    enabled: raw.enabled === true,
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    categories: categories.length ? categories : DEFAULT_TRIAGE_CATEGORIES,
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    excludedAccounts: Array.isArray(raw.excludedAccounts) ? raw.excludedAccounts.map(String) : [],
  };
}

export interface TriageStatus {
  /** KI serverseitig aktiv */
  available: boolean;
  /** "ollama" oder "openai" (OpenAI-kompatibel – kann ein externer Dienst sein) */
  backend: 'ollama' | 'openai';
  /** Wartende und laufende Einordnungen dieses Benutzers */
  queued: number;
  /** KI-Server hatte einen Fehler (z. B. Modell ließ sich nicht laden): nächster Versuch um … (ISO) */
  retryAt?: string | null;
  lastError?: string | null;
  /** Nummer des anstehenden Versuchs und Höchstzahl */
  attempt?: number | null;
  maxAttempts?: number;
  /** Endgültig fehlgeschlagene Einordnungen (Wiederholen in den Einstellungen) */
  failed?: number;
}

/** Eine Mail, deren Einordnung endgültig fehlschlug (kann wiederholt werden) */
export interface TriageFailure {
  accountId: string;
  folderId: string;
  messageId: string;
  subject?: string;
  /** Absender (Name oder Adresse) */
  from?: string;
  error: string;
  /** ISO-8601 */
  failedAt: string;
}

export interface TriageRunResult {
  /** Neu in die Warteschlange gestellt */
  queued: number;
  /** Bereits eingeordnet oder schon in der Warteschlange */
  skipped: number;
}
