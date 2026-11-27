import type { AddressSuggestion, Contact, MessageDetail, MessageSummary, OutgoingMessage } from '@kuvert/shared';
import type { BinaryContent, MailProvider, TasksProvider } from './providers.js';

export interface MessageViewContext {
  userId: string;
  accountId: string;
  folderId: string;
  mail: MailProvider;
}

/** Verändert/ergänzt eine Nachricht vor der Anzeige (z. B. S/MIME entschlüsseln). */
export type MessageViewHook = (ctx: MessageViewContext, msg: MessageDetail) => Promise<MessageDetail>;

/** Transformiert die fertige MIME-Nachricht vor dem Versand (z. B. S/MIME signieren). */
export interface RawSendTransformer {
  id: string;
  /** Muss für diese Nachricht über MIME gesendet werden? */
  applies(msg: OutgoingMessage): boolean;
  /** Reihenfolge: niedriger = früher (Signieren vor Verschlüsseln) */
  order: number;
  transform(ctx: { userId: string; accountId: string; message: OutgoingMessage }, raw: Buffer): Promise<Buffer>;
}

export type AfterSendHook = (ctx: { userId: string; accountId: string; message: OutgoingMessage }) => void | Promise<void>;

export type NewMailHook = (ctx: {
  userId: string;
  accountId: string;
  folderId: string;
  messages: MessageSummary[];
}) => void | Promise<void>;

/**
 * Ergänzt Nachrichten einer Liste (Ordner, gemeinsamer Posteingang, Suche) vor der
 * Auslieferung, z. B. um die KI-Triage. accountId/folderId sind Vorgaben für
 * Einträge, bei denen der Provider sie nicht setzt.
 */
export type MessageListHook = (
  ctx: { userId: string; accountId?: string; folderId?: string },
  items: MessageSummary[],
) => MessageSummary[] | Promise<MessageSummary[]>;

/** Liefert Anhänge mit modul-eigenen IDs (z. B. "smime:…"), sonst undefined. */
export type AttachmentResolver = (
  ctx: MessageViewContext,
  messageId: string,
  attachmentId: string,
) => Promise<BinaryContent | undefined>;

/** Volltext-Suchindex (vom Modul "search" bereitgestellt) */
export interface SearchIndexHook {
  /** Konten des Benutzers, deren Index vollständig aufgebaut ist */
  readyAccounts(userId: string): Promise<Set<string>>;
  search(
    userId: string,
    opts: { q: string; accountIds: string[]; folderId?: string; limit: number; offset: number },
  ): Promise<{ items: MessageSummary[]; total: number; processingTimeMs: number }>;
  /** Suchbefehle (from:, is:unread …) entfernen – für Anbieter ohne Index */
  plainText(q: string): string;
}

/** ID des einzigen Adressbuchs einer Kontaktquelle */
export const SOURCE_BOOK_ID = 'contacts';

/**
 * Zusätzliche Kontaktquelle ohne Mailkonto (z. B. ein CRM), nur lesend.
 * Erscheint als ein schreibgeschütztes Adressbuch unter der Pseudo-Konto-ID `id`.
 */
export interface ContactSource {
  /** Pseudo-Konto-ID; darf mit keiner echten Konto-ID kollidieren */
  id: string;
  /** Name der Quelle (Gruppenüberschrift, Beschriftung der Vorschläge) */
  name: string;
  /** Name des einen Adressbuchs */
  bookName: string;
  color?: string;
  /** Für diesen Benutzer eingerichtet? Sonst taucht die Quelle nicht auf. */
  available(userId: string): boolean;
  /** Alle Kontakte (accountId = id, addressBookId = SOURCE_BOOK_ID) */
  listContacts(userId: string): Promise<Contact[]>;
  suggest?(userId: string, query: string, limit: number): Promise<AddressSuggestion[]>;
}

/**
 * Zusätzliche Aufgabenquelle ohne Mailkonto (z. B. Kuvert-eigene Aufgaben).
 * Erscheint mit ihren Listen unter der Pseudo-Konto-ID `id` auf der Aufgabenseite.
 */
export interface TaskSource {
  /** Pseudo-Konto-ID; darf mit keiner echten Konto-ID kollidieren */
  id: string;
  /** Name der Quelle (Gruppenüberschrift) */
  name: string;
  color?: string;
  /** Listen lassen sich in Kuvert anlegen/umbenennen/löschen */
  manageable?: boolean;
  /** Für diesen Benutzer verfügbar? Sonst taucht die Quelle nicht auf. */
  available(userId: string): boolean;
  /** Aufgaben-Provider für diesen Benutzer */
  provider(userId: string): TasksProvider;
}

/** Zentrale Hook-Sammlung – Module registrieren sich in `init()`. */
export class Hooks {
  readonly messageView: MessageViewHook[] = [];
  readonly rawSend: RawSendTransformer[] = [];
  readonly afterSend: AfterSendHook[] = [];
  readonly newMail: NewMailHook[] = [];
  readonly messageList: MessageListHook[] = [];
  readonly attachmentResolvers: AttachmentResolver[] = [];
  readonly contactSources: ContactSource[] = [];
  readonly taskSources: TaskSource[] = [];
  /** Wird vom Suchmodul gesetzt, wenn ein Index verfügbar ist */
  searchIndex: SearchIndexHook | null = null;

  async runMessageView(ctx: MessageViewContext, msg: MessageDetail): Promise<MessageDetail> {
    let result = msg;
    for (const hook of this.messageView) result = await hook(ctx, result);
    return result;
  }

  /** Fehler einzelner Hooks brechen die Liste nicht ab – sie wird dann unverändert geliefert */
  async runMessageList(ctx: Parameters<MessageListHook>[0], items: MessageSummary[]): Promise<MessageSummary[]> {
    let result = items;
    for (const hook of this.messageList) {
      try {
        result = await hook(ctx, result);
      } catch {
        /* Liste trotzdem ausliefern */
      }
    }
    return result;
  }
}
