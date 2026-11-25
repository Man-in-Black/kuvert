/** Admin-Bereich: Übersicht, Benutzerverwaltung, Richtlinien, Audit-Log. */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminOverview } from '@kuvert/shared';
import { config } from '../config.js';
import { audit } from '../core/audit.js';
import { getDb } from '../core/db.js';
import { AppError, BadRequestError } from '../core/errors.js';
import type { ModuleContext } from '../core/module.js';
import { policies } from '../core/policies.js';
import { apiTokens } from '../core/tokens.js';
import { sessions, users } from '../core/users.js';
import { systemSettings } from '../core/system-settings.js';
import { createBackend } from '../modules/ai/backends.js';
import { parse } from './util.js';

const startedAt = Date.now();

export function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw new AppError(403, 'forbidden', 'Nur für Administratoren');
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {
    /* fehlt */
  }
  return total;
}

export async function adminRoutes(app: FastifyInstance, ctx: ModuleContext) {
  // Alle Routen unter /api/admin erfordern Admin-Rechte
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/admin/')) requireAdmin(req);
  });

  app.get('/api/admin/overview', async (): Promise<AdminOverview> => {
    const all = users.adminList();
    const accounts = getDb().prepare('SELECT type, status FROM accounts').all() as { type: string; status: string }[];
    const byType: Record<string, number> = {};
    for (const a of accounts) byType[a.type] = (byType[a.type] ?? 0) + 1;
    const dbFile = path.join(config.dataDir, 'kuvert.db');
    const dbSize = ['', '-wal'].reduce((s, suf) => s + (fs.existsSync(dbFile + suf) ? fs.statSync(dbFile + suf).size : 0), 0);
    return {
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      nodeVersion: process.version,
      users: {
        total: all.length,
        admins: all.filter((u) => u.isAdmin).length,
        disabled: all.filter((u) => u.disabled).length,
        with2fa: all.filter((u) => u.twoFactorEnabled).length,
      },
      sessionsActive: sessions.activeCount(),
      accounts: { total: accounts.length, byType, withErrors: accounts.filter((a) => a.status !== 'ok').length },
      scheduledPending: (getDb().prepare(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE status = 'pending'`).get() as { n: number }).n,
      apiTokens: apiTokens.count(),
      dbSizeBytes: dbSize,
      uploadsSizeBytes: dirSize(path.join(config.dataDir, 'uploads')),
      modules: ctx.registry.listModules(),
      features: ctx.registry.features(),
      recentAudit: audit.list({ limit: 10 }).items,
    };
  });

  /* ───────────── Benutzer ───────────── */

  app.get('/api/admin/users', async () => users.adminList());

  app.post('/api/admin/users', async (req) => {
    const body = parse(
      z.object({
        email: z.string().email(),
        name: z.string().min(1).max(200),
        password: z.string().min(8),
        isAdmin: z.boolean().optional(),
        mustChangePassword: z.boolean().optional(),
      }),
      req.body,
    );
    const user = await users.create(body);
    audit.log('admin.user_created', { req, userId: user.id, details: { email: user.email, isAdmin: !!body.isAdmin } });
    return user;
  });

  const guardLastAdmin = (targetId: string, removingAdmin: boolean) => {
    const target = users.require(targetId);
    if (removingAdmin && target.is_admin && !target.disabled && users.adminCount() <= 1) {
      throw new BadRequestError('Es muss mindestens ein aktiver Administrator bestehen bleiben');
    }
  };

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const body = parse(
      z.object({ name: z.string().min(1).max(200).optional(), email: z.string().email().optional(), isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }),
      req.body,
    );
    if (req.params.id === req.user.id && (body.disabled || body.isAdmin === false)) {
      throw new BadRequestError('Eigenes Konto kann nicht deaktiviert oder herabgestuft werden');
    }
    guardLastAdmin(req.params.id, body.isAdmin === false || body.disabled === true);
    const user = users.update(req.params.id, body);
    audit.log('admin.user_updated', { req, userId: req.params.id, details: body });
    return user;
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    if (req.params.id === req.user.id) throw new BadRequestError('Eigenes Konto kann nicht gelöscht werden');
    guardLastAdmin(req.params.id, true);
    const target = users.require(req.params.id);
    for (const acc of ctx.accounts.list(req.params.id)) await ctx.accounts.delete(req.params.id, acc.id);
    users.delete(req.params.id);
    audit.log('admin.user_deleted', { req, userId: null, details: { email: target.email } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/password', async (req) => {
    const body = parse(z.object({ password: z.string().min(8), mustChange: z.boolean().default(true) }), req.body);
    users.require(req.params.id);
    await users.setPassword(req.params.id, body.password, { mustChange: body.mustChange });
    audit.log('admin.password_reset', { req, userId: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-2fa', async (req) => {
    users.require(req.params.id);
    users.disableTotp(req.params.id);
    audit.log('admin.2fa_reset', { req, userId: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/logout', async (req) => {
    sessions.revokeAll(req.params.id);
    apiTokens.deleteAllForUser(req.params.id);
    audit.log('admin.sessions_revoked', { req, userId: req.params.id });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id/accounts', async (req) => ctx.accounts.list(req.params.id).map((a) => ctx.accounts.toInfo(a)));

  app.get<{ Params: { id: string } }>('/api/admin/users/:id/sessions', async (req) => sessions.list(req.params.id));

  /* ───────────── Richtlinien ───────────── */

  app.get('/api/admin/policies', async () => policies.get());

  app.put('/api/admin/policies', async (req) => {
    const body = parse(
      z.object({
        allowRegistration: z.boolean().optional(),
        require2fa: z.boolean().optional(),
        sessionDays: z.number().int().min(1).max(365).optional(),
        allowedAccountTypes: z.array(z.string()).optional(),
        maxAccountsPerUser: z.number().int().min(0).max(1000).optional(),
        usersCanCreateApiTokens: z.boolean().optional(),
      }),
      req.body,
    );
    const next = policies.set(body);
    audit.log('admin.policies_updated', { req, details: body });
    return next;
  });

  /** Alle Kontotypen (auch nicht erlaubte) – für den Richtlinien-Editor */
  app.get('/api/admin/account-types', async () => ctx.registry.listAccountTypes());

  /* ───────────── Dienste: Microsoft/Google-App, KI-Backend ───────────── */

  app.get('/api/admin/services', async () => systemSettings.view());

  app.put('/api/admin/services', async (req) => {
    const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();
    const body = parse(
      z.object({
        microsoft: z.record(z.string(), fieldValue).optional(),
        google: z.record(z.string(), fieldValue).optional(),
        ai: z.record(z.string(), fieldValue).optional(),
      }),
      req.body,
    );
    const changed = systemSettings.update(body);
    // Neue Zugangsdaten → zwischengespeicherte Provider neu aufbauen
    if (changed.some((c) => c.startsWith('microsoft.') || c.startsWith('google.'))) {
      for (const acc of ctx.accounts.listAllEnabled()) {
        if (acc.type === 'microsoft' || acc.type === 'google') await ctx.accounts.invalidate(acc.id);
      }
    }
    if (changed.length) audit.log('admin.services_updated', { req, details: { fields: changed } });
    return systemSettings.view();
  });

  /** KI-Verbindung testen – optional mit noch nicht gespeicherten Werten */
  app.post('/api/admin/services/ai/test', async (req) => {
    const body = parse(
      z.object({ backend: z.enum(['ollama', 'openai']).optional(), baseUrl: z.string().optional(), apiKey: z.string().optional() }),
      req.body ?? {},
    );
    const current = config.ai;
    const backend = createBackend({
      backend: body.backend ?? current.backend,
      baseUrl: (body.baseUrl || current.baseUrl).replace(/\/+$/, ''),
      apiKey: body.apiKey || current.apiKey,
    });
    try {
      const details = await backend.listModels();
      return { ok: true, models: details.map((m) => m.name), modelDetails: details };
    } catch (err) {
      return { ok: false, models: [], modelDetails: [], error: (err as Error).message };
    }
  });

  /* ───────────── Audit-Log ───────────── */

  app.get<{ Querystring: { limit?: string; offset?: string; userId?: string; action?: string } }>('/api/admin/audit', async (req) =>
    audit.list({
      limit: Number(req.query.limit ?? 100) || 100,
      offset: Number(req.query.offset ?? 0) || 0,
      userId: req.query.userId || undefined,
      action: req.query.action || undefined,
    }),
  );
}
