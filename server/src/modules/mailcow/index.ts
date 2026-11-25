/**
 * mailcow-Integration:
 *  - Admin: Instanzen verwalten, Status, Domains, Postfächer (anlegen/ändern/löschen),
 *    Aliasse, Quarantäne, Sync-Jobs, Provisionierung (Postfach + Kuvert-Benutzer + Konto)
 *  - Benutzer (Self-Service für verknüpfte Postfächer): Kontingent, Aliasse,
 *    Wegwerf-Adressen, App-Passwörter, Quarantäne, Passwort ändern
 *  - Kontotyp "mailcow" (IMAP/SMTP + SOGo-Kalender/-Kontakte in einem Schritt)
 *
 * Optional per Umgebung vorbelegen: MAILCOW_URL, MAILCOW_API_KEY, MAILCOW_NAME
 */
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MailcowLinkedMailbox, MailcowProvisionResult } from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { defineModule, type AccountRecord, type ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { buildMailcowSetup, mailcowAccountType } from './account.js';
import { mapAlias, mapAppPassword, mapDomain, mapMailbox, mapQuarantine, mapStatus, mapSyncJob, mapTempAlias } from './map.js';
import { hostnameOf, instances, links, migrations } from './store.js';

type InstParams = { Params: { id: string } };
type MeParams = { Params: { instanceId: string; mailbox: string } };

const domainOf = (mailbox: string) => mailbox.split('@')[1] ?? '';
const enc = encodeURIComponent;
const PROTOCOLS = ['imap_access', 'smtp_access', 'dav_access', 'eas_access', 'pop3_access', 'sieve_access'] as const;

/** Verknüpft Konten, deren Postfach auf einer bekannten mailcow-Instanz liegt (Login beweist Besitz). */
function autoLink(acc: AccountRecord) {
  try {
    if (acc.type === 'mailcow') {
      const instanceId = acc.config.instanceId || instances.findByHost(String(acc.config.hostname ?? ''))?.id;
      if (instanceId) links.add(acc.userId, instanceId, acc.email);
    } else if (acc.type === 'imap' && acc.config.imapHost) {
      const inst = instances.findByHost(String(acc.config.imapHost));
      const mailbox = String(acc.config.imapUser ?? '').includes('@') ? String(acc.config.imapUser) : acc.email;
      if (inst) links.add(acc.userId, inst.id, mailbox);
    }
  } catch {
    /* Verknüpfung ist optional */
  }
}

/** Prüft, dass das Postfach mit dem Benutzer verknüpft ist, und liefert den API-Client. */
function own(req: FastifyRequest, instanceId: string, mailbox: string) {
  const mb = mailbox.trim().toLowerCase();
  if (!links.has(req.user.id, instanceId, mb)) throw new AppError(403, 'forbidden', 'Dieses Postfach ist nicht mit Ihrem Benutzer verknüpft');
  return { client: instances.client(instanceId), mailbox: mb };
}

/** Neue Zugangsdaten in den eigenen Kuvert-Konten dieses Postfachs hinterlegen */
function updateAccountSecrets(ctx: ModuleContext, userId: string, mailbox: string, password: string): number {
  let n = 0;
  for (const acc of ctx.accounts.list(userId)) {
    if (acc.email.toLowerCase() !== mailbox && String(acc.config.imapUser ?? '').toLowerCase() !== mailbox) continue;
    if (acc.type !== 'mailcow' && acc.type !== 'imap') continue;
    const secrets: Record<string, unknown> = { ...acc.secrets, imapPassword: password };
    if (secrets.smtpPassword) secrets.smtpPassword = password;
    ctx.accounts.update(userId, acc.id, { secrets, status: 'ok', statusMessage: null });
    n++;
  }
  return n;
}

function randomPassword(len = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const mailboxCreateSchema = z.object({
  localPart: z.string().min(1).max(64),
  domain: z.string().min(3),
  name: z.string().max(200).default(''),
  password: z.string().min(8),
  quotaMb: z.number().int().min(0).max(10_000_000).default(3072),
  active: z.boolean().default(true),
});

export default defineModule({
  id: 'mailcow',
  name: 'mailcow',
  description: 'Verwaltung und Self-Service für mailcow-Mailserver',
  features: ['mailcow'],
  migrations,
  accountTypes: [mailcowAccountType],

  init(ctx) {
    // Instanz aus Umgebungsvariablen vorbelegen
    const url = process.env.MAILCOW_URL;
    const key = process.env.MAILCOW_API_KEY;
    if (url && key && !instances.list().length) {
      try {
        instances.create({ name: process.env.MAILCOW_NAME ?? 'mailcow', baseUrl: url, apiKey: key });
      } catch (err) {
        ctx.log.warn({ err }, 'mailcow-Instanz aus Umgebung konnte nicht angelegt werden');
      }
    }
    ctx.bus.internal.on('account.created', autoLink);
    ctx.bus.internal.on('account.updated', autoLink);
  },

  routes(app, ctx) {
    /* ═════════════════════════════ Admin ═════════════════════════════ */

    app.get('/instances', async (req) => {
      requireAdmin(req);
      return instances.list();
    });

    app.post('/instances', async (req) => {
      requireAdmin(req);
      const body = parse(z.object({ name: z.string().max(100).default(''), baseUrl: z.string().min(3), apiKey: z.string().min(8) }), req.body);
      const inst = instances.create(body);
      audit.log('mailcow.instance_created', { req, details: { baseUrl: inst.baseUrl } });
      return inst;
    });

    app.patch<InstParams>('/instances/:id', async (req) => {
      requireAdmin(req);
      const body = parse(z.object({ name: z.string().max(100).optional(), baseUrl: z.string().optional(), apiKey: z.string().optional() }), req.body);
      const inst = instances.update(req.params.id, body);
      audit.log('mailcow.instance_updated', { req, details: { id: inst.id, keyChanged: !!body.apiKey } });
      return inst;
    });

    app.delete<InstParams>('/instances/:id', async (req) => {
      requireAdmin(req);
      instances.delete(req.params.id);
      audit.log('mailcow.instance_deleted', { req, details: { id: req.params.id } });
      return { ok: true };
    });

    app.post<InstParams>('/instances/:id/test', async (req) => {
      requireAdmin(req);
      const v = await instances.client(req.params.id).getObject<{ version?: string }>('status/version');
      return { ok: true, version: v?.version ?? null };
    });

    app.get<InstParams>('/instances/:id/status', async (req) => {
      requireAdmin(req);
      const c = instances.client(req.params.id);
      const [version, containers, vmail] = await Promise.allSettled([c.getObject('status/version'), c.getObject('status/containers'), c.getObject('status/vmail')]);
      if (version.status === 'rejected' && containers.status === 'rejected') throw version.reason;
      const val = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
      return mapStatus(val(version), val(containers), val(vmail));
    });

    app.get<InstParams>('/instances/:id/domains', async (req) => {
      requireAdmin(req);
      return (await instances.client(req.params.id).getList('domain/all')).map(mapDomain);
    });

    app.get<InstParams>('/instances/:id/mailboxes', async (req) => {
      requireAdmin(req);
      return (await instances.client(req.params.id).getList('mailbox/all')).map(mapMailbox).sort((a, b) => a.username.localeCompare(b.username));
    });

    app.post<InstParams>('/instances/:id/mailboxes', async (req) => {
      requireAdmin(req);
      const b = parse(mailboxCreateSchema, req.body);
      await instances.client(req.params.id).write('add/mailbox', {
        local_part: b.localPart,
        domain: b.domain,
        name: b.name,
        password: b.password,
        password2: b.password,
        quota: String(b.quotaMb),
        active: b.active ? '1' : '0',
        force_pw_update: '0',
        tls_enforce_in: '0',
        tls_enforce_out: '0',
      });
      const mailbox = `${b.localPart}@${b.domain}`.toLowerCase();
      audit.log('mailcow.mailbox_created', { req, details: { mailbox } });
      return { ok: true, mailbox };
    });

    app.patch<InstParams & { Params: { mailbox: string } }>('/instances/:id/mailboxes/:mailbox', async (req) => {
      requireAdmin(req);
      const b = parse(
        z.object({ name: z.string().max(200).optional(), quotaMb: z.number().int().min(0).optional(), active: z.boolean().optional(), password: z.string().min(8).optional() }),
        req.body,
      );
      const attr: Record<string, unknown> = {};
      if (b.name !== undefined) attr.name = b.name;
      if (b.quotaMb !== undefined) attr.quota = String(b.quotaMb);
      if (b.active !== undefined) attr.active = b.active ? '1' : '0';
      if (b.password) {
        attr.password = b.password;
        attr.password2 = b.password;
      }
      if (!Object.keys(attr).length) throw new BadRequestError('Keine Änderungen angegeben');
      await instances.client(req.params.id).write('edit/mailbox', { items: [req.params.mailbox], attr });
      audit.log('mailcow.mailbox_updated', { req, details: { mailbox: req.params.mailbox, fields: Object.keys(attr).filter((k) => !k.startsWith('password')), passwordChanged: !!b.password } });
      return { ok: true };
    });

    app.delete<InstParams & { Params: { mailbox: string } }>('/instances/:id/mailboxes/:mailbox', async (req) => {
      requireAdmin(req);
      await instances.client(req.params.id).write('delete/mailbox', [req.params.mailbox]);
      audit.log('mailcow.mailbox_deleted', { req, details: { mailbox: req.params.mailbox } });
      return { ok: true };
    });

    app.get<InstParams>('/instances/:id/aliases', async (req) => {
      requireAdmin(req);
      return (await instances.client(req.params.id).getList('alias/all')).map(mapAlias).sort((a, b) => a.address.localeCompare(b.address));
    });

    app.post<InstParams>('/instances/:id/aliases', async (req) => {
      requireAdmin(req);
      const b = parse(z.object({ address: z.string().min(3), goto: z.string().min(3), active: z.boolean().default(true) }), req.body);
      await instances.client(req.params.id).write('add/alias', { address: b.address, goto: b.goto, active: b.active ? '1' : '0' });
      audit.log('mailcow.alias_created', { req, details: { address: b.address, goto: b.goto } });
      return { ok: true };
    });

    app.delete<InstParams & { Params: { aliasId: string } }>('/instances/:id/aliases/:aliasId', async (req) => {
      requireAdmin(req);
      await instances.client(req.params.id).write('delete/alias', [req.params.aliasId]);
      audit.log('mailcow.alias_deleted', { req, details: { id: req.params.aliasId } });
      return { ok: true };
    });

    app.get<InstParams>('/instances/:id/quarantine', async (req) => {
      requireAdmin(req);
      return (await instances.client(req.params.id).getList('quarantine/all')).map(mapQuarantine);
    });

    app.delete<InstParams & { Params: { qid: string } }>('/instances/:id/quarantine/:qid', async (req) => {
      requireAdmin(req);
      await instances.client(req.params.id).write('delete/qitem', [req.params.qid]);
      return { ok: true };
    });

    app.get<InstParams>('/instances/:id/syncjobs', async (req) => {
      requireAdmin(req);
      return (await instances.client(req.params.id).getList('syncjobs/all/no_log')).map(mapSyncJob);
    });

    /* ───────────── Verknüpfungen Benutzer ↔ Postfach ───────────── */

    app.get('/links', async (req) => {
      requireAdmin(req);
      return links.all();
    });

    app.post('/links', async (req) => {
      requireAdmin(req);
      const b = parse(z.object({ userId: z.string(), instanceId: z.string(), mailbox: z.string().email() }), req.body);
      if (!users.get(b.userId)) throw new NotFoundError('Benutzer');
      instances.get(b.instanceId);
      links.add(b.userId, b.instanceId, b.mailbox);
      audit.log('mailcow.link_added', { req, userId: b.userId, details: { mailbox: b.mailbox } });
      return { ok: true };
    });

    app.delete<{ Querystring: { userId: string; instanceId: string; mailbox: string } }>('/links', async (req) => {
      requireAdmin(req);
      links.remove(req.query.userId, req.query.instanceId, req.query.mailbox);
      audit.log('mailcow.link_removed', { req, userId: req.query.userId, details: { mailbox: req.query.mailbox } });
      return { ok: true };
    });

    /* ───────────── Provisionierung ───────────── */

    app.post('/provision', async (req): Promise<MailcowProvisionResult> => {
      requireAdmin(req);
      const b = parse(
        mailboxCreateSchema.extend({
          instanceId: z.string(),
          kuvertUser: z.discriminatedUnion('mode', [
            z.object({ mode: z.literal('none') }),
            z.object({ mode: z.literal('existing'), userId: z.string() }),
            z.object({
              mode: z.literal('new'),
              email: z.string().email(),
              name: z.string().min(1),
              password: z.string().min(8),
              isAdmin: z.boolean().optional(),
              mustChangePassword: z.boolean().optional(),
            }),
          ]),
          addAccount: z.boolean().default(true),
        }),
        req.body,
      );
      const warnings: string[] = [];
      const client = instances.client(b.instanceId);
      if (b.kuvertUser.mode === 'existing' && !users.get(b.kuvertUser.userId)) throw new NotFoundError('Kuvert-Benutzer');

      await client.write('add/mailbox', {
        local_part: b.localPart,
        domain: b.domain,
        name: b.name,
        password: b.password,
        password2: b.password,
        quota: String(b.quotaMb),
        active: b.active ? '1' : '0',
        force_pw_update: '0',
      });
      const mailbox = `${b.localPart}@${b.domain}`.toLowerCase();

      let userId: string | null = null;
      if (b.kuvertUser.mode === 'existing') userId = b.kuvertUser.userId;
      else if (b.kuvertUser.mode === 'new') {
        try {
          const u = await users.create({
            email: b.kuvertUser.email,
            name: b.kuvertUser.name,
            password: b.kuvertUser.password,
            isAdmin: b.kuvertUser.isAdmin,
            mustChangePassword: b.kuvertUser.mustChangePassword ?? true,
          });
          userId = u.id;
        } catch (err) {
          warnings.push(`Postfach angelegt, aber Kuvert-Benutzer nicht: ${(err as Error).message}`);
        }
      }

      let accountId: string | null = null;
      if (userId) {
        links.add(userId, b.instanceId, mailbox);
        if (b.addAccount) {
          try {
            const setup = await buildMailcowSetup({ name: b.name || mailbox, email: mailbox, password: b.password, instanceId: b.instanceId, enableDav: true }, { verify: false });
            accountId = ctx.accounts.create(userId, 'mailcow', setup).id;
          } catch (err) {
            warnings.push(`Konto konnte nicht angelegt werden: ${(err as Error).message}`);
          }
        }
      }
      audit.log('mailcow.provisioned', { req, userId, details: { mailbox, accountId, instance: hostnameOf(instances.get(b.instanceId).baseUrl) } });
      return { mailbox, userId, accountId, warnings };
    });

    /* ═════════════════════════════ Self-Service ═════════════════════════════ */

    app.get('/me/mailboxes', async (req): Promise<MailcowLinkedMailbox[]> => {
      const mine = links.forUser(req.user.id);
      return Promise.all(
        mine.map(async (l) => {
          try {
            const list = await instances.client(l.instanceId).getList(`mailbox/${enc(l.mailbox)}`);
            const raw = list.find((m) => String(m.username ?? '').toLowerCase() === l.mailbox) ?? list[0];
            return { instanceId: l.instanceId, instanceName: l.instanceName ?? '', mailbox: l.mailbox, info: raw ? mapMailbox(raw) : null, error: raw ? null : 'Postfach nicht gefunden' };
          } catch (err) {
            return { instanceId: l.instanceId, instanceName: l.instanceName ?? '', mailbox: l.mailbox, info: null, error: (err as Error).message };
          }
        }),
      );
    });

    app.get<MeParams>('/me/:instanceId/:mailbox/aliases', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      return (await client.getList('alias/all'))
        .map(mapAlias)
        .filter((a) => a.goto.toLowerCase().split(/[,\s]+/).includes(mailbox) && a.address.toLowerCase() !== mailbox);
    });

    /* Wegwerf-Adressen (mailcow: "Spam-Aliasse" / time-limited aliases) */
    const tempList = async (client: ReturnType<typeof instances.client>, mailbox: string) =>
      (await client.getList(`time_limited_aliases/${enc(mailbox)}`)).map(mapTempAlias);

    app.get<MeParams>('/me/:instanceId/:mailbox/temp-aliases', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      return tempList(client, mailbox);
    });

    app.post<MeParams>('/me/:instanceId/:mailbox/temp-aliases', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      const b = parse(z.object({ validityHours: z.number().int().min(1).max(8760 * 2).optional(), description: z.string().max(200).optional() }), req.body ?? {});
      const before = new Set((await tempList(client, mailbox)).map((a) => a.address));
      const body: Record<string, unknown> = { username: mailbox, domain: domainOf(mailbox) };
      if (b.validityHours) body.validity = b.validityHours;
      if (b.description) body.description = b.description;
      await client.write('add/time_limited_alias', body);
      const after = await tempList(client, mailbox);
      return { created: after.find((a) => !before.has(a.address)) ?? null, items: after };
    });

    app.delete<MeParams & { Params: { address: string } }>('/me/:instanceId/:mailbox/temp-aliases/:address', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      const list = await tempList(client, mailbox);
      if (!list.some((a) => a.address.toLowerCase() === req.params.address.toLowerCase())) throw new NotFoundError('Wegwerf-Adresse');
      await client.write('delete/time_limited_alias', [req.params.address]);
      return { ok: true };
    });

    /* App-Passwörter */
    const appPwList = async (client: ReturnType<typeof instances.client>, mailbox: string) =>
      (await client.getList(`app-passwd/all/${enc(mailbox)}`)).map(mapAppPassword);

    app.get<MeParams>('/me/:instanceId/:mailbox/app-passwords', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      return appPwList(client, mailbox);
    });

    app.post<MeParams>('/me/:instanceId/:mailbox/app-passwords', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      const b = parse(z.object({ name: z.string().min(1).max(100), protocols: z.array(z.enum(PROTOCOLS)).min(1) }), req.body);
      const password = randomPassword();
      await client.write('add/app-passwd', {
        username: mailbox,
        app_name: b.name,
        app_passwd: password,
        app_passwd2: password,
        active: '1',
        protocols: b.protocols,
      });
      audit.log('mailcow.app_password_created', { req, details: { mailbox, name: b.name } });
      // Passwort nur in dieser Antwort – wird nirgends gespeichert
      return { password, items: await appPwList(client, mailbox) };
    });

    app.delete<MeParams & { Params: { id: string } }>('/me/:instanceId/:mailbox/app-passwords/:id', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      if (!(await appPwList(client, mailbox)).some((p) => p.id === req.params.id)) throw new NotFoundError('App-Passwort');
      await client.write('delete/app-passwd', [req.params.id]);
      audit.log('mailcow.app_password_deleted', { req, details: { mailbox, id: req.params.id } });
      return { ok: true };
    });

    /* Quarantäne */
    const myQuarantine = async (client: ReturnType<typeof instances.client>, mailbox: string) =>
      (await client.getList('quarantine/all')).map(mapQuarantine).filter((q) => q.recipient.toLowerCase() === mailbox);

    app.get<MeParams>('/me/:instanceId/:mailbox/quarantine', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      return myQuarantine(client, mailbox);
    });

    app.delete<MeParams & { Params: { qid: string } }>('/me/:instanceId/:mailbox/quarantine/:qid', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      if (!(await myQuarantine(client, mailbox)).some((q) => q.id === req.params.qid)) throw new NotFoundError('Quarantäne-Eintrag');
      await client.write('delete/qitem', [req.params.qid]);
      return { ok: true };
    });

    /* Postfach-Passwort ändern (Bestätigung mit dem Kuvert-Passwort) */
    app.post<MeParams>('/me/:instanceId/:mailbox/password', async (req) => {
      const { client, mailbox } = own(req, req.params.instanceId, req.params.mailbox);
      const b = parse(z.object({ kuvertPassword: z.string().min(1), password: z.string().min(8) }), req.body);
      if (!(await users.checkPassword(req.user.id, b.kuvertPassword))) throw new AppError(400, 'invalid_password', 'Kuvert-Passwort ist falsch');
      await client.write('edit/mailbox', { items: [mailbox], attr: { password: b.password, password2: b.password } });
      const updated = updateAccountSecrets(ctx, req.user.id, mailbox, b.password);
      audit.log('mailcow.mailbox_password_changed', { req, details: { mailbox, accountsUpdated: updated } });
      return { ok: true, accountsUpdated: updated };
    });
  },
});
