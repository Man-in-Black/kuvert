/* ───────────────────────────── Team-Chat ───────────────────────────── */

/** Ein Kuvert-Benutzer aus Sicht des Chats (Verzeichnis, Mitglieder) */
export interface ChatUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  /** Mindestens ein Browser-Tab ist verbunden */
  online: boolean;
  jobTitle?: string;
  department?: string;
  /** Vom Admin gesperrt – bleibt für Namen in alten Nachrichten sichtbar, ist aber nicht auswählbar */
  disabled?: boolean;
  /** Text nach "@", mit dem man die Person im Chat erwähnt (Kuvert: E-Mail-Name, Mattermost: Benutzername …) */
  mention?: string;
}

export interface ChatMember {
  userId: string;
  role: 'owner' | 'member';
  /** Bis zu dieser Nachricht (seq) hat das Mitglied gelesen */
  lastReadSeq: number;
  joinedAt: string;
}

export interface ChatAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ChatReaction {
  emoji: string;
  userIds: string[];
  /** Anzahl, falls nicht alle Personen bekannt sind (Nextcloud Talk liefert nur Zähler) */
  count?: number;
}

/** Ereignis einer Systemnachricht (wird im Client übersetzt) */
export interface ChatSystemEvent {
  /** 'text' = fertiger Text eines verbundenen Dienstes (Mattermost, Talk, Teams) */
  action: 'created' | 'added' | 'removed' | 'left' | 'renamed' | 'text';
  actorId: string;
  userIds?: string[];
  name?: string;
  text?: string;
}

export interface ChatMessage {
  id: string;
  /** Fortlaufende Nummer (global aufsteigend) – Sortierung, Lesestand, Paginierung */
  seq: number;
  conversationId: string;
  /** null = Systemnachricht oder gelöschter Benutzer */
  senderId: string | null;
  kind: 'text' | 'system';
  /** Text (leichtes Markdown); bei Systemnachrichten JSON eines ChatSystemEvent */
  body: string;
  createdAt: string;
  editedAt?: string | null;
  deleted: boolean;
  replyTo?: { id: string; senderId: string | null; body: string; deleted: boolean; hasAttachments: boolean } | null;
  attachments: ChatAttachment[];
  reactions: ChatReaction[];
  /** Anzeigename des Absenders bei verbundenen Diensten (falls nicht unter participants) */
  senderName?: string | null;
  /** Verbundene Dienste: Nachricht erwähnt mich (@name, @all …) – in Gruppen wird nur dann benachrichtigt */
  mention?: boolean;
  /** Anruf-Beitrag (Mattermost Calls) – wird als Karte statt als Text angezeigt */
  call?: ChatCallInfo | null;
  /** Formatierte Meldungen von Bots/Webhooks (Mattermost-Nachrichtenanhänge) */
  cards?: ChatCard[];
  /** Beitrag eines Bots oder Webhooks (auch wenn er über das eigene Konto eingeliefert wurde) */
  bot?: boolean;
}

/** Formatierte Meldung (Mattermost "message attachment" / Slack-Format) */
export interface ChatCard {
  /** Farbe des Randstreifens (CSS-Farbe) */
  color?: string | null;
  /** Text über der Karte */
  pretext?: string | null;
  author?: string | null;
  authorUrl?: string | null;
  title?: string | null;
  titleUrl?: string | null;
  /** Haupttext (leichtes Markdown) */
  text?: string | null;
  fields?: { title: string; value: string; short: boolean }[];
  imageUrl?: string | null;
  footer?: string | null;
  /** Zeitpunkt (ISO) */
  ts?: string | null;
}

