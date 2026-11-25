/** Persistenz: mailcow-Instanzen (Admin) und Verknüpfungen Benutzer ↔ Postfach. */
import type { MailcowInstanceInfo, MailcowLink } from '@kuvert/shared';
import { getDb } from '../../core/db.js';
import { decrypt, encrypt, uuid } from '../../core/crypto.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { MailcowClient } from './client.js';

export const migrations = [
  {
    id: 'mailcow-001',
    sql: `
      CREATE TABLE mailcow_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE mailcow_links (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        instance_id TEXT NOT NULL REFERENCES mailcow_instances(id) ON DELETE CASCADE,
        mailbox TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (user_id, instance_id, mailbox)
      );
    `,
  },
];

interface InstanceRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string;
  created_at: string;
}

/** Normalisiert die Basis-URL (https ergänzen, /api und Schrägstriche entfernen) */
export function normalizeBaseUrl(v: string): string {
  let s = (v ?? '').trim();
  if (!s) throw new BadRequestError('URL der mailcow-Instanz fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/(api(\/v1)?\/?)?$/i, '').replace(/\/+$/, '')}`;
  } catch {
    throw new BadRequestError('URL der mailcow-Instanz ist ungültig');
  }
}

export function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

const toInfo = (r: InstanceRow): MailcowInstanceInfo => {
  const key = decrypt(r.api_key_enc);
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    hostname: hostnameOf(r.base_url),
    keyHint: key.length > 4 ? `…${key.slice(-4)}` : '…',
    createdAt: r.created_at,
  };
};

export const instances = {
  list(): MailcowInstanceInfo[] {
    return (getDb().prepare('SELECT * FROM mailcow_instances ORDER BY created_at').all() as InstanceRow[]).map(toInfo);
  },

  get(id: string): MailcowInstanceInfo {
    const r = getDb().prepare('SELECT * FROM mailcow_instances WHERE id = ?').get(id) as InstanceRow | undefined;
    if (!r) throw new NotFoundError('mailcow-Instanz');
    return toInfo(r);
  },

  findByHost(host: string): MailcowInstanceInfo | undefined {
    const h = host.trim().toLowerCase();
    return this.list().find((i) => i.hostname.toLowerCase() === h);
  },

  client(id: string): MailcowClient {
    const r = getDb().prepare('SELECT * FROM mailcow_instances WHERE id = ?').get(id) as InstanceRow | undefined;
    if (!r) throw new NotFoundError('mailcow-Instanz');
    return new MailcowClient(r.base_url, decrypt(r.api_key_enc));
  },

  create(input: { name: string; baseUrl: string; apiKey: string }): MailcowInstanceInfo {
    const id = uuid();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    getDb()
      .prepare('INSERT INTO mailcow_instances (id, name, base_url, api_key_enc) VALUES (?, ?, ?, ?)')
      .run(id, input.name.trim() || hostnameOf(baseUrl), baseUrl, encrypt(input.apiKey.trim()));
    return this.get(id);
  },

  update(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }): MailcowInstanceInfo {
    const r = getDb().prepare('SELECT * FROM mailcow_instances WHERE id = ?').get(id) as InstanceRow | undefined;
    if (!r) throw new NotFoundError('mailcow-Instanz');
    getDb()
      .prepare('UPDATE mailcow_instances SET name = ?, base_url = ?, api_key_enc = ? WHERE id = ?')
      .run(
        patch.name?.trim() || r.name,
        patch.baseUrl ? normalizeBaseUrl(patch.baseUrl) : r.base_url,
        patch.apiKey?.trim() ? encrypt(patch.apiKey.trim()) : r.api_key_enc,
        id,
      );
    return this.get(id);
  },

  delete(id: string) {
    getDb().prepare('DELETE FROM mailcow_instances WHERE id = ?').run(id);
  },
};

export const links = {
  forUser(userId: string): MailcowLink[] {
    return (
      getDb()
        .prepare(
          `SELECT l.user_id, l.instance_id, l.mailbox, l.created_at, i.name AS instance_name FROM mailcow_links l
           JOIN mailcow_instances i ON i.id = l.instance_id WHERE l.user_id = ? ORDER BY l.mailbox`,
        )
        .all(userId) as { user_id: string; instance_id: string; mailbox: string; created_at: string; instance_name: string }[]
    ).map((r) => ({ userId: r.user_id, instanceId: r.instance_id, instanceName: r.instance_name, mailbox: r.mailbox, createdAt: r.created_at }));
  },

  all(): MailcowLink[] {
    return (
      getDb()
        .prepare(
          `SELECT l.*, i.name AS instance_name, u.email AS user_email FROM mailcow_links l
           JOIN mailcow_instances i ON i.id = l.instance_id JOIN users u ON u.id = l.user_id ORDER BY u.email, l.mailbox`,
        )
        .all() as { user_id: string; instance_id: string; mailbox: string; created_at: string; instance_name: string; user_email: string }[]
    ).map((r) => ({
      userId: r.user_id,
      userEmail: r.user_email,
      instanceId: r.instance_id,
      instanceName: r.instance_name,
      mailbox: r.mailbox,
      createdAt: r.created_at,
    }));
  },

  add(userId: string, instanceId: string, mailbox: string) {
    getDb().prepare('INSERT OR IGNORE INTO mailcow_links (user_id, instance_id, mailbox) VALUES (?, ?, ?)').run(userId, instanceId, mailbox.trim().toLowerCase());
  },

  remove(userId: string, instanceId: string, mailbox: string) {
    getDb().prepare('DELETE FROM mailcow_links WHERE user_id = ? AND instance_id = ? AND mailbox = ?').run(userId, instanceId, mailbox);
  },

  has(userId: string, instanceId: string, mailbox: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM mailcow_links WHERE user_id = ? AND instance_id = ? AND mailbox = ?').get(userId, instanceId, mailbox);
  },
};
