import type { AccountTypeInfo } from './accounts';
import type { EmailAddress } from './common';
import type { CalendarEvent } from './pim';
import type { MessageSummary } from './mail';
import type { ChatCall, ChatMessage, ChatRing } from './chat';
import type { TriageInfo } from './triage';
import type { ThreeCxIncomingCall } from './telephony';
import type { MeetCallState } from './meet';

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  twoFactorEnabled: boolean;
  /** URL des Profilbilds (falls vorhanden) */
  avatarUrl?: string | null;
  /** Richtlinie verlangt 2FA, die aber noch nicht eingerichtet ist → Einrichtung erzwingen */
  mustSetup2fa?: boolean;
  /** Admin hat ein Passwort gesetzt → Benutzer muss es beim nächsten Login ändern */
  mustChangePassword?: boolean;
}

export interface ModuleInfo {
  id: string;
  name: string;
  description?: string;
  /** Feature-Flags, die das Modul im Frontend freischaltet (z. B. "ai", "smime") */
  features?: string[];
}

export interface AppInfo {
  name: string;
  version: string;
  setupRequired: boolean;
  allowRegistration: boolean;
  user: User | null;
  modules: ModuleInfo[];
  accountTypes: AccountTypeInfo[];
  /** Aggregierte Feature-Flags aller aktiven Module */
  features: Record<string, boolean>;
  vapidPublicKey?: string | null;
  publicUrl: string;
  policies: { require2fa: boolean; usersCanCreateApiTokens: boolean };
  /** Interaktive API-Dokumentation (OpenAPI/Swagger) */
  apiDocsUrl: string;
}

export interface Signature {
  id: string;
  name: string;
  /** html = WYSIWYG/HTML-Signatur, raw = unveränderter Quelltext (HTML oder Text) */
  mode: 'html' | 'raw';
  content: string;
  /** Für ein bestimmtes Konto/Absender (optional) */
  accountId?: string | null;
  identityAddress?: string | null;
  defaultNew: boolean;
  defaultReply: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject?: string;
  html: string;
}

/** Ein in der Mail-Seitenleiste oben angepinnter Ordner */
export interface FavoriteFolder {
  accountId: string;
  folderId: string;
}

export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  language: 'de' | 'en';
  calendarMode: 'overlay' | 'split';
  calendarView: 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay' | 'listWeek';
  weekStartsOn: 0 | 1;
  /** Externe Bilder/Inhalte standardmäßig blockieren (Tracking-Schutz) */
  blockRemoteContent: boolean;
  /** Absender/Domains, deren externe Inhalte immer geladen werden */
  trustedSenders: string[];
  /** Verzögerung zum Rückgängigmachen des Versands (0 = aus) */
  undoSendSeconds: number;
  readingPane: 'right' | 'bottom' | 'off';
  /**
   * Wann gilt eine Nachricht als gelesen?
   * - delay: beim Anzeigen, nach `markReadDelaySec` Sekunden
   * - leave: erst beim Wechsel zu einer anderen Nachricht bzw. beim Schließen
   * - manual: nie automatisch, nur von Hand
   */
  markReadMode: 'delay' | 'leave' | 'manual';
  /** Verzögerung für markReadMode = 'delay' (Sekunden, 0 = sofort) */
  markReadDelaySec: number;
  density: 'comfortable' | 'compact';
  composeFormat: 'html' | 'text';
  /** Verfassen-Fenster: im Hauptfenster (verschiebbar) oder als eigenes Browserfenster */
  composeWindow: 'inline' | 'popup';
  threading: boolean;
  /** Favoriten-Ordner in der Mail-Seitenleiste (Reihenfolge = Anzeige) */
  favoriteFolders: FavoriteFolder[];
  notifications: {
    desktop: boolean;
    sound: boolean;
    calendarReminders: boolean;
  };
  ai: {
    defaultLanguage: string;
    model?: string | null;
    /** Gespeicherte KI-Chats nach so vielen Tagen ohne Aktivität löschen (0 = nie) */
    chatRetentionDays?: number;
  };
  /** Freier Bereich für Modul-Einstellungen */
  modules?: Record<string, unknown>;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: 'system',
  language: 'de',
  calendarMode: 'overlay',
  calendarView: 'timeGridWeek',
  weekStartsOn: 1,
  blockRemoteContent: true,
  trustedSenders: [],
  undoSendSeconds: 10,
  readingPane: 'right',
  markReadMode: 'delay',
  markReadDelaySec: 1,
  density: 'comfortable',
  composeFormat: 'html',
  composeWindow: 'inline',
  threading: false,
  favoriteFolders: [],
  notifications: { desktop: true, sound: false, calendarReminders: true },
  ai: { defaultLanguage: 'Deutsch', model: null, chatRetentionDays: 90 },
  modules: {},
};

