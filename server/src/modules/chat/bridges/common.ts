/**
 * Gemeinsame Bausteine der Chat-Brücken (Mattermost, Nextcloud Talk):
 * ID-Schema, Verbindungsspeicher, persönliche Einstellungen und die Schnittstelle,
 * über die eine Brücke ihre Unterhaltungen in die Typen des Kuvert-Chats übersetzt.
 *
 * IDs externer Objekte beginnen mit "x~" und enthalten die Verbindung sowie die
 * entfernten IDs (base64url), z. B. x~<verbindung>~<kanal> oder x~<verbindung>~<kanal>~<nachricht>.
 * Der eigene Benutzer des Dienstes wird auf die Kuvert-Benutzer-ID abgebildet –
 * so funktionieren "eigene Nachricht", Reaktionen und Lesestand im Client unverändert.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  emojiForShortcode,
  shortcodeForEmoji,
  type ChatBridgeType,
  type ChatCapabilities,
  type ChatCategory,
  type ChatConnection,
  type ChatConversation,
  type ChatMessage,
  type ChatMessagePage,
  type ChatUser,
  type ServerEvent,
} from '@kuvert/shared';
import { decryptJson, encryptJson } from '../../../core/crypto.js';
import { getDb } from '../../../core/db.js';
import { BadRequestError, NotFoundError } from '../../../core/errors.js';

/* ───────────────────────────── IDs ───────────────────────────── */

export const EXT_PREFIX = 'x~';

const b64e = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const b64d = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export const isExternalId = (id: string | null | undefined): id is string => typeof id === 'string' && id.startsWith(EXT_PREFIX);

export function extId(connectionId: string, ...parts: string[]): string {
  return [EXT_PREFIX.slice(0, -1), connectionId, ...parts.map(b64e)].join('~');
}

/** Zerlegt eine externe ID (wirft 404 bei ungültigem Format) */
export function parseExtId(id: string, expectedParts: number): { connectionId: string; parts: string[] } {
  const segs = id.split('~');
  if (segs[0] !== 'x' || segs.length !== expectedParts + 2 || !segs[1]) throw new NotFoundError('Unterhaltung');
  try {
    return { connectionId: segs[1], parts: segs.slice(2).map(b64d) };
  } catch {
    throw new NotFoundError('Unterhaltung');
  }
}

/** Verbindungs-ID aus einer beliebigen externen ID */
export function connectionOf(id: string): string {
  const segs = id.split('~');
  if (segs[0] !== 'x' || !segs[1]) throw new NotFoundError('Unterhaltung');
  return segs[1];
}

/* ───────────────────────────── Speicher ───────────────────────────── */

export const bridgeMigrations = [
  {
    id: 'chat-002',
    sql: `
      CREATE TABLE chat_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        remote_user_id TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        secrets_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX chat_connections_user ON chat_connections(user_id);
      CREATE TABLE chat_ext_prefs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, conversation_id)
      );
    `,
  },
];

export interface ConnectionRecord {
  id: string;
  userId: string;
  type: ChatBridgeType;
  label: string;
  baseUrl: string;
  username: string;
  displayName: string | null;
  /** ID des eigenen Benutzers beim Dienst */
  remoteUserId: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  createdAt: string;
}

interface ConnRow {
  id: string;
  user_id: string;
  type: ChatBridgeType;
  label: string;
  base_url: string;
  username: string;
  display_name: string | null;
  remote_user_id: string;
  config_json: string;
  secrets_enc: string | null;
  created_at: string;
}

const toRecord = (r: ConnRow): ConnectionRecord => ({
  id: r.id,
  userId: r.user_id,
  type: r.type,
  label: r.label,
  baseUrl: r.base_url,
  username: r.username,
  displayName: r.display_name,
  remoteUserId: r.remote_user_id,
  config: JSON.parse(r.config_json || '{}') as Record<string, unknown>,
  secrets: decryptJson<Record<string, string>>(r.secrets_enc),
  createdAt: r.created_at,
});

