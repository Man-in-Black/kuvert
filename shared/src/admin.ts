/** Typen für Benutzerverwaltung, Profile, 2FA, API-Tokens, Webhooks und Admin-Bereich. */
import type { ModuleInfo, ServerEvent, User } from './app';

/* ───────────────────────────── Login ───────────────────────────── */

export type LoginResult = { user: User; twoFactorRequired?: false } | { twoFactorRequired: true; ticket: string };

/* ───────────────────────────── Profil ───────────────────────────── */

export interface UserProfile {
  jobTitle?: string;
  department?: string;
  company?: string;
  phone?: string;
  mobile?: string;
  timezone?: string;
  locale?: string;
  bio?: string;
}

export interface ProfileInfo {
  user: User;
  profile: UserProfile;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface SessionInfo {
  /** Öffentliche ID (Hash), nicht das Sitzungsgeheimnis */
  id: string;
  userAgent?: string | null;
  ip?: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
  expiresAt: string;
  current: boolean;
  twoFactor: boolean;
}

/* ───────────────────────────── 2FA ───────────────────────────── */

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** Durch Richtlinie vorgeschrieben */
  required: boolean;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  /** QR-Code als SVG-Markup */
  qrSvg: string;
}

/* ───────────────────────────── API & Webhooks ───────────────────────────── */

export type ApiScope = 'read' | 'write' | 'admin';

export interface ApiTokenInfo {
  id: string;
  name: string;
  /** Erkennbarer Anfang des Tokens, z. B. "kvt_ab12cd34" */
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

export interface ApiTokenCreated {
  /** Nur einmalig sichtbar */
  token: string;
  info: ApiTokenInfo;
}

/** Ereignisse, die per Webhook abonniert werden können (Chat: nur neue Nachrichten, kein Tippen/Lesestatus) */
export type WebhookEvent = Exclude<
  ServerEvent['type'],
  | 'hello'
  | 'ping'
  | 'chat.message.updated'
  | 'chat.conversation'
  | 'chat.read'
  | 'chat.typing'
  | 'chat.presence'
  | 'chat.connection'
  | 'chat.categories'
  | 'chat.call'
  | 'threecx.call'
  | 'timetrack.changed'
>;

export const WEBHOOK_EVENTS: WebhookEvent[] = ['mail.new', 'mail.changed', 'mail.triage', 'calendar.reminder', 'calendar.changed', 'account.status', 'send.status', 'chat.message'];

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastDeliveryAt?: string | null;
  lastStatus?: number | null;
  lastError?: string | null;
}

export interface WebhookCreated {
  webhook: Webhook;
  /** Signatur-Geheimnis (HMAC-SHA256, Header X-Kuvert-Signature) – nur einmalig sichtbar */
  secret: string;
}

/* ───────────────────────────── Admin ───────────────────────────── */

export interface AdminUser extends User {
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
  accountCount: number;
  sessionCount: number;
  profile: UserProfile;
}

