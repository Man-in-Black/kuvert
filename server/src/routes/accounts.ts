import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountInfo } from '@kuvert/shared';
import { config } from '../config.js';
import { randomId } from '../core/crypto.js';
import { AppError, BadRequestError } from '../core/errors.js';
import type { ModuleContext } from '../core/module.js';
import { createPkce } from '../core/oauth.js';
import { sessions } from '../core/users.js';
import { audit } from '../core/audit.js';
import { policies } from '../core/policies.js';
import { parse } from './util.js';

interface PendingOAuth {
  userId: string;
  type: string;
  verifier: string;
  accountId?: string;
  /** Zusätzlich angefragte Funktionen (z. B. "chat" für Teams) */
  features?: string[];
  /** Nach der Anmeldung hierhin zurück statt zu den Konten */
  returnTo?: string;
  /** Administratorzustimmung für eine Organisation (danach normale Anmeldung neu starten) */
  consent?: { tenant: string };
  created: number;
}

/** Mandanten-ID oder Domain */
const TENANT = /^[a-z0-9][a-z0-9.-]{0,99}$/i;

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Ergebnisseite für Administratoren, die über einen weitergeleiteten Link zugestimmt haben (ohne Kuvert-Sitzung) */
function consentPage(ok: boolean, message?: string): string {
  const title = ok ? 'Zustimmung erteilt' : 'Zustimmung fehlgeschlagen';
  const text = ok
    ? 'Kuvert ist für Ihre Organisation freigegeben. Benutzer können ihr Konto jetzt in Kuvert verbinden. Dieses Fenster kann geschlossen werden.'
    : escapeHtml(message ?? 'Unbekannter Fehler');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Kuvert</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#1f2937}h1{font-size:1.25rem}@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}}</style>
</head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}

/** Nur Einstellungsseiten als Rücksprungziel */
const RETURN_TO = /^\/settings\/[a-z0-9-]+$/;

