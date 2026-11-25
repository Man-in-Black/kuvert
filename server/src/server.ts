import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { audit } from './core/audit.js';
import { apiTokens } from './core/tokens.js';
import { webhooks } from './core/webhooks.js';
import { systemSettings } from './core/system-settings.js';
import { adminRoutes } from './routes/admin.js';
import { profileRoutes } from './routes/profile.js';
import { config } from './config.js';
import { AccountService } from './core/accounts.js';
import { getDb, kv, registerMigration, runMigrations } from './core/db.js';
import { AppError } from './core/errors.js';
import { EventBus } from './core/events.js';
import { Hooks } from './core/hooks.js';
import { MailService } from './core/mail-service.js';
import type { ModuleContext, ServerModule } from './core/module.js';
import { Registry } from './core/registry.js';
import { uploads } from './core/uploads.js';
import { sessions } from './core/users.js';
import { allModules } from './modules/index.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { mailRoutes } from './routes/mail.js';
import { pimRoutes } from './routes/pim.js';
import { settingsRoutes } from './routes/settings.js';

function moduleActive(mod: ServerModule): boolean {
  if (config.enabledModules.length && !config.enabledModules.includes(mod.id)) return false;
  if (config.disabledModules.includes(mod.id)) return false;
  return mod.isEnabled ? mod.isEnabled() : true;
}

