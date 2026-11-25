/**
 * Typen der Integrationen mailcow (Mailserver-Verwaltung) und Mail-Archiver
 * (revisionssicheres Archiv, https://github.com/s1t5/mail-archiver).
 */

/* ═════════════════════════════ mailcow ═════════════════════════════ */

export interface MailcowInstanceInfo {
  id: string;
  name: string;
  baseUrl: string;
  /** Hostname für IMAP/SMTP/SOGo (aus der Basis-URL) */
  hostname: string;
  /** Letzte Zeichen des API-Schlüssels zur Wiedererkennung */
  keyHint: string;
  createdAt: string;
}

export interface MailcowContainer {
  name: string;
  state: string;
  running: boolean;
  image?: string;
  startedAt?: string | null;
}

export interface MailcowStatus {
  version?: string | null;
  containers: MailcowContainer[];
  vmail?: { used?: string; total?: string; usedPercent?: number | null } | null;
}

export interface MailcowMailbox {
  username: string;
  name: string;
  domain: string;
  localPart: string;
  active: boolean;
  /** Kontingent in Bytes (0 = unbegrenzt) */
  quota: number;
  quotaUsed: number;
  percentInUse: number;
  messages: number;
  tags?: string[];
  lastLogin?: string | null;
}

export interface MailcowDomain {
  domain: string;
  active: boolean;
  description?: string;
  mailboxes?: number;
  maxMailboxes?: number;
  aliases?: number;
  maxAliases?: number;
  quotaUsed?: number;
  maxQuota?: number;
}

export interface MailcowAlias {
  id: string;
  address: string;
  /** Ziel(e), kommagetrennt */
  goto: string;
  active: boolean;
  domain?: string;
  isCatchAll?: boolean;
  comment?: string;
}

export interface MailcowTempAlias {
  address: string;
  goto: string;
  /** Ablaufzeitpunkt (ISO) */
  validUntil?: string | null;
  createdAt?: string | null;
  description?: string | null;
}

export interface MailcowAppPassword {
  id: string;
  name: string;
  active: boolean;
  protocols: string[];
  createdAt?: string | null;
}

export interface MailcowQuarantineItem {
  id: string;
  qid?: string;
  sender: string;
  recipient: string;
  subject: string;
  score?: number | null;
  createdAt?: string | null;
  virus: boolean;
  notified?: boolean;
}

export interface MailcowSyncJob {
  id: string;
  mailbox: string;
  host: string;
  remoteUser: string;
  active: boolean;
  running: boolean;
  lastRun?: string | null;
  intervalMin?: number | null;
}

/** Verknüpfung Kuvert-Benutzer ↔ mailcow-Postfach (Self-Service) */
export interface MailcowLink {
  userId: string;
  userEmail?: string;
  instanceId: string;
  instanceName?: string;
  mailbox: string;
  createdAt?: string;
}

export interface MailcowLinkedMailbox {
  instanceId: string;
  instanceName: string;
  mailbox: string;
  info: MailcowMailbox | null;
  error?: string | null;
}

export interface MailcowProvisionRequest {
  instanceId: string;
  localPart: string;
  domain: string;
  name: string;
  password: string;
  quotaMb: number;
  active?: boolean;
  /** Kuvert-Benutzer: keiner, vorhandener oder neu anlegen */
  kuvertUser: { mode: 'none' } | { mode: 'existing'; userId: string } | { mode: 'new'; email: string; name: string; password: string; isAdmin?: boolean; mustChangePassword?: boolean };
  /** Direkt ein mailcow-Konto (Mail + SOGo-Kalender/Kontakte) für den Benutzer anlegen */
  addAccount: boolean;
}

export interface MailcowProvisionResult {
  mailbox: string;
  userId?: string | null;
  accountId?: string | null;
  warnings: string[];
}

/* ═════════════════════════════ Mail-Archiver ═════════════════════════════ */

export interface ArchiverAdminConfig {
  enabled: boolean;
  /** Standard-URL des Mail-Archivers, z. B. https://archiv.example.com */
  baseUrl: string;
}

export interface ArchiverUserConfig {
  enabled: boolean;
  configured: boolean;
  /** Effektive URL (eigene oder Standard) */
  baseUrl: string | null;
  /** Eigene URL (überschreibt Standard) */
  overrideUrl: string | null;
  defaultBaseUrl: string | null;
  keyHint: string | null;
}

export interface ArchiverStats {
  emails: number;
  accounts: number;
  attachments: number;
  databaseSizeInMB?: string;
}

export interface ArchiverAccount {
  id: number;
  name: string;
  emailAddress: string;
  provider: string;
  isEnabled: boolean;
  lastSync?: string | null;
}

export interface ArchiverFolder {
  name: string;
  fullPath: string;
  totalCount: number;
  level: number;
  children: ArchiverFolder[];
}

export interface ArchiverEmailSummary {
  id: number;
  accountId: number;
  subject: string;
  from: string;
  to: string;
  sentDate: string;
  isOutgoing: boolean;
  hasAttachments: boolean;
  folderName: string;
}

export interface ArchiverAttachment {
  id: number;
  fileName: string;
  contentType: string;
  size: number;
}

export interface ArchiverEmailDetail extends ArchiverEmailSummary {
  cc: string;
  bcc: string;
  receivedDate: string;
  messageId: string;
  textBody: string;
  htmlBody: string;
  attachments: ArchiverAttachment[];
  hasRawMessage: boolean;
}

export interface ArchiverSearchQuery {
  q?: string;
  /** YYYY-MM-DD (inklusive) */
  from?: string;
  to?: string;
  accountId?: number;
  folder?: string;
  direction?: 'incoming' | 'outgoing';
  page?: number;
  pageSize?: number;
  sortBy?: 'sentDate' | 'receivedDate' | 'subject' | 'from' | 'to';
  sortOrder?: 'asc' | 'desc';
}

export interface ArchiverSearchResult {
  items: ArchiverEmailSummary[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}
