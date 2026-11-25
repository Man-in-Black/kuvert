import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppInfo, LoginResult, TwoFactorSetup, TwoFactorStatus } from '@kuvert/shared';
import { config } from '../config.js';
import { audit } from '../core/audit.js';
import { randomId } from '../core/crypto.js';
import { AppError, BadRequestError } from '../core/errors.js';
import type { ModuleContext } from '../core/module.js';
import { policies } from '../core/policies.js';
import { generateRecoveryCodes, generateSecret, otpauthUrl, verifyTotp } from '../core/totp.js';
import { sessions, toUser, users } from '../core/users.js';
import { parse } from './util.js';

const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });
const registration = z.object({ email: z.string().email(), name: z.string().min(1).max(200), password: z.string().min(8) });

/** Kurzlebige Tickets zwischen Passwort- und 2FA-Schritt */
const loginTickets = new Map<string, { userId: string; created: number; attempts: number }>();
/** Noch nicht bestätigte 2FA-Geheimnisse während der Einrichtung */
const pendingSecrets = new Map<string, { secret: string; created: number }>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of loginTickets) if (v.created < cutoff) loginTickets.delete(k);
  for (const [k, v] of pendingSecrets) if (v.created < cutoff) pendingSecrets.delete(k);
}, 60_000).unref();

/** Prüft TOTP-Code oder Wiederherstellungscode */
function checkSecondFactor(userId: string, code: string): 'totp' | 'recovery' | null {
  const t = users.totp(userId);
  if (!t.enabled || !t.secret) return null;
  const counter = verifyTotp(t.secret, code, t.lastCounter);
  if (counter !== null) {
    users.setTotpCounter(userId, counter);
    return 'totp';
  }
  if (/[a-z0-9]{5}-?[a-z0-9]{5}/i.test(code.trim()) && users.consumeRecoveryCode(userId, code)) return 'recovery';
  return null;
}

