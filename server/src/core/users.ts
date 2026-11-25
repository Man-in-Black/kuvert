import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_USER_SETTINGS,
  type AdminUser,
  type ApiScope,
  type SessionInfo,
  type User,
  type UserProfile,
  type UserSettings,
} from '@kuvert/shared';
import { config } from '../config.js';
import { getDb } from './db.js';
import { decrypt, encrypt, hashPassword, randomId, uuid, verifyPassword } from './crypto.js';
import { AppError, BadRequestError, NotFoundError } from './errors.js';
import { policies } from './policies.js';
import { hashCode } from './totp.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Angemeldeter Benutzer – auf allen nicht-öffentlichen /api-Routen gesetzt */
    user: User;
    /** Art der Anmeldung: Sitzung (Browser) oder API-Token */
    auth: { type: 'session'; sessionId: string } | { type: 'token'; tokenId: string; scopes: ApiScope[] };
  }
  interface FastifyContextConfig {
    /** Route ohne Login erreichbar */
    public?: boolean;
  }
}

export const SESSION_COOKIE = 'kuvert_session';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_admin: number;
  settings_json: string;
  disabled: number;
  must_change_password: number;
  avatar: Buffer | null;
  avatar_type: string | null;
  profile_json: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_counter: number;
  recovery_codes_json: string;
  last_login_at: string | null;
  created_at: string;
}

function avatarUrl(r: UserRow): string | null {
  if (!r.avatar) return null;
  const v = crypto.createHash('sha1').update(r.avatar).digest('hex').slice(0, 8);
  return `/api/users/${r.id}/avatar?v=${v}`;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    isAdmin: !!r.is_admin,
    twoFactorEnabled: !!r.totp_enabled,
    avatarUrl: avatarUrl(r),
    mustSetup2fa: policies.get().require2fa && !r.totp_enabled,
    mustChangePassword: !!r.must_change_password,
  };
}

const row = (id: string) => getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

