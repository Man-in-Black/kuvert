/** Konfiguration: Admin-Standard (URL, aktiv) und persönliche API-Schlüssel der Benutzer. */
import type { ArchiverAdminConfig, ArchiverUserConfig } from '@kuvert/shared';
import { getDb, kv } from '../../core/db.js';
import { decrypt, encrypt } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { ArchiverClient } from './client.js';

export const migrations = [
  {
    id: 'mailarchiver-001',
    sql: `
      CREATE TABLE mailarchiver_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        base_url TEXT,
        api_key_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];

interface CredRow {
  user_id: string;
  base_url: string | null;
  api_key_enc: string;
}

export const adminConfig = {
  get(): ArchiverAdminConfig {
    const stored = kv.get<Partial<ArchiverAdminConfig>>('mailarchiver', 'admin');
    const envUrl = process.env.MAILARCHIVER_URL ?? '';
    return {
      enabled: stored?.enabled ?? !!envUrl,
      baseUrl: stored?.baseUrl ?? envUrl,
    };
  },
  set(cfg: ArchiverAdminConfig) {
    kv.set('mailarchiver', 'admin', cfg);
  },
};

export const credentials = {
  row(userId: string): CredRow | undefined {
    return getDb().prepare('SELECT * FROM mailarchiver_credentials WHERE user_id = ?').get(userId) as CredRow | undefined;
  },

  info(userId: string): ArchiverUserConfig {
    const admin = adminConfig.get();
    const r = this.row(userId);
    const key = r ? decrypt(r.api_key_enc) : null;
    return {
      enabled: admin.enabled,
      configured: !!r,
      baseUrl: r?.base_url || admin.baseUrl || null,
      overrideUrl: r?.base_url || null,
      defaultBaseUrl: admin.baseUrl || null,
      keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
    };
  },

  save(userId: string, apiKey: string, baseUrl: string | null) {
    getDb()
      .prepare(
        `INSERT INTO mailarchiver_credentials (user_id, base_url, api_key_enc) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, api_key_enc = excluded.api_key_enc,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(userId, baseUrl, encrypt(apiKey));
  },

  apiKey(userId: string): string | undefined {
    const r = this.row(userId);
    return r ? decrypt(r.api_key_enc) : undefined;
  },

  delete(userId: string) {
    getDb().prepare('DELETE FROM mailarchiver_credentials WHERE user_id = ?').run(userId);
  },

  /** API-Client des Benutzers (wirft verständliche Fehler, wenn nicht eingerichtet) */
  client(userId: string): ArchiverClient {
    const admin = adminConfig.get();
    if (!admin.enabled) throw new AppError(403, 'archiver_disabled', 'Die Mail-Archiver-Anbindung ist vom Administrator deaktiviert');
    const r = this.row(userId);
    if (!r) throw new AppError(409, 'archiver_not_configured', 'Bitte zuerst einen Mail-Archiver-API-Schlüssel hinterlegen');
    const url = r.base_url || admin.baseUrl;
    if (!url) throw new AppError(409, 'archiver_not_configured', 'Keine URL des Mail-Archivers konfiguriert');
    return new ArchiverClient(url, decrypt(r.api_key_enc));
  },
};
