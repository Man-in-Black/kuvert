import type { EmailAddress } from './common';
import type { TriageInfo } from './triage';

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'outbox' | 'other';

/** Postfach innerhalb eines Kontos (primär oder freigegeben). */
export interface Mailbox {
  id: string;
  name: string;
  address: string;
  shared: boolean;
}

export interface MailFolder {
  /** Opake, providerspezifische ID (kann das Postfach kodieren) */
  id: string;
  name: string;
  /** Vollständiger Pfad, z. B. "INBOX/Projekte" */
  path?: string;
  parentId?: string | null;
  role: FolderRole;
  unread?: number;
  total?: number;
  /** Zu welchem Postfach der Ordner gehört (für freigegebene Postfächer) */
  mailboxId?: string;
  /** false = reiner Container (IMAP \Noselect) */
  selectable?: boolean;
}

export interface FolderListResult {
  mailboxes: Mailbox[];
  folders: MailFolder[];
}

export type Importance = 'low' | 'normal' | 'high';

export type SmimeKind = 'signed' | 'encrypted';

export interface MessageSummary {
  id: string;
  accountId: string;
  folderId: string;
  threadId?: string;
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  /** ISO-8601 */
  date: string;
  preview?: string;
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  hasAttachments: boolean;
  /** S/MIME laut MIME-Struktur (ohne Prüfung der Signatur; die erfolgt erst beim Öffnen) */
  smime?: SmimeKind;
  importance?: Importance;
  categories?: string[];
  size?: number;
  /** RFC5322 Message-ID inkl. <> (für Konversationen ohne Provider-Thread-ID) */
  messageIdHeader?: string;
  inReplyTo?: string;
  /** Nur bei Treffern aus dem Suchindex: hervorgehobene Stellen (Marker HIGHLIGHT_START/END) */
  highlight?: { subject?: string; snippet?: string };
  /** KI-Triage (Priorität/Kategorie), falls eingeordnet */
  triage?: TriageInfo;
}

/** Marker für Hervorhebungen in Suchtreffern (Unicode Private Use, kollidiert nicht mit Mailtext) */
export const HIGHLIGHT_START = '\uE000';
export const HIGHLIGHT_END = '\uE001';

/** Ausgangspunkt, um eine Unterhaltung ordnerübergreifend (Gesendet, Archiv, Papierkorb …) zu laden */
export interface ThreadQuery {
  folderId: string;
  messageId: string;
  threadId?: string;
  /** Bekannte RFC5322-Message-IDs der Unterhaltung (für Anbieter ohne Thread-ID, z. B. IMAP) */
  messageIds?: string[];
}

export interface ThreadResult {
  items: MessageSummary[];
  /** false = Anbieter kann Unterhaltungen nicht ordnerübergreifend laden */
  supported: boolean;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline?: boolean;
  /** Content-ID ohne spitze Klammern (für cid:-Referenzen im HTML) */
  contentId?: string;
}

export interface SecurityInfo {
  signed?: boolean;
  signatureValid?: boolean;
  /** false: Signatur intakt, aber Zertifikatskette nicht vertrauenswürdig (unbekannte CA, abgelaufen, …) */
  trusted?: boolean;
  signer?: string;
  signerCertSubject?: string;
  encrypted?: boolean;
  decrypted?: boolean;
  error?: string;
}

export interface InviteInfo {
  method?: string;
  uid?: string;
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  organizer?: EmailAddress;
  /** Eigene Antwort, soweit bekannt (Exchange: aus dem Kalender; iCalendar: unbekannt) */
  myResponse?: 'none' | 'accepted' | 'tentative' | 'declined' | 'organizer';
  /** Zusagen/Absagen direkt aus der Mail möglich */
  canRespond?: boolean;
}

export interface MessageDetail extends MessageSummary {
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  html?: string;
  text?: string;
  attachments: AttachmentInfo[];
  references?: string[];
  headers?: Record<string, string>;
  security?: SecurityInfo;
  listUnsubscribe?: string;
  invite?: InviteInfo;
}

export interface OutgoingAttachment {
  filename: string;
  contentType?: string;
  /** Vorher über POST /api/uploads hochgeladene Datei */
  uploadId?: string;
  contentBase64?: string;
  inline?: boolean;
  contentId?: string;
}

/** Vom Client übergebene Nachricht zum Senden oder als Entwurf. */
export interface OutgoingMessage {
  identityId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
  /** Bezug auf eine Originalnachricht (Antwort/Weiterleitung) */
  reference?: { folderId: string; messageId: string; type: 'reply' | 'replyAll' | 'forward' };
  importance?: Importance;
  requestReadReceipt?: boolean;
  smime?: { sign?: boolean; encrypt?: boolean };
  /** Zeitversetztes Senden (ISO). Leer = sofort (bzw. nach Undo-Verzögerung) */
  sendAt?: string | null;
  /** Bestehender Entwurf, der nach dem Senden gelöscht/ersetzt wird */
  draftId?: string;
  draftFolderId?: string;
}

export interface MessageListQuery {
  folderId: string;
  cursor?: string;
  limit?: number;
  search?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
}

export interface FlagUpdate {
  seen?: boolean;
  flagged?: boolean;
}

export interface OutOfOfficeSettings {
  enabled: boolean;
  /** Antwort für interne Absender (bzw. alle, falls nicht unterschieden) */
  internalReply?: string;
  externalReply?: string;
  start?: string | null;
  end?: string | null;
}

export interface SendResult {
  status: 'sent' | 'scheduled';
  /** Job-ID bei verzögertem Versand (Undo / Später senden) */
  jobId?: string;
  sendAt?: string;
}

export interface ScheduledSend {
  id: string;
  accountId: string;
  subject: string;
  to: EmailAddress[];
  sendAt: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  error?: string | null;
}

export interface UploadInfo {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}
