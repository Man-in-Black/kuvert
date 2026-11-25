import type { Capability } from './common';

/** Beschreibung eines Formularfelds für die dynamische Konto-Einrichtung (z. B. IMAP). */
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'email' | 'password' | 'number' | 'checkbox' | 'select' | 'url' | 'textarea';
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  /** Wird verschlüsselt gespeichert und nie an den Client zurückgegeben */
  secret?: boolean;
  /** Optische Gruppierung im Formular, z. B. "IMAP" / "SMTP" */
  group?: string;
  /** Nur anzeigen, wenn ein anderes Feld einen bestimmten Wert hat */
  showIf?: { key: string; equals: string | number | boolean };
}

/** Ein vom Server angebotener Kontotyp (kommt aus einem Modul). */
export interface AccountTypeInfo {
  type: string;
  label: string;
  description?: string;
  /** Name eines lucide-Icons oder Marken-Kürzel (microsoft, google, …) */
  icon?: string;
  capabilities: Capability[];
  auth: 'oauth' | 'form';
  /** Bei OAuth: ist eine Client-ID/Secret serverseitig konfiguriert? */
  configured: boolean;
  fields?: FieldDef[];
  /** Felder, die nach der Einrichtung in den Kontoeinstellungen bearbeitet werden können */
  settingsFields?: FieldDef[];
}

export interface AccountSettings {
  /** Posteingang dieses Kontos im gemeinsamen Posteingang anzeigen */
  includeInUnifiedInbox: boolean;
  /** Benachrichtigungen für neue Mails */
  notify: boolean;
  /** Microsoft 365: zusätzliche freigegebene Postfächer (SMTP-Adressen) */
  sharedMailboxes?: string[];
  /** Freigegebene Postfächer (Adressen), deren Posteingang ebenfalls im gemeinsamen Posteingang erscheint */
  unifiedSharedMailboxes?: string[];
  /** Modul-spezifische Zusatzeinstellungen */
  [key: string]: unknown;
}

export type AccountStatus = 'ok' | 'error' | 'reauth';

export interface AccountInfo {
  id: string;
  type: string;
  name: string;
  email: string;
  color: string;
  capabilities: Capability[];
  enabled: boolean;
  status: AccountStatus;
  statusMessage?: string | null;
  settings: AccountSettings;
  /** Nicht-geheime Konfiguration (z. B. Hostnamen) zur Anzeige */
  config: Record<string, unknown>;
  sort: number;
}

/** Absender-Identität (eigene Adresse, Alias oder freigegebenes Postfach). */
export interface MailIdentity {
  id: string;
  name?: string;
  address: string;
  /** Postfach, aus dem gesendet wird (MS365 Shared Mailbox) */
  mailboxId?: string;
  shared?: boolean;
}
