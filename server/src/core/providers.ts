/**
 * Provider-Schnittstellen. Jedes Konto-Modul (Microsoft, Google, IMAP, DAV, …) liefert
 * für ein Konto Implementierungen dieser Interfaces. Der Kern (Routen, gemeinsamer
 * Posteingang, Benachrichtigungen, S/MIME …) arbeitet ausschließlich gegen diese Interfaces.
 *
 * Alle IDs (Ordner, Nachrichten, Kalender …) sind für den Kern OPAK – der Provider
 * entscheidet über das Format (z. B. "mailbox::folderId" für freigegebene Postfächer).
 */
import type {
  AddressBook,
  AddressSuggestion,
  CalendarEvent,
  CalendarInfo,
  Contact,
  ContactInput,
  EventInput,
  EventResponse,
  FlagUpdate,
  FolderListResult,
  FolderRole,
  MailIdentity,
  MessageDetail,
  MessageListQuery,
  MessageSummary,
  OnlineMeeting,
  OutOfOfficeSettings,
  Paged,
  ShareLink,
  StorageItem,
  Task,
  TaskInput,
  TaskList,
  ThreadQuery,
  EmailAddress,
  Importance,
} from '@kuvert/shared';

export interface BinaryContent {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Vom Kern aufbereitete Nachricht: Anhänge sind bereits als Buffer geladen. */
export interface ResolvedOutgoingMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  html?: string;
  text?: string;
  attachments: { filename: string; contentType: string; data: Buffer; inline?: boolean; contentId?: string }[];
  inReplyTo?: string;
  references?: string[];
  reference?: { folderId: string; messageId: string; type: 'reply' | 'replyAll' | 'forward' };
  importance?: Importance;
  requestReadReceipt?: boolean;
  /** Identität, mit der gesendet wird (für Shared Mailboxes: mailboxId gesetzt) */
  identity?: MailIdentity;
}

export interface RawSendEnvelope {
  from: string;
  to: string[];
  /** Identität (für Shared Mailboxes bei Graph) */
  identity?: MailIdentity;
}

export interface PollResult {
  /** Neuer Status-Token (Delta-Link, historyId, UIDNEXT …) */
  state: string;
  /** Neue Nachrichten seit dem letzten Status (beim ersten Aufruf leer) */
  newMessages: MessageSummary[];
}

export interface MailProvider {
  listFolders(): Promise<FolderListResult>;
  listMessages(query: MessageListQuery): Promise<Paged<MessageSummary>>;
  getMessage(folderId: string, messageId: string): Promise<MessageDetail>;
  /** Komplette RFC822-Quelle (nötig für S/MIME und .eml-Export) */
  getRawMessage(folderId: string, messageId: string): Promise<Buffer>;
  getAttachment(folderId: string, messageId: string, attachmentId: string): Promise<BinaryContent>;

  /** Sendet über die native API (Graph JSON, Gmail, SMTP). */
  send(message: ResolvedOutgoingMessage): Promise<void>;
  /** Sendet eine fertige MIME-Nachricht (für S/MIME). */
  sendRaw(raw: Buffer, envelope: RawSendEnvelope): Promise<void>;
  /** Entwurf speichern/aktualisieren. Liefert neue IDs zurück. */
  saveDraft?(message: ResolvedOutgoingMessage, existing?: { folderId: string; messageId: string }): Promise<{ folderId: string; messageId: string }>;

  updateFlags(folderId: string, messageIds: string[], flags: FlagUpdate): Promise<void>;
  move(folderId: string, messageIds: string[], targetFolderId: string): Promise<void>;
  /** Standard: in Papierkorb verschieben; permanent = endgültig löschen */
  delete(folderId: string, messageIds: string[], permanent?: boolean): Promise<void>;

  /** Ordner-ID einer Standardrolle (inbox, sent, …) im primären Postfach */
  getSpecialFolderId(role: FolderRole): Promise<string | undefined>;
  /** Optional: Ordner-ID einer Standardrolle in einem weiteren (freigegebenen) Postfach */
  getMailboxFolderId?(mailboxId: string, role: FolderRole): Promise<string | undefined>;

  /** Ordnerverwaltung (optional) */
  createFolder?(name: string, parentId?: string | null): Promise<{ id: string }>;
  renameFolder?(folderId: string, name: string): Promise<void>;
  deleteFolder?(folderId: string): Promise<void>;

