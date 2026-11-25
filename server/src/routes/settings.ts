import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Signature, Template, UserSettings } from '@kuvert/shared';
import { config } from '../config.js';
import { getDb } from '../core/db.js';
import { parseRawMessage } from '../core/mime.js';
import { uuid } from '../core/crypto.js';
import { BadRequestError, NotFoundError } from '../core/errors.js';
import type { ModuleContext } from '../core/module.js';
import { uploads } from '../core/uploads.js';
import { users } from '../core/users.js';
import { parse, sendFile } from './util.js';

const signatureSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['html', 'raw']),
  content: z.string().max(500_000),
  accountId: z.string().nullable().optional(),
  identityAddress: z.string().nullable().optional(),
  defaultNew: z.boolean().default(false),
  defaultReply: z.boolean().default(false),
});

const templateSchema = z.object({ name: z.string().min(1).max(200), subject: z.string().optional(), html: z.string().max(500_000) });

interface SignatureRow {
  id: string;
  name: string;
  mode: 'html' | 'raw';
  content: string;
  account_id: string | null;
  identity_address: string | null;
  default_new: number;
  default_reply: number;
}

const toSignature = (r: SignatureRow): Signature => ({
  id: r.id,
  name: r.name,
  mode: r.mode,
  content: r.content,
  accountId: r.account_id,
  identityAddress: r.identity_address,
  defaultNew: !!r.default_new,
  defaultReply: !!r.default_reply,
});

export async function settingsRoutes(app: FastifyInstance, _ctx: ModuleContext) {
  /* ───────────── Benutzereinstellungen ───────────── */

  app.get('/api/settings', async (req) => users.getSettings(req.user.id));

  app.put('/api/settings', async (req) => {
    const patch = parse(z.record(z.string(), z.unknown()), req.body) as Partial<UserSettings>;
    return users.saveSettings(req.user.id, patch);
  });

  /* ───────────── Signaturen ───────────── */

  app.get('/api/signatures', async (req) =>
    (getDb().prepare('SELECT * FROM signatures WHERE user_id = ? ORDER BY name').all(req.user.id) as SignatureRow[]).map(toSignature),
  );

  const clearDefaults = (userId: string, s: z.infer<typeof signatureSchema>, exceptId: string) => {
    // Pro Konto (bzw. global) darf es nur eine Standard-Signatur je Art geben
    const scope = s.accountId ?? null;
    if (s.defaultNew)
      getDb().prepare('UPDATE signatures SET default_new = 0 WHERE user_id = ? AND account_id IS ? AND id != ?').run(userId, scope, exceptId);
    if (s.defaultReply)
      getDb().prepare('UPDATE signatures SET default_reply = 0 WHERE user_id = ? AND account_id IS ? AND id != ?').run(userId, scope, exceptId);
  };

  app.post('/api/signatures', async (req) => {
    const s = parse(signatureSchema, req.body);
    const id = uuid();
    getDb()
      .prepare(
        `INSERT INTO signatures (id, user_id, name, mode, content, account_id, identity_address, default_new, default_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.user.id, s.name, s.mode, s.content, s.accountId ?? null, s.identityAddress ?? null, s.defaultNew ? 1 : 0, s.defaultReply ? 1 : 0);
    clearDefaults(req.user.id, s, id);
    return toSignature(getDb().prepare('SELECT * FROM signatures WHERE id = ?').get(id) as SignatureRow);
  });

  app.put<{ Params: { id: string } }>('/api/signatures/:id', async (req) => {
    const s = parse(signatureSchema, req.body);
    const r = getDb()
      .prepare(
        `UPDATE signatures SET name = ?, mode = ?, content = ?, account_id = ?, identity_address = ?, default_new = ?, default_reply = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(s.name, s.mode, s.content, s.accountId ?? null, s.identityAddress ?? null, s.defaultNew ? 1 : 0, s.defaultReply ? 1 : 0, req.params.id, req.user.id);
    if (!r.changes) throw new NotFoundError('Signatur');
    clearDefaults(req.user.id, s, req.params.id);
    return toSignature(getDb().prepare('SELECT * FROM signatures WHERE id = ?').get(req.params.id) as SignatureRow);
  });

  app.delete<{ Params: { id: string } }>('/api/signatures/:id', async (req) => {
    getDb().prepare('DELETE FROM signatures WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    return { ok: true };
  });

  /* ───────────── Vorlagen / Textbausteine ───────────── */

  app.get('/api/templates', async (req) =>
    (getDb().prepare('SELECT id, name, subject, html FROM templates WHERE user_id = ? ORDER BY name').all(req.user.id) as Template[]),
  );

  app.post('/api/templates', async (req) => {
    const t = parse(templateSchema, req.body);
    const id = uuid();
    getDb().prepare('INSERT INTO templates (id, user_id, name, subject, html) VALUES (?, ?, ?, ?, ?)').run(id, req.user.id, t.name, t.subject ?? null, t.html);
    return { id, ...t } satisfies Template;
  });

  app.put<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    const t = parse(templateSchema, req.body);
    const r = getDb()
      .prepare('UPDATE templates SET name = ?, subject = ?, html = ? WHERE id = ? AND user_id = ?')
      .run(t.name, t.subject ?? null, t.html, req.params.id, req.user.id);
    if (!r.changes) throw new NotFoundError('Vorlage');
    return { id: req.params.id, ...t } satisfies Template;
  });

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    getDb().prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    return { ok: true };
  });

  /* ───────────── Uploads (Anhänge, Bilder im Editor) ───────────── */

  app.post('/api/uploads', async (req) => {
    const file = await req.file({ limits: { fileSize: config.uploadMaxMb * 1024 * 1024 } });
    if (!file) throw new BadRequestError('Keine Datei übermittelt');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new BadRequestError(`Datei größer als ${config.uploadMaxMb} MB`);
    return uploads.save(req.user.id, file.filename, file.mimetype, data);
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/api/uploads/:id', async (req, reply) => {
    const u = uploads.get(req.user.id, req.params.id);
    return sendFile(reply, u, req.query.inline === '1');
  });

  /** Hochgeladene .eml-Datei als Nachricht lesen (Vorschau im Verfassen-Fenster) */
  app.get<{ Params: { id: string } }>('/api/uploads/:id/message', async (req) => {
    const u = uploads.get(req.user.id, req.params.id);
    if (!isRfc822(u)) throw new BadRequestError('Die Datei ist keine E-Mail-Nachricht');
    return (await parseRawMessage(u.data)).detail;
  });

  app.get<{ Params: { id: string; attId: string }; Querystring: { inline?: string } }>('/api/uploads/:id/message/attachments/:attId', async (req, reply) => {
    const u = uploads.get(req.user.id, req.params.id);
    if (!isRfc822(u)) throw new BadRequestError('Die Datei ist keine E-Mail-Nachricht');
    const att = (await parseRawMessage(u.data)).attachments.find((a) => a.info.id === req.params.attId);
    if (!att) throw new NotFoundError('Anhang');
    return sendFile(reply, { filename: att.info.filename, contentType: att.info.contentType, data: att.content }, req.query.inline === '1');
  });

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (req) => {
    uploads.delete(req.user.id, req.params.id);
    return { ok: true };
  });
}

const isRfc822 = (u: { filename: string; contentType: string }) =>
  u.contentType.toLowerCase() === 'message/rfc822' || u.filename.toLowerCase().endsWith('.eml');