/* ───────────────────────── Echtzeit-Ereignisse (SSE) ───────────────────────── */

export type ServerEvent =
  | { type: 'hello'; time: string }
  | { type: 'ping'; time: string }
  | { type: 'mail.new'; accountId: string; folderId: string; messages: MessageSummary[] }
  | { type: 'mail.changed'; accountId: string; folderId?: string }
  /** KI-Triage abgeschlossen bzw. korrigiert (triage null = Einordnung entfernt) */
  | { type: 'mail.triage'; accountId: string; items: { id: string; folderId: string; triage: TriageInfo | null }[] }
  | { type: 'calendar.reminder'; event: CalendarEvent; minutesBefore: number }
  | { type: 'calendar.changed'; accountId: string }
  | { type: 'account.status'; accountId: string; status: 'ok' | 'error' | 'reauth'; message?: string | null }
  | { type: 'send.status'; jobId: string; status: 'sent' | 'failed' | 'scheduled' | 'cancelled'; error?: string | null; subject?: string }
  /* Team-Chat */
  | { type: 'chat.message'; conversationId: string; message: ChatMessage }
  | { type: 'chat.message.updated'; conversationId: string; message: ChatMessage }
  | { type: 'chat.conversation'; conversationId: string; removed?: boolean }
  | { type: 'chat.read'; conversationId: string; userId: string; seq: number }
  | { type: 'chat.typing'; conversationId: string; userId: string }
  | { type: 'chat.presence'; userId: string; online: boolean }
  /** Status einer Verbindung zu Mattermost/Talk geändert (Liste neu laden) */
  | { type: 'chat.connection'; connectionId: string; status: 'connecting' | 'ok' | 'error'; error?: string | null }
  /** Abschnitte/Favoriten eines verbundenen Dienstes geändert (neu laden) */
  | { type: 'chat.categories'; connectionId: string }
  /** Anruf begonnen/geändert/beendet (call null); ring = jemand ruft mich an; declinedBy = Gegenüber hat abgelehnt (Kuvert-Anruf) */
  | { type: 'chat.call'; conversationId: string; call: ChatCall | null; ring?: ChatRing; declinedBy?: string }
  /** Einladung in einen laufenden Kuvert-Anruf (auch ohne Mitgliedschaft in der Unterhaltung); active=false: vorbei/zurückgenommen */
  | { type: 'meet.invite'; callId: string; title: string; caller: string; active: boolean }
  /** Stand des Anrufs für die Kuvert-Teilnehmenden: Wartebereich, Gäste, Gast-Link */
  | { type: 'meet.state'; state: MeetCallState }
  /** 3CX: Anruf an der eigenen Nebenstelle klingelt, wurde angenommen, ist vorbei oder verpasst */
  | { type: 'threecx.call'; call: ThreeCxIncomingCall }
  /** Zeiterfassung: eigene Einträge, gemeinsame Kunden/Projekte/Tätigkeiten oder Import-Fortschritt geändert */
  | { type: 'timetrack.changed'; scope: 'entries' | 'masterdata' | 'import' };

/* ───────────────────────────── KI ───────────────────────────── */

export type AiAction =
  | 'rewrite'
  | 'formal'
  | 'friendly'
  | 'shorter'
  | 'longer'
  | 'fix'
  | 'translate'
  | 'summarize'
  | 'reply'
  | 'compose'
  | 'subject'
  | 'extract_tasks'
  | 'custom';

