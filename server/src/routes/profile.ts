/** Eigenes Profil: Stammdaten, Avatar, Sitzungen/Geräte, API-Tokens, Webhooks, Datenexport. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEBHOOK_EVENTS, type ProfileInfo, type WebhookEvent } from '@kuvert/shared';
import { audit } from '../core/audit.js';
import { getDb } from '../core/db.js';
import { AppError, BadRequestError, NotFoundError } from '../core/errors.js';
import type { ModuleContext } from '../core/module.js';
import { policies } from '../core/policies.js';
import { apiTokens } from '../core/tokens.js';
import { sessions, users } from '../core/users.js';
import { webhooks } from '../core/webhooks.js';
import { parse } from './util.js';

const profileSchema = z.object({
  jobTitle: z.string().max(200).optional(),
  department: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  mobile: z.string().max(60).optional(),
  timezone: z.string().max(80).optional(),
  locale: z.string().max(20).optional(),
  bio: z.string().max(2000).optional(),
});

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export async function profileRoutes(app: FastifyInstance, ctx: ModuleContext) {
  app.get('/api/profile', async (req): Promise<ProfileInfo> => {
    const r = users.require(req.user.id);
    return { user: req.user, profile: users.getProfile(req.user.id), createdAt: r.created_at, lastLoginAt: r.last_login_at };
  });

  app.put('/api/profile', async (req): Promise<ProfileInfo> => {
    const body = parse(
      z.object({ name: z.string().min(1).max(200).optional(), email: z.string().email().optional(), currentPassword: z.string().optional(), profile: profileSchema.optional() }),
      req.body,
    );
    if (body.email && body.email.toLowerCase() !== req.user.email.toLowerCase()) {
      if (!body.currentPassword || !(await users.checkPassword(req.user.id, body.currentPassword))) {
        throw new AppError(400, 'invalid_password', 'Zum Ändern der E-Mail-Adresse bitte das aktuelle Passwort angeben');
      }
      audit.log('profile.email_changed', { req, details: { from: req.user.email, to: body.email } });
    }
    users.update(req.user.id, { name: body.name, email: body.email });
    if (body.profile) users.saveProfile(req.user.id, { ...users.getProfile(req.user.id), ...body.profile });
    const r = users.require(req.user.id);
    return { user: users.get(req.user.id)!, profile: users.getProfile(req.user.id), createdAt: r.created_at, lastLoginAt: r.last_login_at };
  });

  /* ───────────── Avatar ───────────── */

  app.post('/api/profile/avatar', async (req) => {
    const file = await req.file({ limits: { fileSize: 1024 * 1024 } });
    if (!file) throw new BadRequestError('Keine Datei übermittelt');
    if (!AVATAR_TYPES.includes(file.mimetype)) throw new BadRequestError('Erlaubt sind PNG, JPEG, WebP oder GIF');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new BadRequestError('Bild ist größer als 1 MB');
    users.setAvatar(req.user.id, data, file.mimetype);
    return { user: users.get(req.user.id) };
  });

  app.delete('/api/profile/avatar', async (req) => {
    users.setAvatar(req.user.id, null, null);
    return { user: users.get(req.user.id) };
  });

  app.get<{ Params: { id: string } }>('/api/users/:id/avatar', async (req, reply) => {
    const a = users.getAvatar(req.params.id);
    if (!a) throw new NotFoundError('Avatar');
    return reply.header('Content-Type', a.type).header('Cache-Control', 'private, max-age=604800, immutable').header('X-Content-Type-Options', 'nosniff').send(a.data);
  });

  /* ───────────── Sitzungen / Geräte ───────────── */

  app.get('/api/profile/sessions', async (req) => sessions.list(req.user.id, req.auth.type === 'session' ? req.auth.sessionId : undefined));

  app.delete<{ Params: { id: string } }>('/api/profile/sessions/:id', async (req) => {
    if (!sessions.revoke(req.user.id, req.params.id)) throw new NotFoundError('Sitzung');
    audit.log('profile.session_revoked', { req });
    return { ok: true };
  });

  app.post('/api/profile/sessions/revoke-others', async (req) => {
    sessions.revokeAll(req.user.id, req.auth.type === 'session' ? req.auth.sessionId : undefined);
    audit.log('profile.sessions_revoked', { req });
    return { ok: true };
  });

  /* ───────────── API-Tokens ───────────── */

  const tokensAllowed = (isAdmin: boolean) => {
    if (!isAdmin && !policies.get().usersCanCreateApiTokens) throw new AppError(403, 'policy', 'API-Tokens sind für Benutzer deaktiviert');
  };

  app.get('/api/profile/tokens', async (req) => apiTokens.list(req.user.id));

  app.post('/api/profile/tokens', async (req) => {
    tokensAllowed(req.user.isAdmin);
    const body = parse(
      z.object({
        name: z.string().min(1).max(100),
        scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
        expiresDays: z.number().int().min(1).max(3650).nullable().optional(),
      }),
      req.body,
    );
    if (body.scopes.includes('admin') && !req.user.isAdmin) throw new AppError(403, 'forbidden', 'Nur Administratoren können Admin-Tokens erstellen');
    const created = apiTokens.create(req.user.id, body.name, body.scopes, body.expiresDays);
    audit.log('api.token_created', { req, details: { name: body.name, scopes: body.scopes, prefix: created.info.prefix } });
    return created;
  });

  app.delete<{ Params: { id: string } }>('/api/profile/tokens/:id', async (req) => {
    if (!apiTokens.delete(req.user.id, req.params.id)) throw new NotFoundError('Token');
    audit.log('api.token_deleted', { req, details: { id: req.params.id } });
    return { ok: true };
  });

  /* ───────────── Webhooks ───────────── */

  const webhookSchema = z.object({
    name: z.string().min(1).max(100),
    url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'Nur http(s)-URLs'),
    events: z.array(z.enum(WEBHOOK_EVENTS as [WebhookEvent, ...WebhookEvent[]])).min(1),
    active: z.boolean().optional(),
  });

  app.get('/api/profile/webhooks', async (req) => webhooks.list(req.user.id));

  app.post('/api/profile/webhooks', async (req) => {
    const body = parse(webhookSchema, req.body);
    const created = webhooks.create(req.user.id, body);
    audit.log('api.webhook_created', { req, details: { url: body.url } });
    return created;
  });

  app.patch<{ Params: { id: string } }>('/api/profile/webhooks/:id', async (req) => webhooks.update(req.user.id, req.params.id, parse(webhookSchema.partial(), req.body)));

  app.delete<{ Params: { id: string } }>('/api/profile/webhooks/:id', async (req) => {
    webhooks.delete(req.user.id, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/profile/webhooks/:id/test', async (req) => webhooks.test(req.user.id, req.params.id));

  /* ───────────── Datenexport (ohne Zugangsdaten) ───────────── */

  app.get('/api/profile/export', async (req, reply) => {
    const uid = req.user.id;
    const data = {
      exportedAt: new Date().toISOString(),
      user: req.user,
      profile: users.getProfile(uid),
      settings: users.getSettings(uid),
      accounts: ctx.accounts.list(uid).map((a) => ({ type: a.type, name: a.name, email: a.email, color: a.color, settings: a.settings, config: a.config })),
      signatures: getDb().prepare('SELECT name, mode, content, account_id, default_new, default_reply FROM signatures WHERE user_id = ?').all(uid),
      templates: getDb().prepare('SELECT name, subject, html FROM templates WHERE user_id = ?').all(uid),
      webhooks: webhooks.list(uid),
      apiTokens: apiTokens.list(uid),
    };
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="kuvert-export-${new Date().toISOString().slice(0, 10)}.json"`)
      .send(JSON.stringify(data, null, 2));
  });
}