  /**
   * Optional, für den Suchindex: Texte (und Anhangnamen) mehrerer Nachrichten in einem Abruf.
   * Fehlt die Methode, lädt der Index jede Nachricht einzeln über getMessage().
   */
  getMessageTexts?(folderId: string, messageIds: string[]): Promise<Map<string, { text: string; attachments: string[]; encrypted?: boolean }>>;

  /**
   * Optional: alle Nachrichten einer Unterhaltung über alle Ordner hinweg
   * (inkl. Gesendet, Archiv, Papierkorb; ohne Entwürfe).
   */
  getThread?(query: ThreadQuery): Promise<MessageSummary[]>;

  /** Kontoweite Suche (alle Ordner inkl. Unterordnern). Fallback des Kerns: Suche im Posteingang */
  search?(query: string, opts: { cursor?: string; limit: number }): Promise<Paged<MessageSummary>>;

  /** Absenderadressen (inkl. Aliasse und freigegebener Postfächer) */
  listIdentities(): Promise<MailIdentity[]>;

  /**
   * Polling für Benachrichtigungen (Posteingang). Beim ersten Aufruf (state undefined)
   * nur Status ermitteln und leere newMessages liefern.
   */
  pollInbox?(state: string | undefined): Promise<PollResult>;

  /**
   * Optional: Push (IMAP IDLE, …). Ruft onChange bei Änderungen im Posteingang auf.
   * Liefert eine Funktion zum Beenden.
   */
  watchInbox?(onChange: () => void): Promise<() => void>;

  /**
   * Optional: Einladung direkt beantworten (Exchange: über den zugehörigen Kalendertermin).
   * Fehlt die Methode, schickt der Kern eine iTIP-Antwort (METHOD:REPLY) per Mail.
   */
  respondToInvite?(folderId: string, messageId: string, response: EventResponse, comment?: string): Promise<void>;

  getOutOfOffice?(): Promise<OutOfOfficeSettings>;
  setOutOfOffice?(settings: OutOfOfficeSettings): Promise<void>;

  /** Ressourcen freigeben (Verbindungen schließen) */
  dispose?(): Promise<void>;
}

export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  /** Liefert Termine inkl. expandierter Serien-Instanzen im Zeitraum */
  listEvents(calendarId: string, range: { start: string; end: string }): Promise<CalendarEvent[]>;
  createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent>;
  updateEvent(calendarId: string, eventId: string, input: Partial<EventInput>): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  respondToEvent?(calendarId: string, eventId: string, response: EventResponse, comment?: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface ContactsProvider {
  listAddressBooks(): Promise<AddressBook[]>;
  listContacts(addressBookId: string, opts: { search?: string; cursor?: string; limit?: number }): Promise<Paged<Contact>>;
  getContact?(addressBookId: string, contactId: string): Promise<Contact>;
  createContact(addressBookId: string, input: ContactInput): Promise<Contact>;
  updateContact(addressBookId: string, contactId: string, input: ContactInput): Promise<Contact>;
  deleteContact(addressBookId: string, contactId: string): Promise<void>;
  /** Schnelle Adress-Vorschläge (inkl. Firmenverzeichnis, falls verfügbar) */
  suggest?(query: string, limit: number): Promise<AddressSuggestion[]>;
  dispose?(): Promise<void>;
}

export interface TasksProvider {
  listTaskLists(): Promise<TaskList[]>;
  listTasks(listId: string, opts: { showCompleted?: boolean }): Promise<Task[]>;
  createTask(listId: string, input: TaskInput): Promise<Task>;
  updateTask(listId: string, taskId: string, input: TaskInput): Promise<Task>;
  deleteTask(listId: string, taskId: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface StorageProvider {
  /** folderId undefined/null = Wurzelverzeichnis */
  list(folderId?: string | null): Promise<StorageItem[]>;
  search?(query: string): Promise<StorageItem[]>;
  download(itemId: string): Promise<BinaryContent>;
  upload(folderId: string | null | undefined, filename: string, data: Buffer, contentType: string): Promise<StorageItem>;
  createShareLink?(itemId: string, opts?: { expiresDays?: number; password?: string }): Promise<ShareLink>;
  dispose?(): Promise<void>;
}

export interface MeetingsProvider {
  createMeeting(input: { subject: string; start: string; end: string }): Promise<OnlineMeeting>;
}

export interface ProviderSet {
  mail?: MailProvider;
  calendar?: CalendarProvider;
  contacts?: ContactsProvider;
  tasks?: TasksProvider;
  storage?: StorageProvider;
  meetings?: MeetingsProvider;
}
