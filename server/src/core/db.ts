import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export type DB = Database.Database;

/**
 * Schema-Migrationen. Neue Migrationen IMMER hinten anhängen, nie bestehende ändern.
 * Module können eigene Migrationen über `registerMigration` hinzufügen (siehe unten).
 */
const coreMigrations: { id: string; sql: string }[] = [
  {
    id: 'core-001-init',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        user_agent TEXT
      );
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        color TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        settings_json TEXT NOT NULL DEFAULT '{}',
        secrets_enc TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ok',
        status_message TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX accounts_user ON accounts(user_id);
      CREATE TABLE signatures (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'html',
        content TEXT NOT NULL DEFAULT '',
        account_id TEXT,
        identity_address TEXT,
        default_new INTEGER NOT NULL DEFAULT 0,
        default_reply INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        subject TEXT,
        html TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        keep_until TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE scheduled_sends (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        payload_enc TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        recipients_json TEXT NOT NULL DEFAULT '[]',
        send_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX scheduled_due ON scheduled_sends(status, send_at);
      CREATE TABLE recent_addresses (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        address TEXT NOT NULL COLLATE NOCASE,
        name TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        last_used TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, address)
      );
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope, key)
      );
    `,
  },
  {
    id: 'core-002-users-security',
    sql: `
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN avatar BLOB;
      ALTER TABLE users ADD COLUMN avatar_type TEXT;
      ALTER TABLE users ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
      ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN totp_last_counter INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN recovery_codes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN last_login_at TEXT;
      ALTER TABLE sessions ADD COLUMN ip TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen TEXT;
      ALTER TABLE sessions ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL DEFAULT '["read"]',
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        secret_enc TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_delivery_at TEXT,
        last_status INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        action TEXT NOT NULL,
        actor_id TEXT,
        user_id TEXT,
        ip TEXT,
        details_json TEXT
      );
      CREATE INDEX audit_created ON audit_log(created_at);
      CREATE INDEX audit_user ON audit_log(user_id);
    `,
  },
];

const moduleMigrations: { id: string; sql: string }[] = [];

/** Module rufen dies in ihrer `migrations`-Definition auf – wird vor dem Start angewendet. */
export function registerMigration(id: string, sql: string) {
  moduleMigrations.push({ id, sql });
}

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  db = new Database(path.join(config.dataDir, 'kuvert.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function runMigrations() {
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(d.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id as string));
  for (const m of [...coreMigrations, ...moduleMigrations]) {
    if (applied.has(m.id)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare('INSERT INTO _migrations (id) VALUES (?)').run(m.id);
    })();
  }
}

/* ───────────── Kleiner Key-Value-Store für Module (z. B. Sync-Status) ───────────── */

export const kv = {
  get<T>(scope: string, key: string): T | undefined {
    const row = getDb().prepare('SELECT value_json FROM kv WHERE scope = ? AND key = ?').get(scope, key) as
      | { value_json: string }
      | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  },
  set(scope: string, key: string, value: unknown) {
    getDb()
      .prepare(
        `INSERT INTO kv (scope, key, value_json, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(scope, key, JSON.stringify(value));
  },
  delete(scope: string, key: string) {
    getDb().prepare('DELETE FROM kv WHERE scope = ? AND key = ?').run(scope, key);
  },
  deleteScope(scope: string) {
    getDb().prepare('DELETE FROM kv WHERE scope = ?').run(scope);
  },
};