/** Klartext der Karten für Vorschau, Suche und Benachrichtigungen */
export function cardsText(cards: ChatCard[] | null | undefined): string {
  if (!cards?.length) return '';
  return cards
    .map((c) => [c.pretext, c.title, c.text, ...(c.fields ?? []).map((f) => `${f.title}: ${f.value}`)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n');
}

/** Anruf-Beitrag im Verlauf */
export interface ChatCallInfo {
  startedAt: string;
  /** null = läuft noch */
  endedAt: string | null;
  /** Wer teilgenommen hat (soweit bekannt) */
  participantIds: string[];
  title?: string | null;
}

/** Laufender Anruf in einer Unterhaltung (Mattermost Calls) */
export interface ChatCall {
  startedAt: string;
  /** Wer den Anruf gestartet hat */
  ownerId: string | null;
  /** Wer gerade im Anruf ist */
  participantIds: string[];
  /** Beitreten: Unterhaltung im Dienst öffnen (dort läuft der Anruf) */
  joinUrl?: string | null;
}

/** Eingehender (oder verpasster) Anruf aus einem verbundenen Dienst – löst Klingeln bzw. Hinweis aus */
export interface ChatRing {
  /** Name der anrufenden Person */
  caller: string;
  /** Name der Gruppe (leer bei Direktnachrichten) */
  title: string;
  direct: boolean;
  /** Anruf ist vorbei, ohne dass ich dabei war ("Verpasster Anruf") */
  missed?: boolean;
}

/* ───────────── Verbundene Dienste (Mattermost, Nextcloud Talk, Microsoft Teams) ───────────── */

export type ChatBridgeType = 'mattermost' | 'talk' | 'teams';

export const CHAT_BRIDGE_LABELS: Record<ChatBridgeType, string> = { mattermost: 'Mattermost', talk: 'Nextcloud Talk', teams: 'Microsoft Teams' };

/** Herkunft einer Unterhaltung, die nicht im Kuvert-Chat selbst liegt */
export interface ChatSource {
  connectionId: string;
  type: ChatBridgeType;
  /** Name der Verbindung */
  label: string;
  /** Zusatz wie Team-Name (Mattermost) */
  context?: string | null;
  /** Unterhaltung im Original öffnen */
  webUrl?: string | null;
  /** Anruf im Dienst starten (fehlt = webUrl), z. B. Teams-Anruf-Link */
  callUrl?: string | null;
}

/** Was in einer Unterhaltung möglich ist (Kuvert-Chat: alles) */
export interface ChatCapabilities {
  edit: boolean;
  delete: boolean;
  react: boolean;
  reply: boolean;
  files: boolean;
  typing: boolean;
  /** Lesestand der anderen ist bekannt (Lesebestätigungen) */
  readReceipts: boolean;
  /** Name/Beschreibung ändern, Mitglieder verwalten, verlassen */
  manage: boolean;
  /** Anrufe sind beim Dienst verfügbar (Beitreten/Starten öffnet den Dienst) */
  calls?: boolean;
}

/** Verbindung eines Benutzers zu einem externen Chat-Dienst */
export interface ChatConnection {
  id: string;
  type: ChatBridgeType;
  label: string;
  baseUrl: string;
  /** Angemeldet als */
  username: string;
  displayName?: string | null;
  status: 'connecting' | 'ok' | 'error';
  error?: string | null;
  createdAt: string;
}

export interface ChatConnectionInput {
  type: ChatBridgeType;
  label?: string;
  baseUrl?: string;
  /** Mattermost: Benutzername/E-Mail; Talk: Nextcloud-Benutzername */
  username?: string;
  /** Mattermost: Passwort (alternativ token); Talk: App-Passwort */
  password?: string;
  /** Mattermost: persönliches Zugriffstoken */
  token?: string;
  /** Talk: Zugangsdaten aus einem vorhandenen Nextcloud-Konto übernehmen; Teams: Microsoft-365-Konto (Pflicht) */
  fromAccountId?: string;
}

export interface ChatConversation {
  id: string;
  kind: 'direct' | 'group';
  /** Nur bei Gruppen; Direktnachrichten zeigen den Namen des Gegenübers */
  name: string | null;
  description?: string | null;
  createdAt: string;
  lastMessageAt: string;
  members: ChatMember[];
  lastMessage?: ChatMessage | null;
  unread: number;
  muted: boolean;
  pinned: boolean;
  myRole: 'owner' | 'member';
  /** Nur bei verbundenen Diensten */
  source?: ChatSource | null;
  /** Fehlt = Kuvert-Chat (alles möglich) */
  capabilities?: ChatCapabilities;
  /** Mitgliederzahl, wenn members nicht vollständig ist (verbundene Dienste) */
  memberCount?: number | null;
  /** Bekannte Personen der Unterhaltung, die keine Kuvert-Benutzer sind (Namen, Avatare, Online-Status) */
  participants?: ChatUser[];
  /** Laufender Anruf (nur verbundene Dienste mit Anrufen) */
  call?: ChatCall | null;
}

/** Abschnitt der Seitenleiste eines verbundenen Dienstes (Mattermost: Favoriten, Kanäle, Direktnachrichten, eigene) */
export interface ChatCategory {
  id: string;
  connectionId: string;
  kind: 'favorites' | 'channels' | 'direct' | 'custom';
  name: string;
  /** Team, falls der Benutzer in mehreren Teams ist */
  context?: string | null;
  /** Sortierung wie im Dienst eingestellt */
  sorting: 'alpha' | 'recent' | 'manual';
  /** Im Dienst eingeklappt (Ausgangszustand) */
  collapsed: boolean;
  /** Unterhaltungen in der Reihenfolge des Dienstes */
  conversationIds: string[];
}

export interface ChatMessagePage {
  items: ChatMessage[];
  /** Es gibt ältere Nachrichten */
  hasMore: boolean;
}

export interface ChatSearchHit {
  message: ChatMessage;
  conversationId: string;
}

/** Persönliche Chat-Einstellungen (UserSettings.modules.chat) */
export interface ChatSettings {
  /** Desktop-Benachrichtigung / Toast für neue Chatnachrichten */
  notify: boolean;
  sound: boolean;
  /** Enter sendet (sonst Strg/⌘+Enter) */
  enterToSend: boolean;
  /** Sortierung der Unterhaltungsliste (Abschnitte verbundener Dienste folgen deren Einstellung) */
  listSort: 'recent' | 'alpha';
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { notify: true, sound: true, enterToSend: true, listSort: 'recent' };

/* ───────────────────────────── Erwähnungen ───────────────────────────── */

/** Erwähnungen, die alle Mitglieder einer Gruppe betreffen */
export const MENTION_ALL_HANDLES = ['all', 'channel', 'here'] as const;

/** Erwähnungs-Kürzel eines Kuvert-Benutzers: Teil der E-Mail-Adresse vor dem @ */
export function mentionHandle(email: string | null | undefined): string | undefined {
  const local = (email ?? '').split('@')[0]?.trim().toLowerCase();
  return local && /^[\w.+-]+$/.test(local) ? local : undefined;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Erwähnt der Text die Person (@kürzel) oder alle (@all, @channel, @here)? */
export function mentionsHandle(body: string, handle: string | null | undefined): boolean {
  if (!body.includes('@')) return false;
  const names = [...MENTION_ALL_HANDLES, ...(handle ? [reEscape(handle)] : [])];
  return new RegExp(`(?<![\\w@.])@(${names.join('|')})(?![\\w-]|\\.\\w)`, 'i').test(body);
}

/** Schnell-Reaktionen in der Nachrichtenleiste */
export const CHAT_QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;
