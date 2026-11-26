/**
 * Modul-System. Ein Modul kann
 *  - Kontotypen bereitstellen (accountTypes → Provider für Mail/Kalender/…),
 *  - eigene API-Routen unter /api/<modul-id>/… registrieren,
 *  - Hooks in den Kern einhängen (Nachrichtenansicht, Versand, neue Mails …),
 *  - Hintergrundjobs starten und eigene DB-Migrationen mitbringen.
 *
 * Neue Module werden in `src/modules/index.ts` eingetragen.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AccountSettings,
  AccountStatus,
  Capability,
  FieldDef,
} from '@kuvert/shared';
import type { AppConfig } from '../config.js';
import type { DB, kv as KvStore } from './db.js';
import type { ProviderSet } from './providers.js';
import type { EventBus } from './events.js';
import type { Hooks } from './hooks.js';
import type { AccountService } from './accounts.js';
import type { MailService } from './mail-service.js';
import type { Registry } from './registry.js';

/** Konto aus der Datenbank, Secrets bereits entschlüsselt. */
export interface AccountRecord {
  id: string;
  userId: string;
  type: string;
  name: string;
  email: string;
  color: string;
  config: Record<string, any>;
  settings: AccountSettings;
  secrets: Record<string, any>;
  enabled: boolean;
  status: AccountStatus;
  statusMessage?: string | null;
  sort: number;
}

/** Wird an Provider übergeben – Zugriff auf Konto-Daten und Persistenz. */
export interface AccountContext {
  /** Immer aktueller Stand des Kontos */
  readonly account: AccountRecord;
  /** Secrets zusammenführen und verschlüsselt speichern (z. B. erneuerte Tokens) */
  setSecrets(patch: Record<string, unknown>): void;
  /** Nicht-geheime Konfiguration zusammenführen und speichern */
  setConfig(patch: Record<string, unknown>): void;
  setStatus(status: AccountStatus, message?: string | null): void;
  log: FastifyBaseLogger;
}

/** Ergebnis einer Konto-Einrichtung (OAuth-Callback oder Formular). */
export interface AccountSetupResult {
  email: string;
  name: string;
  config?: Record<string, unknown>;
  secrets: Record<string, unknown>;
  settings?: Partial<AccountSettings>;
  /** Vorschlag für die Kontofarbe */
  color?: string;
}

export interface OAuthHandler {
  /** features: zusätzliche Funktionen, für die weitere Berechtigungen nötig sind (z. B. "chat" für Teams) */
  getAuthorizeUrl(p: { state: string; redirectUri: string; codeChallenge: string; loginHint?: string; features?: string[] }): string;
  handleCallback(p: { code: string; redirectUri: string; codeVerifier: string; features?: string[] }): Promise<AccountSetupResult>;
  /** Administratorzustimmung für eine ganze (fremde) Organisation, z. B. Microsoft Entra ID */
  adminConsent?: {
    /** Möglich? (z. B. nicht, wenn die App nur für die eigene Organisation eingerichtet ist) */
    available(): boolean;
    /** Zustimmungs-URL; tenant = Mandanten-ID/Domain oder leer für "Organisation des Admins" */
    url(p: { tenant?: string; redirectUri: string; state?: string }): string;
    /** Bedeutet die Fehlermeldung "Organisation hat (noch) nicht zugestimmt"? Liefert den Mandanten. */
    tenantFromError(message: string): string | null;
  };
}

export interface AccountTypeDefinition {
  type: string;
  label: string;
  description?: string;
  icon?: string;
  capabilities: Capability[];
  auth: 'oauth' | 'form';
  /** Felder für die Einrichtung per Formular */
  fields?: FieldDef[];
  /** Zusätzliche, später änderbare Einstellungen (landen in account.settings) */
  settingsFields?: FieldDef[];
  /** Ist der Typ nutzbar (z. B. OAuth-Client konfiguriert)? Standard: true */
  isConfigured?(): boolean;
  oauth?: OAuthHandler;
  /** Formular-Einrichtung: Werte prüfen, Verbindung testen, Config/Secrets trennen */
  setup?(values: Record<string, unknown>): Promise<AccountSetupResult>;
  /** Tatsächliche Fähigkeiten eines Kontos (falls abhängig von der Konfiguration) */
  getCapabilities?(account: AccountRecord): Capability[];
  createProviders(ctx: AccountContext): ProviderSet;
}

export interface ModuleContext {
  config: AppConfig;
  db: DB;
  kv: typeof KvStore;
  log: FastifyBaseLogger;
  bus: EventBus;
  hooks: Hooks;
  accounts: AccountService;
  mail: MailService;
  registry: Registry;
}

export interface ServerModule {
  id: string;
  name: string;
  description?: string;
  /** Feature-Flags fürs Frontend (z. B. "ai", "smime", "push") */
  features?: string[];
  /** Ob das Modul aktiv ist (z. B. abhängig von Umgebungsvariablen). Standard: true */
  isEnabled?(): boolean;
  migrations?: { id: string; sql: string }[];
  accountTypes?: AccountTypeDefinition[];
  /** Routen werden unter /api/<id>/… registriert, Login ist automatisch erforderlich */
  routes?(app: FastifyInstance, ctx: ModuleContext): void | Promise<void>;
  /** Nach dem Laden aller Module (Hooks, Hintergrundjobs) */
  init?(ctx: ModuleContext): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export function defineModule(m: ServerModule): ServerModule {
  return m;
}