export const users = {
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  },

  row,

  get(id: string): User | undefined {
    const r = row(id);
    return r ? toUser(r) : undefined;
  },

  require(id: string): UserRow {
    const r = row(id);
    if (!r) throw new NotFoundError('Benutzer');
    return r;
  },

  list(): User[] {
    return (getDb().prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser);
  },

  adminList(): AdminUser[] {
    const rows = getDb()
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS account_count,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS session_count
         FROM users u ORDER BY u.created_at`,
      )
      .all() as (UserRow & { account_count: number; session_count: number })[];
    return rows.map((r) => ({
      ...toUser(r),
      disabled: !!r.disabled,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      accountCount: r.account_count,
      sessionCount: r.session_count,
      profile: JSON.parse(r.profile_json || '{}') as UserProfile,
    }));
  },

  adminCount(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n;
  },

  async create(input: { email: string; name: string; password: string; isAdmin?: boolean; mustChangePassword?: boolean }): Promise<User> {
    if (!input.email || !input.password) throw new BadRequestError('E-Mail und Passwort erforderlich');
    if (input.password.length < 8) throw new BadRequestError('Das Passwort muss mindestens 8 Zeichen haben');
    const exists = getDb().prepare('SELECT 1 FROM users WHERE email = ?').get(input.email.trim());
    if (exists) throw new AppError(409, 'exists', 'Ein Benutzer mit dieser E-Mail existiert bereits');
    const id = uuid();
    getDb()
      .prepare('INSERT INTO users (id, email, name, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.email.trim(), input.name?.trim() || input.email, await hashPassword(input.password), input.isAdmin ? 1 : 0, input.mustChangePassword ? 1 : 0);
    return this.get(id)!;
  },

  /** Prüft E-Mail + Passwort. Deaktivierte Benutzer werden mit Fehler abgewiesen. */
  async verify(email: string, password: string): Promise<UserRow | undefined> {
    const r = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email?.trim()) as UserRow | undefined;
    if (!r) {
      await hashPassword(password || 'x'); // Timing angleichen
      return undefined;
    }
    if (!(await verifyPassword(password, r.password_hash))) return undefined;
    if (r.disabled) throw new AppError(403, 'user_disabled', 'Dieses Benutzerkonto ist deaktiviert');
    return r;
  },

  async checkPassword(id: string, password: string): Promise<boolean> {
    const r = row(id);
    return !!r && (await verifyPassword(password, r.password_hash));
  },

  async setPassword(id: string, password: string, opts: { mustChange?: boolean; keepSessionRawId?: string } = {}) {
    if (password.length < 8) throw new BadRequestError('Das Passwort muss mindestens 8 Zeichen haben');
    getDb()
      .prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?')
      .run(await hashPassword(password), opts.mustChange ? 1 : 0, id);
    // Alle anderen Sitzungen beenden
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(id, opts.keepSessionRawId ?? '');
  },

  update(id: string, patch: { name?: string; email?: string; isAdmin?: boolean; disabled?: boolean }) {
    const r = this.require(id);
    if (patch.email && patch.email.trim().toLowerCase() !== r.email.toLowerCase()) {
      const exists = getDb().prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(patch.email.trim(), id);
      if (exists) throw new AppError(409, 'exists', 'Diese E-Mail wird bereits verwendet');
    }
    getDb()
      .prepare('UPDATE users SET name = ?, email = ?, is_admin = ?, disabled = ? WHERE id = ?')
      .run(
        patch.name?.trim() || r.name,
        patch.email?.trim() || r.email,
        patch.isAdmin === undefined ? r.is_admin : patch.isAdmin ? 1 : 0,
        patch.disabled === undefined ? r.disabled : patch.disabled ? 1 : 0,
        id,
      );
    if (patch.disabled) getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return this.get(id)!;
  },

  delete(id: string) {
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  touchLogin(id: string) {
    getDb().prepare(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
  },

  /* ───────────── Profil & Avatar ───────────── */

  getProfile(id: string): UserProfile {
    return JSON.parse(this.require(id).profile_json || '{}') as UserProfile;
  },

  saveProfile(id: string, profile: UserProfile) {
    getDb().prepare('UPDATE users SET profile_json = ? WHERE id = ?').run(JSON.stringify(profile), id);
  },

  setAvatar(id: string, data: Buffer | null, type: string | null) {
    getDb().prepare('UPDATE users SET avatar = ?, avatar_type = ? WHERE id = ?').run(data, type, id);
  },

  getAvatar(id: string): { data: Buffer; type: string } | undefined {
    const r = getDb().prepare('SELECT avatar, avatar_type FROM users WHERE id = ?').get(id) as { avatar: Buffer | null; avatar_type: string | null } | undefined;
    return r?.avatar ? { data: r.avatar, type: r.avatar_type ?? 'image/png' } : undefined;
  },

  /* ───────────── Zwei-Faktor ───────────── */

  totp(id: string): { secret?: string; enabled: boolean; lastCounter: number; recovery: string[] } {
    const r = this.require(id);
    return {
      secret: r.totp_secret_enc ? decrypt(r.totp_secret_enc) : undefined,
      enabled: !!r.totp_enabled,
      lastCounter: r.totp_last_counter,
      recovery: JSON.parse(r.recovery_codes_json || '[]') as string[],
    };
  },

  enableTotp(id: string, secret: string, recoveryCodes: string[]) {
    getDb()
      .prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_counter = 0, recovery_codes_json = ? WHERE id = ?')
      .run(encrypt(secret), JSON.stringify(recoveryCodes.map(hashCode)), id);
  },

  disableTotp(id: string) {
    getDb().prepare(`UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_counter = 0, recovery_codes_json = '[]' WHERE id = ?`).run(id);
  },

  setTotpCounter(id: string, counter: number) {
    getDb().prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, id);
  },

  setRecoveryCodes(id: string, codes: string[]) {
    getDb().prepare('UPDATE users SET recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(codes.map(hashCode)), id);
  },

  /** Verbraucht einen Wiederherstellungscode (einmalig gültig) */
  consumeRecoveryCode(id: string, code: string): boolean {
    const t = this.totp(id);
    const h = hashCode(code);
    if (!t.recovery.includes(h)) return false;
    getDb().prepare('UPDATE users SET recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(t.recovery.filter((x) => x !== h)), id);
    return true;
  },

  /* ───────────── Einstellungen ───────────── */

  getSettings(id: string): UserSettings {
    const r = getDb().prepare('SELECT settings_json FROM users WHERE id = ?').get(id) as { settings_json: string } | undefined;
    const stored = r ? (JSON.parse(r.settings_json || '{}') as Partial<UserSettings>) : {};
    return {
      ...DEFAULT_USER_SETTINGS,
      ...stored,
      notifications: { ...DEFAULT_USER_SETTINGS.notifications, ...(stored.notifications ?? {}) },
      ai: { ...DEFAULT_USER_SETTINGS.ai, ...(stored.ai ?? {}) },
    };
  },

  saveSettings(id: string, patch: Partial<UserSettings>): UserSettings {
    const current = this.getSettings(id);
    const next: UserSettings = {
      ...current,
      ...patch,
      notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
      ai: { ...current.ai, ...(patch.ai ?? {}) },
      modules: { ...(current.modules ?? {}), ...(patch.modules ?? {}) },
    };
    getDb().prepare('UPDATE users SET settings_json = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  },
};

/* ───────────────────────────── Sessions ───────────────────────────── */

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  user_agent: string | null;
  ip: string | null;
  last_seen: string | null;
  two_factor: number;
}

const publicSessionId = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
const lastTouch = new Map<string, number>();

export const sessions = {
  create(reply: FastifyReply, req: FastifyRequest, userId: string, opts: { twoFactor?: boolean } = {}) {
    const id = randomId(32);
    const days = policies.get().sessionDays || config.sessionDays;
    const expires = new Date(Date.now() + days * 86_400_000);
    getDb()
      .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent, ip, last_seen, two_factor) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, expires.toISOString(), req.headers['user-agent'] ?? null, req.ip ?? null, new Date().toISOString(), opts.twoFactor ? 1 : 0);
    users.touchLogin(userId);
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      expires,
      signed: true,
    });
    return id;
  },

  rawId(req: FastifyRequest): string | undefined {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  },

  /** Benutzer + Sitzungs-ID aus dem Cookie (aktualisiert "zuletzt gesehen" höchstens alle 5 Min.) */
  resolveWithId(req: FastifyRequest): { user: User; sessionId: string } | undefined {
    const id = this.rawId(req);
    if (!id) return undefined;
    const r = getDb()
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND u.disabled = 0`,
      )
      .get(id) as UserRow | undefined;
    if (!r) return undefined;
    const now = Date.now();
    if ((lastTouch.get(id) ?? 0) < now - 300_000) {
      lastTouch.set(id, now);
      getDb().prepare('UPDATE sessions SET last_seen = ?, ip = ? WHERE id = ?').run(new Date(now).toISOString(), req.ip ?? null, id);
    }
    return { user: toUser(r), sessionId: id };
  },

  resolve(req: FastifyRequest): User | undefined {
    return this.resolveWithId(req)?.user;
  },

  list(userId: string, currentRawId?: string): SessionInfo[] {
    const rows = getDb()
      .prepare(`SELECT * FROM sessions WHERE user_id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY COALESCE(last_seen, created_at) DESC`)
      .all(userId) as SessionRow[];
    return rows.map((s) => ({
      id: publicSessionId(s.id),
      userAgent: s.user_agent,
      ip: s.ip,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen,
      expiresAt: s.expires_at,
      current: s.id === currentRawId,
      twoFactor: !!s.two_factor,
    }));
  },

  revoke(userId: string, publicId: string): boolean {
    const rows = getDb().prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as { id: string }[];
    const match = rows.find((r) => publicSessionId(r.id) === publicId);
    if (!match) return false;
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(match.id);
    return true;
  },

  revokeAll(userId: string, exceptRawId?: string) {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptRawId ?? '');
  },

  activeCount(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get() as { n: number }).n;
  },

  destroy(req: FastifyRequest, reply: FastifyReply) {
    const id = this.rawId(req);
    if (id) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  },

  cleanup() {
    getDb().prepare(`DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run();
  },
};