export async function authRoutes(app: FastifyInstance, ctx: ModuleContext) {
  app.get('/api/app', { config: { public: true } }, async (req): Promise<AppInfo> => {
    const user = sessions.resolve(req) ?? null;
    const p = policies.get();
    return {
      name: config.appName,
      version: config.version,
      setupRequired: users.count() === 0,
      allowRegistration: p.allowRegistration,
      user,
      modules: ctx.registry.listModules(),
      accountTypes: user ? ctx.registry.listAccountTypes().filter((t) => policies.accountTypeAllowed(t.type)) : [],
      features: ctx.registry.features(),
      vapidPublicKey: (ctx.kv.get<string>('push', 'vapidPublicKey') ?? config.vapid.publicKey) || null,
      publicUrl: config.publicUrl,
      policies: { require2fa: p.require2fa, usersCanCreateApiTokens: p.usersCanCreateApiTokens },
      apiDocsUrl: '/api/docs',
    };
  });

  /** Ersteinrichtung: erster Benutzer wird Administrator */
  app.post('/api/auth/setup', { config: { public: true } }, async (req, reply) => {
    if (users.count() > 0) throw new AppError(409, 'already_setup', 'Kuvert ist bereits eingerichtet');
    const body = parse(registration, req.body);
    const user = await users.create({ ...body, isAdmin: true });
    sessions.create(reply, req, user.id);
    audit.log('auth.setup', { req, actorId: user.id });
    return { user } satisfies LoginResult;
  });

  /** Schritt 1: Passwort. Mit aktiver 2FA folgt Schritt 2 (/api/auth/login/2fa). */
  app.post('/api/auth/login', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply): Promise<LoginResult> => {
    const body = parse(credentials, req.body);
    const row = await users.verify(body.email, body.password);
    if (!row) {
      audit.log('auth.login_failed', { req, actorId: null, details: { email: body.email } });
      throw new AppError(401, 'invalid_credentials', 'E-Mail oder Passwort falsch');
    }
    if (row.totp_enabled) {
      const ticket = randomId(24);
      loginTickets.set(ticket, { userId: row.id, created: Date.now(), attempts: 0 });
      return { twoFactorRequired: true, ticket };
    }
    sessions.create(reply, req, row.id);
    audit.log('auth.login', { req, actorId: row.id });
    return { user: toUser(row) };
  });

  app.post('/api/auth/login/2fa', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply): Promise<LoginResult> => {
    const body = parse(z.object({ ticket: z.string(), code: z.string().min(6).max(20) }), req.body);
    const t = loginTickets.get(body.ticket);
    if (!t || t.created < Date.now() - 5 * 60_000) {
      loginTickets.delete(body.ticket);
      throw new AppError(401, 'ticket_expired', 'Anmeldung abgelaufen – bitte erneut mit Passwort anmelden');
    }
    const method = checkSecondFactor(t.userId, body.code);
    if (!method) {
      if (++t.attempts >= 5) loginTickets.delete(body.ticket);
      audit.log('auth.2fa_failed', { req, actorId: t.userId });
      throw new AppError(401, 'invalid_code', 'Code ungültig');
    }
    loginTickets.delete(body.ticket);
    sessions.create(reply, req, t.userId, { twoFactor: true });
    audit.log('auth.login', { req, actorId: t.userId, details: { twoFactor: method } });
    return { user: users.get(t.userId)! };
  });

  app.post('/api/auth/register', { config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!policies.get().allowRegistration) throw new AppError(403, 'registration_disabled', 'Registrierung ist deaktiviert');
    const body = parse(registration, req.body);
    const user = await users.create(body);
    sessions.create(reply, req, user.id);
    audit.log('auth.register', { req, actorId: user.id });
    return { user } satisfies LoginResult;
  });

  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    sessions.destroy(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => req.user);

  app.post('/api/auth/password', async (req) => {
    const body = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
    if (!(await users.checkPassword(req.user.id, body.current))) throw new AppError(400, 'invalid_password', 'Aktuelles Passwort ist falsch');
    if (body.current === body.next) throw new BadRequestError('Das neue Passwort muss sich vom alten unterscheiden');
    await users.setPassword(req.user.id, body.next, { keepSessionRawId: req.auth.type === 'session' ? req.auth.sessionId : undefined });
    audit.log('auth.password_changed', { req });
    return { ok: true };
  });

  /* ═════════════════════════════ Zwei-Faktor ═════════════════════════════ */

  app.get('/api/auth/2fa', async (req): Promise<TwoFactorStatus> => {
    const t = users.totp(req.user.id);
    return { enabled: t.enabled, recoveryCodesLeft: t.recovery.length, required: policies.get().require2fa };
  });

  /** Neues Geheimnis + QR-Code erzeugen (noch nicht aktiv) */
  app.post('/api/auth/2fa/setup', async (req): Promise<TwoFactorSetup> => {
    if (users.totp(req.user.id).enabled) throw new BadRequestError('2FA ist bereits aktiv – zuerst deaktivieren');
    const secret = generateSecret();
    pendingSecrets.set(req.user.id, { secret, created: Date.now() });
    const url = otpauthUrl(secret, req.user.email, config.appName);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, otpauthUrl: url, qrSvg };
  });

  /** Einrichtung mit erstem Code bestätigen → Wiederherstellungscodes (einmalig sichtbar) */
  app.post('/api/auth/2fa/enable', async (req) => {
    const body = parse(z.object({ code: z.string() }), req.body);
    const pending = pendingSecrets.get(req.user.id);
    if (!pending) throw new BadRequestError('Bitte die Einrichtung neu starten');
    const counter = verifyTotp(pending.secret, body.code);
    if (counter === null) throw new AppError(400, 'invalid_code', 'Code ungültig – Uhrzeit des Geräts prüfen');
    const codes = generateRecoveryCodes();
    users.enableTotp(req.user.id, pending.secret, codes);
    users.setTotpCounter(req.user.id, counter);
    pendingSecrets.delete(req.user.id);
    audit.log('auth.2fa_enabled', { req });
    return { ok: true, recoveryCodes: codes };
  });

  app.post('/api/auth/2fa/disable', async (req) => {
    const body = parse(z.object({ password: z.string(), code: z.string().optional() }), req.body);
    if (policies.get().require2fa) throw new AppError(403, 'policy', '2FA ist per Richtlinie vorgeschrieben und kann nicht deaktiviert werden');
    if (!(await users.checkPassword(req.user.id, body.password))) throw new AppError(400, 'invalid_password', 'Passwort ist falsch');
    users.disableTotp(req.user.id);
    audit.log('auth.2fa_disabled', { req });
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery-codes', async (req) => {
    const body = parse(z.object({ code: z.string() }), req.body);
    if (!checkSecondFactor(req.user.id, body.code)) throw new AppError(400, 'invalid_code', 'Code ungültig');
    const codes = generateRecoveryCodes();
    users.setRecoveryCodes(req.user.id, codes);
    audit.log('auth.2fa_recovery_regenerated', { req });
    return { recoveryCodes: codes };
  });
}
