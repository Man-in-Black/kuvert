/**
 * Datenhaltung der KI-Triage. Schlüssel ist (Benutzer, Konto, Ordner, Nachricht) –
 * bei IMAP sind Nachrichten-IDs nur je Ordner eindeutig. Zusätzlich wird die
 * Message-ID (Header) gespeichert, damit die Einordnung nach dem Verschieben in
 * einen anderen Ordner (neue UID bzw. neue Graph-ID) wiedergefunden wird.
 */
import type { MessageSummary, TriageFailure, TriageInfo, TriagePriority } from '@kuvert/shared';
import { getDb } from '../../core/db.js';

const ISO_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const migrations = [
  {
    id: 'triage-001',
    sql: `
      CREATE TABLE triage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_id_header TEXT,
        priority TEXT NOT NULL,
        category TEXT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'ai',
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        PRIMARY KEY (user_id, account_id, folder_id, message_id)
      );
      CREATE INDEX triage_header ON triage(user_id, account_id, message_id_header);
      CREATE INDEX triage_created ON triage(created_at);
    `,
  },
  {
    id: 'triage-002-failed',
    sql: `
      CREATE TABLE triage_failed (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        subject TEXT,
        sender TEXT,
        error TEXT NOT NULL,
        failed_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        PRIMARY KEY (user_id, account_id, folder_id, message_id)
      );
      CREATE INDEX triage_failed_at ON triage_failed(failed_at);
    `,
  },
  {
    id: 'triage-003-done',
    sql: `ALTER TABLE triage ADD COLUMN done INTEGER NOT NULL DEFAULT 0;`,
  },
];

interface Row {
  account_id: string;
  folder_id: string;
  message_id: string;
  priority: string;
  category: string;
  reason: string | null;
  source: string;
  done: number;
  created_at: string;
}

export interface TriageKey {
  userId: string;
  accountId: string;
  folderId: string;
  messageId: string;
}

const toInfo = (r: Row): TriageInfo => ({
  priority: r.priority as TriagePriority,
  category: r.category,
  reason: r.reason || undefined,
  source: r.source === 'manual' ? 'manual' : 'ai',
  ...(r.done ? { done: true } : {}),
  at: r.created_at,
});

export const refKey = (accountId: string, folderId: string, messageId: string) => `${accountId}\u0000${folderId}\u0000${messageId}`;

