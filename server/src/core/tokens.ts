/**
 * Persönliche API-Tokens für die REST-API (Authorization: Bearer kvt_…).
 * Gespeichert wird nur der SHA-256-Hash; das Token ist einmalig sichtbar.
 */
import crypto from 'node:crypto';
import type { ApiScope, ApiTokenCreated, ApiTokenInfo, User } from '@kuvert/shared';
import { getDb } from './db.js';
import { uuid } from './crypto.js';
import { toUser, type UserRow } from './users.js';

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes_json: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const toInfo = (r: TokenRow): ApiTokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: JSON.parse(r.scopes_json) as ApiScope[],
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

const lastUsedWrite = new Map<string, number>();

export const apiTokens = {
  list(userId: string): ApiTokenInfo[] {
    return (getDb().prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as TokenRow[]).map(toInfo);
  },

  count(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n;
  },

  create(userId: string, name: string, scopes: ApiScope[], expiresDays?: number | null): ApiTokenCreated {
    const id = uuid();
    const prefix = `kvt_${crypto.randomBytes(4).toString('hex')}`;
    const token = `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
    const expires = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
    getDb()
      .prepare('INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, name, prefix, hash(token), JSON.stringify([...new Set(scopes)]), expires);
    return { token, info: toInfo(getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow) };
  },

  delete(userId: string, id: string): boolean {
    return getDb().prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  },

  deleteAllForUser(userId: string) {
    getDb().prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId);
  },

  /** Prüft ein Token → Benutzer + Scopes (oder undefined) */
  resolve(token: string): { user: User; tokenId: string; scopes: ApiScope[] } | undefined {
    if (!token.startsWith('kvt_')) return undefined;
    const r = getDb()
      .prepare(
        `SELECT t.id AS token_id, t.scopes_json, t.expires_at, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND u.disabled = 0`,
      )
      .get(hash(token)) as (UserRow & { token_id: string; scopes_json: string; expires_at: string | null }) | undefined;
    if (!r) return undefined;
    if (r.expires_at && r.expires_at < new Date().toISOString()) return undefined;
    const now = Date.now();
    if ((lastUsedWrite.get(r.token_id) ?? 0) < now - 60_000) {
      lastUsedWrite.set(r.token_id, now);
      getDb().prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), r.token_id);
    }
    return { user: toUser(r), tokenId: r.token_id, scopes: JSON.parse(r.scopes_json) as ApiScope[] };
  },
};
