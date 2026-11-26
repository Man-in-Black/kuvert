/** Konfiguration der 3CX-Anbindung: Admin-Zugang (verschlüsselt) und Nebenstellen der Benutzer. */
import type { ThreeCxAdminConfig } from '@kuvert/shared';
import { getDb, kv } from '../../core/db.js';
import { decrypt, encrypt } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { ThreeCxClient } from './client.js';

export const migrations = [
  {
    id: 'threecx-001',
    sql: `
      CREATE TABLE threecx_extensions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        extension TEXT NOT NULL,
        device_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];

interface StoredConfig {
  enabled: boolean;
  baseUrl: string;
  clientId: string;
  secretEnc?: string | null;
  plusPrefix?: string;
}

function stored(): StoredConfig {
  const s = kv.get<StoredConfig>('threecx', 'admin');
  return {
    // Vollständig per Umgebung vorbelegt = aktiv, bis der Admin etwas anderes speichert
    enabled: s?.enabled ?? !!(process.env.THREECX_URL && process.env.THREECX_CLIENT_ID && process.env.THREECX_API_KEY),
    baseUrl: s?.baseUrl ?? process.env.THREECX_URL ?? '',
    clientId: s?.clientId ?? process.env.THREECX_CLIENT_ID ?? '',
    secretEnc: s?.secretEnc ?? (process.env.THREECX_API_KEY ? encrypt(process.env.THREECX_API_KEY) : null),
    plusPrefix: s?.plusPrefix ?? '',
  };
}

export const adminConfig = {
  get(): ThreeCxAdminConfig {
    const s = stored();
    return { enabled: s.enabled, baseUrl: s.baseUrl, clientId: s.clientId, secretConfigured: !!s.secretEnc, plusPrefix: s.plusPrefix ?? '' };
  },

  /** secret: undefined = unverändert lassen */
  set(cfg: { enabled: boolean; baseUrl: string; clientId: string; plusPrefix: string; secret?: string }) {
    const prev = stored();
    kv.set('threecx', 'admin', {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      clientId: cfg.clientId,
      plusPrefix: cfg.plusPrefix,
      secretEnc: cfg.secret ? encrypt(cfg.secret) : (prev.secretEnc ?? null),
    } satisfies StoredConfig);
  },

  secret(): string | null {
    const enc = stored().secretEnc;
    return enc ? decrypt(enc) : null;
  },

  /** Vollständig eingerichtet (Adresse, Client-ID, Schlüssel)? */
  ready(): boolean {
    const c = this.get();
    return c.enabled && !!c.baseUrl && !!c.clientId && c.secretConfigured;
  },

  client(override?: { baseUrl?: string; clientId?: string; secret?: string }): ThreeCxClient {
    const c = this.get();
    const baseUrl = override?.baseUrl || c.baseUrl;
    const clientId = override?.clientId || c.clientId;
    const secret = override?.secret || this.secret();
    if (!baseUrl || !clientId || !secret) throw new AppError(409, 'threecx_not_configured', '3CX-Anbindung ist nicht vollständig eingerichtet');
    return new ThreeCxClient(baseUrl, clientId, secret);
  },
};

interface ExtRow {
  user_id: string;
  extension: string;
  device_id: string | null;
}

export const extensions = {
  get(userId: string): ExtRow | undefined {
    return getDb().prepare('SELECT user_id, extension, device_id FROM threecx_extensions WHERE user_id = ?').get(userId) as ExtRow | undefined;
  },

  all(): ExtRow[] {
    return getDb().prepare('SELECT user_id, extension, device_id FROM threecx_extensions').all() as ExtRow[];
  },

  /** Nebenstelle setzen (null = Zuordnung entfernen); bei Wechsel das bevorzugte Gerät verwerfen */
  set(userId: string, extension: string | null) {
    if (!extension) {
      getDb().prepare('DELETE FROM threecx_extensions WHERE user_id = ?').run(userId);
      return;
    }
    getDb()
      .prepare(
        `INSERT INTO threecx_extensions (user_id, extension) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           device_id = CASE WHEN threecx_extensions.extension = excluded.extension THEN threecx_extensions.device_id ELSE NULL END,
           extension = excluded.extension,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(userId, extension);
  },

  setDevice(userId: string, deviceId: string | null) {
    getDb()
      .prepare(`UPDATE threecx_extensions SET device_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?`)
      .run(deviceId, userId);
  },
};
