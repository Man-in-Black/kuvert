/** Konfiguration: Admin-Standard (URL, aktiv) und persönliche API-Tokens der Benutzer. */
import type { PaperlessAdminConfig, PaperlessUserConfig } from '@kuvert/shared';
import { getDb, kv } from '../../core/db.js';
import { decrypt, encrypt } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { PaperlessClient } from './client.js';

export const migrations = [
  {
    id: 'paperless-001',
    sql: `
      CREATE TABLE paperless_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        base_url TEXT,
        token_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];

interface CredRow {
  user_id: string;
  base_url: string | null;
  token_enc: string;
}

export const adminConfig = {
  get(): PaperlessAdminConfig {
    const stored = kv.get<Partial<PaperlessAdminConfig>>('paperless', 'admin');
    const envUrl = process.env.PAPERLESS_URL ?? '';
    return {
      enabled: stored?.enabled ?? !!envUrl,
      baseUrl: stored?.baseUrl ?? envUrl,
    };
  },
  set(cfg: PaperlessAdminConfig) {
    kv.set('paperless', 'admin', cfg);
  },
};

const disabled = () => new AppError(403, 'paperless_disabled', 'Die Paperless-Anbindung ist vom Administrator deaktiviert');

export const credentials = {
  row(userId: string): CredRow | undefined {
    return getDb().prepare('SELECT * FROM paperless_credentials WHERE user_id = ?').get(userId) as CredRow | undefined;
  },

  info(userId: string): PaperlessUserConfig {
    const admin = adminConfig.get();
    const r = this.row(userId);
    const token = r ? decrypt(r.token_enc) : null;
    return {
      enabled: admin.enabled,
      configured: !!r,
      baseUrl: r?.base_url || admin.baseUrl || null,
      overrideUrl: r?.base_url || null,
      defaultBaseUrl: admin.baseUrl || null,
      tokenHint: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : null,
    };
  },

  save(userId: string, token: string, baseUrl: string | null) {
    getDb()
      .prepare(
        `INSERT INTO paperless_credentials (user_id, base_url, token_enc) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, token_enc = excluded.token_enc,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(userId, baseUrl, encrypt(token));
  },

  token(userId: string): string | undefined {
    const r = this.row(userId);
    return r ? decrypt(r.token_enc) : undefined;
  },

  delete(userId: string) {
    getDb().prepare('DELETE FROM paperless_credentials WHERE user_id = ?').run(userId);
  },

  /** API-Client des Benutzers (wirft verständliche Fehler, wenn nicht eingerichtet) */
  client(userId: string): PaperlessClient {
    const admin = adminConfig.get();
    if (!admin.enabled) throw disabled();
    const r = this.row(userId);
    if (!r) throw new AppError(409, 'paperless_not_configured', 'Bitte zuerst einen Paperless-API-Token hinterlegen (Einstellungen → Paperless)');
    const url = r.base_url || admin.baseUrl;
    if (!url) throw new AppError(409, 'paperless_not_configured', 'Keine URL von Paperless konfiguriert');
    return new PaperlessClient(url, decrypt(r.token_enc));
  },

  disabled,
};