export const triageStore = {
  get(k: TriageKey): TriageInfo | undefined {
    const row = getDb()
      .prepare('SELECT * FROM triage WHERE user_id = ? AND account_id = ? AND folder_id = ? AND message_id = ?')
      .get(k.userId, k.accountId, k.folderId, k.messageId) as Row | undefined;
    return row ? toInfo(row) : undefined;
  },

  /** Einordnungen für eine Liste; Treffer zuerst über die ID, sonst über den Message-ID-Header */
  lookup(userId: string, items: Pick<MessageSummary, 'accountId' | 'folderId' | 'id' | 'messageIdHeader'>[]): Map<string, TriageInfo> {
    const out = new Map<string, TriageInfo>();
    if (!items.length) return out;
    const db = getDb();
    const byId = db.prepare('SELECT * FROM triage WHERE user_id = ? AND account_id = ? AND folder_id = ? AND message_id = ?');
    const byHeader = db.prepare('SELECT * FROM triage WHERE user_id = ? AND account_id = ? AND message_id_header = ? ORDER BY created_at DESC LIMIT 1');
    for (const m of items) {
      let row = byId.get(userId, m.accountId, m.folderId, m.id) as Row | undefined;
      if (!row && m.messageIdHeader) row = byHeader.get(userId, m.accountId, m.messageIdHeader) as Row | undefined;
      if (row) out.set(refKey(m.accountId, m.folderId, m.id), toInfo(row));
    }
    return out;
  },

  set(
    k: TriageKey & { messageIdHeader?: string | null },
    info: { priority: TriagePriority; category: string; reason?: string; source: 'ai' | 'manual'; model?: string; done?: boolean },
  ): TriageInfo {
    const row = getDb()
      .prepare(
        `INSERT INTO triage (user_id, account_id, folder_id, message_id, message_id_header, priority, category, reason, source, model, done, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ISO_NOW})
         ON CONFLICT (user_id, account_id, folder_id, message_id) DO UPDATE SET
           message_id_header = COALESCE(excluded.message_id_header, triage.message_id_header),
           priority = excluded.priority, category = excluded.category, reason = excluded.reason,
           source = excluded.source, model = excluded.model, done = excluded.done,
           created_at = excluded.created_at
         RETURNING *`,
      )
      .get(
        k.userId,
        k.accountId,
        k.folderId,
        k.messageId,
        k.messageIdHeader || null,
        info.priority,
        info.category,
        info.reason || null,
        info.source,
        info.model || null,
        info.done ? 1 : 0,
      ) as Row;
    return toInfo(row);
  },

  remove(k: TriageKey & { messageIdHeader?: string | null }) {
    const db = getDb();
    db.prepare('DELETE FROM triage WHERE user_id = ? AND account_id = ? AND folder_id = ? AND message_id = ?').run(k.userId, k.accountId, k.folderId, k.messageId);
    if (k.messageIdHeader) db.prepare('DELETE FROM triage WHERE user_id = ? AND account_id = ? AND message_id_header = ?').run(k.userId, k.accountId, k.messageIdHeader);
  },

  removeAccount(accountId: string) {
    getDb().prepare('DELETE FROM triage WHERE account_id = ?').run(accountId);
  },

  /** Alte Einordnungen entfernen (Nachrichten sind dann meist längst archiviert/gelöscht) */
  prune(maxAgeDays: number): number {
    return getDb().prepare(`DELETE FROM triage WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).run(`-${maxAgeDays} days`).changes;
  },

  stats(userId: string): { total: number; byPriority: Record<string, number> } {
    const rows = getDb().prepare('SELECT priority, COUNT(*) AS n FROM triage WHERE user_id = ? GROUP BY priority').all(userId) as { priority: string; n: number }[];
    const byPriority: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byPriority[r.priority] = r.n;
      total += r.n;
    }
    return { total, byPriority };
  },
};

/* ───────────── Fehlgeschlagene Einordnungen (zum späteren Wiederholen) ───────────── */

interface FailedRow {
  account_id: string;
  folder_id: string;
  message_id: string;
  subject: string | null;
  sender: string | null;
  error: string;
  failed_at: string;
}

const toFailure = (r: FailedRow): TriageFailure => ({
  accountId: r.account_id,
  folderId: r.folder_id,
  messageId: r.message_id,
  subject: r.subject ?? undefined,
  from: r.sender ?? undefined,
  error: r.error,
  failedAt: r.failed_at,
});

export const failedStore = {
  record(k: TriageKey, info: { error: string; subject?: string; from?: string }) {
    getDb()
      .prepare(
        `INSERT INTO triage_failed (user_id, account_id, folder_id, message_id, subject, sender, error, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${ISO_NOW})
         ON CONFLICT (user_id, account_id, folder_id, message_id) DO UPDATE SET
           subject = COALESCE(excluded.subject, triage_failed.subject),
           sender = COALESCE(excluded.sender, triage_failed.sender),
           error = excluded.error, failed_at = excluded.failed_at`,
      )
      .run(k.userId, k.accountId, k.folderId, k.messageId, info.subject?.slice(0, 300) || null, info.from?.slice(0, 300) || null, info.error.slice(0, 500));
  },

  remove(k: TriageKey) {
    getDb()
      .prepare('DELETE FROM triage_failed WHERE user_id = ? AND account_id = ? AND folder_id = ? AND message_id = ?')
      .run(k.userId, k.accountId, k.folderId, k.messageId);
  },

  list(userId: string, limit = 1000): TriageFailure[] {
    return (getDb().prepare('SELECT * FROM triage_failed WHERE user_id = ? ORDER BY failed_at DESC LIMIT ?').all(userId, limit) as FailedRow[]).map(toFailure);
  },

  count(userId: string): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM triage_failed WHERE user_id = ?').get(userId) as { n: number }).n;
  },

  clear(userId: string): number {
    return getDb().prepare('DELETE FROM triage_failed WHERE user_id = ?').run(userId).changes;
  },

  removeAccount(accountId: string) {
    getDb().prepare('DELETE FROM triage_failed WHERE account_id = ?').run(accountId);
  },

  prune(maxAgeDays: number): number {
    return getDb().prepare(`DELETE FROM triage_failed WHERE failed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).run(`-${maxAgeDays} days`).changes;
  },
};
