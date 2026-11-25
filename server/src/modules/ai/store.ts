/**
 * Gespeicherte KI-Chats (pro Benutzer). Nachrichten und Kontext liegen als JSON in
 * der Zeile – ein Chat wird immer als Ganzes gelesen und geschrieben.
 */
import type { AiChatContext, AiChatRecord, AiChatStoredMessage, AiChatSummary } from '@kuvert/shared';
import { getDb } from '../../core/db.js';

export const migrations = [
  {
    id: 'ai-001-chats',
    sql: `
      CREATE TABLE ai_chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        title_manual INTEGER NOT NULL DEFAULT 0,
        context_key TEXT,
        context_json TEXT,
        reply_ref_json TEXT,
        search_mailbox INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        messages_json TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ai_chats_user ON ai_chats(user_id, updated_at);
      CREATE INDEX ai_chats_key ON ai_chats(user_id, context_key);
    `,
  },
];

interface Row {
  id: string;
  user_id: string;
  title: string;
  title_manual: number;
  context_key: string | null;
  context_json: string | null;
  reply_ref_json: string | null;
  search_mailbox: number;
  model: string | null;
  messages_json: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

const json = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const toRecord = (r: Row): AiChatRecord => ({
  id: r.id,
  title: r.title,
  titleManual: !!r.title_manual,
  contextKey: r.context_key,
  context: json<AiChatContext>(r.context_json),
  replyRef: json<AiChatRecord['replyRef']>(r.reply_ref_json),
  searchMailbox: !!r.search_mailbox,
  model: r.model,
  messages: json<AiChatStoredMessage[]>(r.messages_json) ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type ChatInput = Omit<AiChatRecord, 'id' | 'createdAt' | 'updatedAt'>;

export const chatStore = {
  list(userId: string, limit = 300): AiChatSummary[] {
    const rows = getDb()
      .prepare(
        `SELECT id, title, message_count, created_at, updated_at,
                json_extract(context_json, '$.kind') AS kind, json_extract(context_json, '$.title') AS context_title
           FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, limit) as { id: string; title: string; message_count: number; created_at: string; updated_at: string; kind: string | null; context_title: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind === 'message' || r.kind === 'conversation' ? r.kind : 'global',
      contextTitle: r.context_title ?? undefined,
      messageCount: r.message_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },

  get(userId: string, id: string): AiChatRecord | null {
    const r = getDb().prepare('SELECT * FROM ai_chats WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return r ? toRecord(r) : null;
  },

  /** Neuester Chat zu einem Kontext (z. B. derselben Mail) */
  byKey(userId: string, key: string): AiChatRecord | null {
    const r = getDb().prepare('SELECT * FROM ai_chats WHERE user_id = ? AND context_key = ? ORDER BY updated_at DESC LIMIT 1').get(userId, key) as Row | undefined;
    return r ? toRecord(r) : null;
  },

  /** Anlegen oder ersetzen; false, wenn die ID einem anderen Benutzer gehört */
  upsert(userId: string, id: string, c: ChatInput): AiChatRecord | null {
    const db = getDb();
    const existing = db.prepare('SELECT user_id, created_at, title, title_manual FROM ai_chats WHERE id = ?').get(id) as
      | { user_id: string; created_at: string; title: string; title_manual: number }
      | undefined;
    if (existing && existing.user_id !== userId) return null;
    const now = new Date().toISOString();
    // Vom Benutzer vergebener Titel bleibt, auch wenn der Client einen automatischen schickt
    const manual = !!existing?.title_manual && !c.titleManual;
    const title = manual ? existing!.title : c.title;
    db.prepare(
      `INSERT INTO ai_chats (id, user_id, title, title_manual, context_key, context_json, reply_ref_json, search_mailbox, model, messages_json, message_count, created_at, updated_at)
       VALUES (@id, @userId, @title, @titleManual, @contextKey, @context, @replyRef, @search, @model, @messages, @count, @createdAt, @now)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, title_manual = excluded.title_manual, context_key = excluded.context_key,
         context_json = excluded.context_json, reply_ref_json = excluded.reply_ref_json, search_mailbox = excluded.search_mailbox,
         model = excluded.model, messages_json = excluded.messages_json, message_count = excluded.message_count, updated_at = excluded.updated_at`,
    ).run({
      id,
      userId,
      title,
      titleManual: manual || c.titleManual ? 1 : 0,
      contextKey: c.contextKey ?? null,
      context: c.context ? JSON.stringify(c.context) : null,
      replyRef: c.replyRef ? JSON.stringify(c.replyRef) : null,
      search: c.searchMailbox ? 1 : 0,
      model: c.model ?? null,
      messages: JSON.stringify(c.messages),
      count: c.messages.length,
      createdAt: existing?.created_at ?? now,
      now,
    });
    return this.get(userId, id);
  },

  rename(userId: string, id: string, title: string): boolean {
    return getDb().prepare('UPDATE ai_chats SET title = ?, title_manual = 1 WHERE id = ? AND user_id = ?').run(title, id, userId).changes > 0;
  },

  remove(userId: string, id: string): boolean {
    return getDb().prepare('DELETE FROM ai_chats WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  },

  removeAll(userId: string): number {
    return getDb().prepare('DELETE FROM ai_chats WHERE user_id = ?').run(userId).changes;
  },

  /** Benutzer, die überhaupt Chats haben (für die Aufbewahrungsfrist) */
  usersWithChats(): string[] {
    return (getDb().prepare('SELECT DISTINCT user_id FROM ai_chats').all() as { user_id: string }[]).map((r) => r.user_id);
  },

  pruneUser(userId: string, days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return getDb().prepare('DELETE FROM ai_chats WHERE user_id = ? AND updated_at < ?').run(userId, cutoff).changes;
  },
};