export interface AiRequest {
  action: AiAction;
  /** Ausgangstext (Markierung, Entwurf oder E-Mail-Inhalt) */
  text: string;
  /** Freie Anweisung (bei custom/compose/reply) */
  instruction?: string;
  /** Zielsprache (translate) bzw. Antwortsprache */
  language?: string;
  /** Zusätzlicher Kontext, z. B. ursprüngliche E-Mail bei Antworten */
  context?: string;
  model?: string;
  /** Ergebnis als HTML (für den Editor) statt reinem Text */
  html?: boolean;
}

/* ── KI-Chat ── */

export interface AiChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Angehängter Kontext eines KI-Chats: eine einzelne Mail, ein ganzer Verlauf oder ein aufgezeichnetes Gespräch (als Text) */
export interface AiChatContext {
  kind: 'message' | 'conversation' | 'meeting';
  /** Anzeigename, z. B. der Betreff */
  title: string;
  text: string;
}

export interface AiChatRequest {
  /** Verlauf des Chats, die letzte Nachricht ist die aktuelle Frage */
  messages: AiChatTurn[];
  context?: AiChatContext;
  /** Postfach (Suchindex bzw. Live-Suche) nach passenden Mails durchsuchen und als Quellen mitgeben */
  searchMailbox?: boolean;
  model?: string;
}

/** Eine Mail, die als Quelle in die Antwort eingeflossen ist */
export interface AiChatSource {
  accountId: string;
  folderId: string;
  id: string;
  subject: string;
  from?: EmailAddress;
  date: string;
}

/**
 * Antwort von POST /api/ai/chat: NDJSON, eine Zeile je Ereignis.
 * status = Zwischenschritt (z. B. Suchanfrage), sources = gefundene Mails, delta = Antworttext.
 */
export type AiChatEvent =
  | { t: 'status'; text: string }
  | { t: 'sources'; items: AiChatSource[]; query: string }
  | { t: 'delta'; v: string }
  | { t: 'error'; message: string }
  | { t: 'done' };

/** Eine gespeicherte Chatnachricht (inkl. Quellen der Postfach-Suche) */
export interface AiChatStoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: AiChatSource[];
  searchQuery?: string;
  error?: string;
}

/** Gespeicherter KI-Chat (pro Benutzer auf dem Server) */
export interface AiChatRecord {
  id: string;
  title: string;
  /** Titel vom Benutzer gesetzt – wird nicht mehr automatisch angepasst */
  titleManual?: boolean;
  /** Schlüssel des Kontexts (z. B. Mail), um den Chat dazu wiederzufinden */
  contextKey?: string | null;
  context?: AiChatContext | null;
  /** Nachricht, auf die "Als Antwort" antwortet */
  replyRef?: { accountId: string; folderId: string; id: string } | null;
  searchMailbox: boolean;
  model?: string | null;
  messages: AiChatStoredMessage[];
  createdAt: string;
  updatedAt: string;
}

/** Eintrag der Chat-Liste (ohne Nachrichten und Kontexttext) */
export interface AiChatSummary {
  id: string;
  title: string;
  kind: 'global' | AiChatContext['kind'];
  contextTitle?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Ein verfügbares Sprachmodell (Details nur, wenn das Backend sie liefert, z. B. Ollama) */
export interface AiModelInfo {
  name: string;
  /** Dateigröße in Bytes */
  sizeBytes?: number;
  /** z. B. "8.0B" */
  parameterSize?: string;
  /** z. B. "Q4_K_M" */
  quantization?: string;
  family?: string;
}

export interface AiStatus {
  enabled: boolean;
  reachable: boolean;
  baseUrl?: string;
  model?: string;
  models: string[];
  modelDetails?: AiModelInfo[];
  error?: string;
}

/* ───────────────────────────── S/MIME ───────────────────────────── */

export interface SmimeCertInfo {
  id: string;
  email: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  hasPrivateKey: boolean;
}