export async function buildServer(): Promise<{ app: FastifyInstance; ctx: ModuleContext }> {
  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: pretty ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    bodyLimit: (config.uploadMaxMb + 15) * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.appSecret });
  await app.register(multipart, { limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 10 } });
  await app.register(rateLimit, { global: false });

  /* ───────────── Module laden ───────────── */
  const registry = new Registry();
  for (const mod of allModules) {
    if (!moduleActive(mod)) {
      app.log.info(`Modul deaktiviert: ${mod.id}`);
      continue;
    }
    registry.add(mod);
    for (const m of mod.migrations ?? []) registerMigration(m.id, m.sql);
  }
  runMigrations();
  // Im Admin-Bereich gepflegte Dienst-Einstellungen (überschreiben .env)
  systemSettings.init();

  const bus = new EventBus();
  const hooks = new Hooks();
  const accounts = new AccountService(registry, bus, app.log);
  const mail = new MailService(accounts, hooks, bus, app.log);
  const ctx: ModuleContext = { config, db: getDb(), kv, log: app.log, bus, hooks, accounts, mail, registry };

  /* ───────────── API-Dokumentation (OpenAPI 3 / Swagger UI unter /api/docs) ───────────── */
  await app.register(swagger, {
    openapi: {
      info: {
        title: `${config.appName} API`,
        version: config.version,
        description:
          'REST-API von Kuvert. Authentifizierung per persönlichem API-Token (Profil → API & Webhooks): ' +
          '`Authorization: Bearer kvt_…`. Scopes: read (GET), write (ändernde Aufrufe), admin (/api/admin).',
      },
      servers: [{ url: config.publicUrl }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'kvt_…' } } },
      security: [{ bearerAuth: [] }],
    },
    transform: ({ schema, url, route }) => {
      const seg = url.split('/')[2] ?? 'app';
      const tag = { oauth: 'accounts', users: 'profile', health: 'app', uploads: 'mail', templates: 'settings', signatures: 'settings' }[seg] ?? seg;
      return { schema: { ...(schema ?? {}), tags: [tag] } as never, url, route } as never;
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'none', deepLinking: true } });

  /* ───────────── Authentifizierung, Scopes & CSRF ───────────── */
  const isPublicPath = (url: string) => url.startsWith('/api/docs');
  /** Erlaubte Pfade, solange 2FA-Einrichtung bzw. Passwortänderung erzwungen wird */
  const restrictedAllow = (url: string) => /^\/api\/(app|auth\/|profile(\?|$)|events|users\/[^/]+\/avatar)/.test(url);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || isPublicPath(req.url)) return;
    const authz = req.headers.authorization;
    const bearer = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;

    if (bearer) {
      // API-Token: kein CSRF-Header nötig, dafür Scope-Prüfung
      const t = apiTokens.resolve(bearer);
      if (!t) throw new AppError(401, 'invalid_token', 'API-Token ungültig oder abgelaufen');
      const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (req.url.startsWith('/api/admin')) {
        if (!t.scopes.includes('admin') || !t.user.isAdmin) throw new AppError(403, 'insufficient_scope', 'Token benötigt den Scope "admin"');
      } else if (!readOnly && !t.scopes.includes('write')) {
        throw new AppError(403, 'insufficient_scope', 'Token benötigt den Scope "write"');
      } else if (readOnly && !t.scopes.includes('read') && !t.scopes.includes('write')) {
        throw new AppError(403, 'insufficient_scope', 'Token benötigt den Scope "read"');
      }
      // Sicherheitsrelevante Selbstverwaltung nur über die Browser-Sitzung
      if (/^\/api\/(auth\/|profile\/tokens)/.test(req.url)) throw new AppError(403, 'session_required', 'Nur mit Browser-Anmeldung möglich');
      req.user = t.user;
      req.auth = { type: 'token', tokenId: t.tokenId, scopes: t.scopes };
      return;
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'kuvert') {
      throw new AppError(403, 'csrf', 'Fehlender Sicherheits-Header (X-Requested-With)');
    }
    if (req.routeOptions.config?.public) return;
    const s = sessions.resolveWithId(req);
    if (!s) throw new AppError(401, 'unauthenticated', 'Nicht angemeldet');
    if (s.user.mustSetup2fa && !restrictedAllow(req.url)) {
      throw new AppError(403, 'two_factor_setup_required', 'Bitte zuerst die Zwei-Faktor-Authentifizierung einrichten');
    }
    if (s.user.mustChangePassword && !restrictedAllow(req.url)) {
      throw new AppError(403, 'password_change_required', 'Bitte zuerst ein neues Passwort festlegen');
    }
    req.user = s.user;
    req.auth = { type: 'session', sessionId: s.sessionId };
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      // 503 = bewusst nicht verfügbar (z. B. Funktion deaktiviert) → kein Fehler im Log
      if (err.status >= 500 && err.status !== 503) req.log.error({ err }, err.message);
      else req.log.debug({ err }, err.message);
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const fe = err as FastifyError;
    if (fe.validation) return reply.status(400).send({ error: 'bad_request', message: fe.message });
    if (fe.statusCode && fe.statusCode < 500) return reply.status(fe.statusCode).send({ error: fe.code ?? 'error', message: fe.message });
    req.log.error({ err }, 'Unbehandelter Fehler');
    return reply.status(500).send({ error: 'internal', message: fe.message || 'Interner Fehler' });
  });

  /* ───────────── Kern-Routen ───────────── */
  await authRoutes(app, ctx);
  await accountRoutes(app, ctx);
  await mailRoutes(app, ctx);
  await pimRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await eventRoutes(app, ctx);
  await profileRoutes(app, ctx);
  await adminRoutes(app, ctx);
  webhooks.install(bus, app.log);
  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true, version: config.version }));

  /* ───────────── Modul-Routen & Initialisierung ───────────── */
  for (const mod of registry.modules) {
    if (mod.routes) await app.register(async (scoped) => mod.routes!(scoped, ctx), { prefix: `/api/${mod.id}` });
  }
  for (const mod of registry.modules) {
    try {
      await mod.init?.(ctx);
    } catch (err) {
      app.log.error({ err }, `Initialisierung von Modul ${mod.id} fehlgeschlagen`);
    }
  }

  /* ───────────── Web-Client (SPA) ───────────── */
  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false, maxAge: '1h' });
    app.get('/*', { config: { public: true } }, async (req, reply) => {
      const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
      const file = path.join(config.webDist, rel);
      if (rel && file.startsWith(config.webDist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const immutable = rel.startsWith('assets/');
        return reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache').sendFile(rel);
      }
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(indexHtml));
    });
  } else {
    app.log.warn(`Web-Client nicht gefunden (${config.webDist}) – nur API aktiv`);
  }

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} nicht gefunden` }));

  /* ───────────── Hintergrundaufgaben ───────────── */
  mail.startScheduler();
  const housekeeping = setInterval(() => {
    try {
      uploads.cleanup();
      sessions.cleanup();
      audit.prune(365);
    } catch (err) {
      app.log.warn({ err }, 'Aufräumen fehlgeschlagen');
    }
  }, 3600_000);
  housekeeping.unref();

  app.addHook('onClose', async () => {
    clearInterval(housekeeping);
    mail.stopScheduler();
    for (const mod of registry.modules) await mod.shutdown?.();
    for (const acc of accounts.listAllEnabled()) await accounts.invalidate(acc.id);
    getDb().close();
  });

  return { app, ctx };
}