export interface SystemPolicies {
  allowRegistration: boolean;
  /** Zwei-Faktor-Authentifizierung für alle Benutzer verpflichtend */
  require2fa: boolean;
  /** Gültigkeit einer Sitzung in Tagen */
  sessionDays: number;
  /** Erlaubte Kontotypen (leer = alle) */
  allowedAccountTypes: string[];
  /** Maximale Anzahl Konten pro Benutzer (0 = unbegrenzt) */
  maxAccountsPerUser: number;
  usersCanCreateApiTokens: boolean;
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  action: string;
  actorId?: string | null;
  actorEmail?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AdminOverview {
  version: string;
  uptimeSec: number;
  nodeVersion: string;
  users: { total: number; admins: number; disabled: number; with2fa: number };
  sessionsActive: number;
  accounts: { total: number; byType: Record<string, number>; withErrors: number };
  scheduledPending: number;
  apiTokens: number;
  dbSizeBytes: number;
  uploadsSizeBytes: number;
  modules: ModuleInfo[];
  features: Record<string, boolean>;
  recentAudit: AuditEntry[];
}

/* ───────────────────────────── Module ein-/ausschalten ───────────────────────────── */

/**
 * Soll-Zustand eines Moduls (gilt ab dem nächsten Start):
 * active = an · disabled = im Admin-Bereich abgeschaltet ·
 * env = per KUVERT_MODULES/KUVERT_DISABLED_MODULES abgeschaltet (nicht schaltbar) ·
 * unavailable = technisch nicht nutzbar (z. B. S/MIME ohne openssl)
 */
export type AdminModuleStatus = 'active' | 'disabled' | 'env' | 'unavailable';

export interface AdminModuleState {
  id: string;
  name: string;
  description?: string;
  status: AdminModuleStatus;
  /** Läuft gerade (beim letzten Start geladen) */
  loaded: boolean;
  /** Soll-Zustand weicht vom laufenden ab → wirkt nach dem Neustart */
  pending: boolean;
  /** Im Admin-Bereich schaltbar */
  toggleable: boolean;
  /** Kontotypen, die das Modul bereitstellt */
  accountTypes: string[];
  /** Verbundene Konten dieser Typen (Warnung beim Abschalten) */
  accounts: number;
}

export interface AdminModulesView {
  modules: AdminModuleState[];
  /** Neustart aus der Oberfläche möglich (Container mit Restart-Richtlinie) */
  restartable: boolean;
  /** Mindestens eine Änderung wartet auf einen Neustart */
  pending: boolean;
}

/* ───────────────────────────── Dienste (OAuth-Apps, KI) ───────────────────────────── */

export type ServiceKey = 'microsoft' | 'google' | 'ai' | 'search';

/** Herkunft eines Werts: im Admin-Bereich gesetzt, aus der .env oder Standardwert */
export type SettingSource = 'admin' | 'env' | 'default';

export interface ServiceFieldState {
  /** Aktueller Wert (bei Geheimnissen nie enthalten) */
  value?: string | number | boolean | null;
  secret: boolean;
  /** Ist ein (geheimer) Wert hinterlegt? */
  isSet: boolean;
  source: SettingSource;
  /** Name(n) der zugehörigen Umgebungsvariable */
  envVar: string;
  /** Wert aus der .env (nur bei nicht-geheimen Feldern) */
  envValue?: string | number | boolean | null;
  envSet: boolean;
}

export interface ServiceSettingsView {
  microsoft: Record<'clientId' | 'clientSecret' | 'tenant', ServiceFieldState>;
  google: Record<'clientId' | 'clientSecret' | 'placesApiKey', ServiceFieldState>;
  ai: Record<'enabled' | 'backend' | 'baseUrl' | 'model' | 'apiKey' | 'temperature', ServiceFieldState>;
  search: Record<'enabled' | 'url' | 'apiKey' | 'indexBodies' | 'maxAgeDays' | 'includeTrash' | 'syncIntervalMin', ServiceFieldState>;
  publicUrl: string;
  redirectUri: string;
}

/**
 * Änderungen: Wert setzen; `null` = Überschreibung entfernen (wieder .env/Standard);
 * leerer String bei Geheimnissen = unverändert lassen.
 */
export type ServiceSettingsPatch = { [K in ServiceKey]?: Record<string, string | number | boolean | null | undefined> };

/* ───────────────────────────── Microsoft 365: automatische App-Einrichtung ───────────────────────────── */

/** tenant = nur die eigene Organisation, multi = alle Organisationen + private Microsoft-Konten */
/**
 * Wer sich anmelden darf: tenant = nur die eigene Organisation, orgs = mehrere Organisationen
 * (ohne private Konten, ggf. auf die im Entra-Portal erlaubten Mandanten beschränkt),
 * multi = alle Microsoft-Konten inkl. privater Outlook.com-Konten.
 */
export type MsAppAudience = 'tenant' | 'orgs' | 'multi';

export type MsProvisionState = 'waiting' | 'working' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface MsProvisionStep {
  label: string;
  status: 'running' | 'done' | 'warning' | 'failed';
  detail?: string;
}

/** Von Kuvert automatisch angelegte bzw. aktualisierte Entra-ID-App */
export interface MsProvisionedApp {
  appId: string;
  objectId: string;
  displayName: string;
  tenantId: string;
  tenantName?: string | null;
  audience: MsAppAudience;
  /** Im Entra-Portal auf bestimmte Mandanten beschränkt: Anzahl der weiteren erlaubten Organisationen */
  allowedTenants?: number | null;
  /** Ablauf des von Kuvert erzeugten geheimen Clientschlüssels */
  secretExpiresAt: string;
  /** Administratorzustimmung für die Organisation wurde erteilt */
  consentGranted: boolean;
  provisionedAt: string;
  /** Microsoft-Konto des Administrators, mit dem eingerichtet wurde */
  provisionedBy?: string | null;
  /** Link zur App im Entra-Portal */
  portalUrl: string;
}

export interface MsProvisionStatus {
  id: string;
  state: MsProvisionState;
  /** Code, den der Administrator auf der Microsoft-Seite eingibt */
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  /** Angemeldetes Microsoft-Konto */
  signedInAs?: string | null;
  steps: MsProvisionStep[];
  error?: string;
  result?: MsProvisionedApp;
}

export interface MsProvisionOverview {
  /** Zuletzt automatisch eingerichtete App (falls vorhanden) */
  app: MsProvisionedApp | null;
  /** Ist diese App aktuell in Kuvert hinterlegt (Client-ID stimmt überein)? */
  active: boolean;
  /** Laufender oder kürzlich beendeter Vorgang des aktuellen Admins */
  job: MsProvisionStatus | null;
}