const pending = new Map<string, PendingOAuth>();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of pending) if (v.created < cutoff) pending.delete(k);
}, 60_000).unref();

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function accountRoutes(app: FastifyInstance, ctx: ModuleContext) {
  const { accounts, registry } = ctx;

  /** Richtlinien prüfen: erlaubter Kontotyp, maximale Anzahl Konten */
  const checkPolicy = (userId: string, type: string, isNew: boolean) => {
    if (!policies.accountTypeAllowed(type)) throw new AppError(403, 'policy', 'Dieser Kontotyp ist vom Administrator nicht freigegeben');
    const max = policies.get().maxAccountsPerUser;
    if (isNew && max > 0 && accounts.list(userId).length >= max) {
      throw new AppError(403, 'policy', `Maximal ${max} Konten pro Benutzer erlaubt`);
    }
  };

  app.get('/api/accounts', async (req): Promise<AccountInfo[]> => accounts.list(req.user.id).map((a) => accounts.toInfo(a)));

  app.get('/api/accounts/types', async () => registry.listAccountTypes().filter((t) => policies.accountTypeAllowed(t.type)));

  /** Formularbasierte Einrichtung (IMAP, CalDAV, Nextcloud …) */
  app.post('/api/accounts', async (req) => {
    const body = parse(z.object({ type: z.string(), values: z.record(z.string(), z.unknown()) }), req.body);
    const def = registry.getAccountType(body.type);
    if (!def) throw new BadRequestError(`Unbekannter Kontotyp: ${body.type}`);
    if (def.auth !== 'form' || !def.setup) throw new BadRequestError('Dieser Kontotyp wird per OAuth verbunden');
    checkPolicy(req.user.id, body.type, true);
    const result = await def.setup(body.values);
    const acc = accounts.create(req.user.id, body.type, result);
    audit.log('account.added', { req, details: { type: acc.type, email: acc.email } });
    return accounts.toInfo(acc);
  });

  /** Zugangsdaten eines Formular-Kontos ändern (leere Secret-Felder = unverändert) */
  app.put<{ Params: { id: string } }>('/api/accounts/:id/credentials', async (req) => {
    const body = parse(z.object({ values: z.record(z.string(), z.unknown()) }), req.body);
    const acc = accounts.get(req.user.id, req.params.id);
    const def = registry.getAccountType(acc.type);
    if (!def?.setup) throw new BadRequestError('Für diesen Kontotyp nicht möglich');
    const merged: Record<string, unknown> = { ...acc.config, ...acc.secrets };
    for (const [k, v] of Object.entries(body.values)) {
      const field = def.fields?.find((f) => f.key === k);
      if (field?.secret && (v === '' || v === undefined || v === null)) continue;
      merged[k] = v;
    }
    const result = await def.setup(merged);
    return accounts.toInfo(
      accounts.update(req.user.id, acc.id, {
        email: result.email,
        config: result.config ?? {},
        secrets: result.secrets,
        status: 'ok',
        statusMessage: null,
      }),
    );
  });

  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (req) => {
    const body = parse(patchSchema, req.body);
    return accounts.toInfo(accounts.update(req.user.id, req.params.id, body as never));
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req) => {
    const acc = accounts.get(req.user.id, req.params.id);
    await accounts.delete(req.user.id, req.params.id);
    audit.log('account.removed', { req, details: { type: acc.type, email: acc.email } });
    return { ok: true };
  });

  app.put('/api/accounts/order', async (req) => {
    const body = parse(z.object({ ids: z.array(z.string()) }), req.body);
    accounts.reorder(req.user.id, body.ids);
    return { ok: true };
  });

  /** Verbindungstest: ruft je Fähigkeit eine einfache Leseoperation auf */
  app.post<{ Params: { id: string } }>('/api/accounts/:id/test', async (req) => {
    const acc = accounts.get(req.user.id, req.params.id);
    await accounts.invalidate(acc.id);
    const p = accounts.providersFor(acc);
    const results: Record<string, { ok: boolean; message?: string }> = {};
    const run = async (name: string, fn?: () => Promise<unknown>) => {
      if (!fn) return;
      try {
        await fn();
        results[name] = { ok: true };
      } catch (err) {
        results[name] = { ok: false, message: (err as Error).message };
      }
    };
    await Promise.all([
      run('mail', p.mail && (() => p.mail!.listFolders())),
      run('calendar', p.calendar && (() => p.calendar!.listCalendars())),
      run('contacts', p.contacts && (() => p.contacts!.listAddressBooks())),
      run('tasks', p.tasks && (() => p.tasks!.listTaskLists())),
      run('storage', p.storage && (() => p.storage!.list(null))),
    ]);
    const ok = Object.values(results).every((r) => r.ok);
    accounts.setStatus(acc.id, ok ? 'ok' : 'error', ok ? null : Object.entries(results).filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.message}`).join('; '));
    return { ok, results };
  });

  /* ───────────── OAuth ───────────── */

  app.get<{ Params: { type: string }; Querystring: { accountId?: string; loginHint?: string; features?: string; returnTo?: string } }>(
    '/api/accounts/oauth/:type/start',
    async (req, reply) => {
      const def = registry.getAccountType(req.params.type);
      if (!def?.oauth) throw new BadRequestError('Kein OAuth-Kontotyp');
      if (def.isConfigured && !def.isConfigured()) {
        throw new AppError(400, 'not_configured', `${def.label} ist serverseitig nicht konfiguriert (Client-ID/Secret fehlen)`);
      }
      const existing = req.query.accountId ? accounts.get(req.user.id, req.query.accountId) : undefined;
      checkPolicy(req.user.id, def.type, !req.query.accountId);
      // Bereits erteilte Zusatzberechtigungen beim Neu-Verbinden erneut anfragen
      const prevFeatures = existing?.config.oauthFeatures;
      const previous = Array.isArray(prevFeatures) ? prevFeatures.map(String) : [];
      const requested = (req.query.features ?? '').split(',').filter((f) => /^[a-z]{1,20}$/.test(f));
      const features = [...new Set([...previous, ...requested])];
      const returnTo = req.query.returnTo && RETURN_TO.test(req.query.returnTo) ? req.query.returnTo : undefined;
      const state = randomId(24);
      const { verifier, challenge } = createPkce();
      pending.set(state, { userId: req.user.id, type: def.type, verifier, accountId: req.query.accountId, features, returnTo, created: Date.now() });
      const url = def.oauth.getAuthorizeUrl({
        state,
        redirectUri: config.oauthRedirectUri,
        codeChallenge: challenge,
        loginHint: req.query.loginHint,
        features,
      });
      return reply.redirect(url);
    },
  );

  /**
   * Administratorzustimmung für eine Organisation anfordern. Entweder für eine fehlgeschlagene Anmeldung
   * (resume = state aus dem Fehler-Rücksprung) oder direkt (tenant, sonst die Organisation des Admins).
   */
  app.get<{ Params: { type: string }; Querystring: { resume?: string; tenant?: string; returnTo?: string } }>(
    '/api/accounts/oauth/:type/consent',
    async (req, reply) => {
      const def = registry.getAccountType(req.params.type);
      const consent = def?.oauth?.adminConsent;
      if (!def || !consent?.available()) throw new BadRequestError('Für diesen Kontotyp ist keine Administratorzustimmung möglich');
      const resumed = req.query.resume ? pending.get(req.query.resume) : undefined;
      if (req.query.resume && resumed?.consent && resumed.userId === req.user.id && resumed.type === def.type) {
        return reply.redirect(consent.url({ tenant: resumed.consent.tenant, redirectUri: config.oauthRedirectUri, state: req.query.resume }));
      }
      checkPolicy(req.user.id, def.type, true);
      const tenant = req.query.tenant && TENANT.test(req.query.tenant) ? req.query.tenant : 'organizations';
      const returnTo = req.query.returnTo && RETURN_TO.test(req.query.returnTo) ? req.query.returnTo : undefined;
      const state = randomId(24);
      pending.set(state, { userId: req.user.id, type: def.type, verifier: '', returnTo, consent: { tenant }, created: Date.now() });
      return reply.redirect(consent.url({ tenant, redirectUri: config.oauthRedirectUri, state }));
    },
  );

  /** Zustimmungs-Link zum Weiterleiten an einen Administrator der anderen Organisation */
  app.get<{ Params: { type: string }; Querystring: { tenant?: string } }>('/api/accounts/oauth/:type/consent-link', async (req) => {
    const consent = registry.getAccountType(req.params.type)?.oauth?.adminConsent;
    if (!consent?.available()) throw new BadRequestError('Für diesen Kontotyp ist keine Administratorzustimmung möglich');
    const tenant = req.query.tenant && TENANT.test(req.query.tenant) ? req.query.tenant : undefined;
    return { url: consent.url({ tenant, redirectUri: config.oauthRedirectUri }) };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string; admin_consent?: string } }>(
    '/api/oauth/callback',
    { config: { public: true } },
    async (req, reply) => {
      const st = req.query.state ? pending.get(req.query.state) : undefined;
      const back = (params: Record<string, string>) => reply.redirect(`${st?.returnTo ?? '/settings/accounts'}?${new URLSearchParams(params).toString()}`);
      if (req.query.state) pending.delete(req.query.state);

      // Rücksprung von der Administratorzustimmung
      if (st?.consent) {
        if (req.query.error) return back({ error: `Administratorzustimmung: ${req.query.error_description || req.query.error}` });
        // Zugestimmt → normale Anmeldung mit denselben Angaben neu starten
        const q = new URLSearchParams();
        if (st.accountId) q.set('accountId', st.accountId);
        if (st.features?.length) q.set('features', st.features.join(','));
        if (st.returnTo) q.set('returnTo', st.returnTo);
        audit.log('account.admin_consent', { req, actorId: st.userId, details: { type: st.type, tenant: st.consent.tenant } });
        return reply.redirect(`/api/accounts/oauth/${encodeURIComponent(st.type)}/start?${q.toString()}`);
      }
      if (!st && (req.query.admin_consent !== undefined || (!req.query.state && req.query.error))) {
        // Über einen weitergeleiteten Link zugestimmt (kein Kuvert-Vorgang dazu)
        const ok = !req.query.error && /^true$/i.test(req.query.admin_consent ?? '');
        return reply.type('text/html; charset=utf-8').send(consentPage(ok, req.query.error_description || req.query.error));
      }

      /** Fehlt die Zustimmung der Organisation? Dann Vorgang für die Administratorzustimmung vormerken. */
      const withConsent = (message: string): Record<string, string> => {
        const tenant = st && registry.getAccountType(st.type)?.oauth?.adminConsent?.tenantFromError(message);
        if (!st || !tenant) return { error: message };
        const state = randomId(24);
        pending.set(state, { ...st, verifier: '', consent: { tenant }, created: Date.now() });
        return { error: message, consent: st.type, consentState: state, tenant };
      };
      if (req.query.error) return back(withConsent(req.query.error_description || req.query.error));
      if (!st || !req.query.code) return back({ error: 'Ungültige oder abgelaufene Anmeldung – bitte erneut versuchen' });
      const current = sessions.resolve(req);
      if (current && current.id !== st.userId) return back({ error: 'Sitzung passt nicht zur Anmeldung' });
      const def = registry.getAccountType(st.type);
      if (!def?.oauth) return back({ error: 'Kontotyp nicht verfügbar' });
      try {
        const result = await def.oauth.handleCallback({ code: req.query.code, redirectUri: config.oauthRedirectUri, codeVerifier: st.verifier, features: st.features });
        const acc = accounts.createOrReconnect(st.userId, st.type, result, st.accountId);
        audit.log('account.connected', { req, actorId: st.userId, details: { type: acc.type, email: acc.email } });
        return back({ connected: acc.id });
      } catch (err) {
        req.log.error({ err }, 'OAuth-Callback fehlgeschlagen');
        return back(withConsent((err as Error).message));
      }
    },
  );
}