export const connectionStore = {
  all(): ConnectionRecord[] {
    return (getDb().prepare('SELECT * FROM chat_connections').all() as ConnRow[]).map(toRecord);
  },
  list(userId: string): ConnectionRecord[] {
    return (getDb().prepare('SELECT * FROM chat_connections WHERE user_id = ? ORDER BY created_at').all(userId) as ConnRow[]).map(toRecord);
  },
  get(id: string): ConnectionRecord | undefined {
    const r = getDb().prepare('SELECT * FROM chat_connections WHERE id = ?').get(id) as ConnRow | undefined;
    return r ? toRecord(r) : undefined;
  },
  insert(rec: Omit<ConnectionRecord, 'createdAt'>) {
    getDb()
      .prepare(
        `INSERT INTO chat_connections (id, user_id, type, label, base_url, username, display_name, remote_user_id, config_json, secrets_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.userId, rec.type, rec.label, rec.baseUrl, rec.username, rec.displayName, rec.remoteUserId, JSON.stringify(rec.config), encryptJson(rec.secrets));
  },
  setLabel(id: string, label: string) {
    getDb().prepare('UPDATE chat_connections SET label = ? WHERE id = ?').run(label, id);
  },
  setSecrets(id: string, secrets: Record<string, string>) {
    getDb().prepare('UPDATE chat_connections SET secrets_enc = ? WHERE id = ?').run(encryptJson(secrets), id);
  },
  delete(id: string) {
    getDb().prepare('DELETE FROM chat_connections WHERE id = ?').run(id);
    getDb().prepare(`DELETE FROM chat_ext_prefs WHERE conversation_id LIKE ? ESCAPE '\\'`).run(`x~${id.replace(/[\\%_]/g, (c) => `\\${c}`)}~%`);
  },
};

/** Stummschalten/Anheften externer Unterhaltungen – nur in Kuvert, der Dienst bleibt unberührt */
export const extPrefs = {
  all(userId: string): Map<string, { muted: boolean; pinned: boolean }> {
    const rows = getDb().prepare('SELECT conversation_id, muted, pinned FROM chat_ext_prefs WHERE user_id = ?').all(userId) as {
      conversation_id: string;
      muted: number;
      pinned: number;
    }[];
    return new Map(rows.map((r) => [r.conversation_id, { muted: !!r.muted, pinned: !!r.pinned }]));
  },
  get(userId: string, conversationId: string): { muted: boolean; pinned: boolean } {
    const r = getDb().prepare('SELECT muted, pinned FROM chat_ext_prefs WHERE user_id = ? AND conversation_id = ?').get(userId, conversationId) as
      | { muted: number; pinned: number }
      | undefined;
    return { muted: !!r?.muted, pinned: !!r?.pinned };
  },
  set(userId: string, conversationId: string, patch: { muted?: boolean; pinned?: boolean }) {
    const cur = this.get(userId, conversationId);
    const next = { muted: patch.muted ?? cur.muted, pinned: patch.pinned ?? cur.pinned };
    getDb()
      .prepare(
        `INSERT INTO chat_ext_prefs (user_id, conversation_id, muted, pinned) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET muted = excluded.muted, pinned = excluded.pinned`,
      )
      .run(userId, conversationId, next.muted ? 1 : 0, next.pinned ? 1 : 0);
  },
};

/* ───────────────────────────── Schnittstelle ───────────────────────────── */

export interface BinaryFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Was eine Brücke von ihrem Besitzer bekommt */
export interface BridgeHost {
  log: FastifyBaseLogger;
  /** Ereignis an den Kuvert-Benutzer der Verbindung (SSE) */
  publish(event: ServerEvent): void;
  /** Neue fremde Nachricht – Web Push, sofern nicht stummgeschaltet */
  incoming(message: ChatMessage, info: { kind: 'direct' | 'group'; title: string; sender: string }): void;
  /** Ist der Benutzer gerade mit einem Browser verbunden? */
  online(): boolean;
  setStatus(status: ChatConnection['status'], error?: string | null): void;
  /** Geänderte Zugangsdaten (z. B. neues Sitzungstoken) dauerhaft speichern */
  saveSecrets(secrets: Record<string, string>): void;
  /** Jemand ruft mich an (Direktnachricht/Gruppe) – Web Push, sofern nicht stummgeschaltet */
  ringing(conversationId: string, info: { caller: string; title: string; direct: boolean }): void;
}

export interface ChatBridge {
  readonly conn: ConnectionRecord;
  readonly capabilities: ChatCapabilities;
  /** Entfernte Kanal-ID → Kuvert-ID */
  convId(remote: string): string;
  /** Kuvert-Benutzer-ID (eigene oder x~…) → entfernte ID */
  remoteUid(id: string): string;
  /** Echtzeit/Abfrage starten bzw. beenden */
  start(): void;
  stop(): void;
  /** Benutzer hat einen Browser geöffnet/geschlossen (Abfrageintervall anpassen) */
  presence?(online: boolean): void;

  listConversations(): Promise<ChatConversation[]>;
  getConversation(remoteId: string): Promise<ChatConversation>;
  members(remoteId: string): Promise<ChatUser[]>;
  messages(remoteId: string, opts: { beforeId?: string; limit: number }): Promise<ChatMessagePage>;
  send(remoteId: string, input: { body: string; replyTo?: string | null; files: BinaryFile[] }): Promise<ChatMessage>;
  edit(remoteId: string, messageId: string, body: string): Promise<ChatMessage>;
  delete(remoteId: string, messageId: string): Promise<ChatMessage>;
  react(remoteId: string, messageId: string, emoji: string): Promise<ChatMessage>;
  markRead(remoteId: string): Promise<void>;
  typing(remoteId: string): Promise<void>;
  search(q: string): Promise<ChatMessage[]>;
  file(ref: string, inline: boolean): Promise<BinaryFile>;
  avatar(remoteUserId: string): Promise<BinaryFile>;
  searchUsers(q: string): Promise<ChatUser[]>;
  openDirect(remoteUserId: string): Promise<ChatConversation>;
  createGroup(name: string, remoteUserIds: string[]): Promise<ChatConversation>;
  /** Favoriten werden beim Dienst gespeichert (statt lokal "angeheftet") */
  setFavorite?(remoteId: string, favorite: boolean): Promise<void>;
  /** Abschnitte der Seitenleiste wie im Dienst */
  categories?(): Promise<ChatCategory[]>;
}

/** Basisklasse: ID-Abbildung und Hilfen für beide Dienste */
export abstract class BridgeBase {
  constructor(
    public conn: ConnectionRecord,
    protected host: BridgeHost,
  ) {}

  protected get me(): string {
    return this.conn.userId;
  }

  convId(remote: string): string {
    return extId(this.conn.id, remote);
  }

  msgId(conv: string, msg: string): string {
    return extId(this.conn.id, conv, msg);
  }

  fileId(ref: string): string {
    return extId(this.conn.id, ref);
  }

  /** Entfernte Benutzer-ID → Kuvert-Sicht (eigener Benutzer = Kuvert-ID) */
  uid(remote: string | null | undefined): string | null {
    if (!remote) return null;
    return remote === this.conn.remoteUserId ? this.me : extId(this.conn.id, remote);
  }

  /** Kuvert-Sicht → entfernte Benutzer-ID */
  remoteUid(id: string): string {
    if (id === this.me) return this.conn.remoteUserId;
    const { connectionId, parts } = parseExtId(id, 1);
    if (connectionId !== this.conn.id) throw new BadRequestError('Person gehört zu einer anderen Verbindung');
    return parts[0]!;
  }

  avatarUrl(remote: string): string {
    return `/api/chat/ext/avatar/${extId(this.conn.id, remote)}`;
  }

  source(context?: string | null, webUrl?: string | null) {
    return { connectionId: this.conn.id, type: this.conn.type, label: this.conn.label, context: context ?? null, webUrl: webUrl ?? null };
  }
}

/** Kurztext einer Nachricht für Push-Benachrichtigungen */
export function previewText(m: ChatMessage): string {
  const text = m.body
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (m.attachments.length === 1) return `📎 ${m.attachments[0]!.filename}`;
  if (m.attachments.length > 1) return `📎 ${m.attachments.length} Dateien`;
  return '';
}

export const msToIso = (ms: number) => new Date(ms).toISOString();

/** Einfache Wiederholung mit wachsender Pause (für Echtzeit-Verbindungen) */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 1000);
}

/* ───────────────────────────── Emojis ───────────────────────────── */

/** Mattermost speichert Reaktionen als Namen (+1, heart …) – Abbildung über die gemeinsame Emoji-Tabelle */
export function emojiFromName(name: string): string {
  return emojiForShortcode(name) ?? `:${name}:`;
}

export function nameFromEmoji(emoji: string): string | undefined {
  const m = /^:([\w+-]+):$/.exec(emoji);
  if (m) return m[1];
  return shortcodeForEmoji(emoji);
}
