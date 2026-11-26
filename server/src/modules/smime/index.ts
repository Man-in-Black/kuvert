/**
 * S/MIME-Modul:
 *  - Versand: signieren und/oder verschlüsseln (Hook rawSend)
 *  - Empfang: Signatur prüfen, entschlüsseln, Absenderzertifikat merken (Hook messageView)
 *  - Verwaltung eigener (.p12/.pfx) und fremder (.pem/.cer) Zertifikate
 */
import crypto from 'node:crypto';
import type { MessageDetail } from '@kuvert/shared';
import { BadRequestError } from '../../core/errors.js';
import { looksLikeSmime, parseRawMessage, type ParsedAttachment } from '../../core/mime.js';
import { defineModule } from '../../core/module.js';
import type { BinaryContent, MailProvider } from '../../core/providers.js';
import { encryptMessage, processIncoming, signMessage } from './mime-ops.js';
import { certDetails, opensslAvailable, readPkcs12, splitPem, toPem } from './openssl.js';
import { migrations, smimeStore } from './store.js';

/* ───────────── Cache für entschlüsselte Anhänge ───────────── */

const cache = new Map<string, ParsedAttachment[]>();
const cacheKey = (userId: string, accountId: string, folderId: string, messageId: string) => `${userId}|${accountId}|${folderId}|${messageId}`;
function remember(key: string, atts: ParsedAttachment[]) {
  cache.set(key, atts);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
}

async function decode(userId: string, mail: MailProvider, folderId: string, msg: Pick<MessageDetail, 'id' | 'from'>) {
  const raw = await mail.getRawMessage(folderId, msg.id);
  const { message, security } = await processIncoming(userId, raw, msg.from?.address);
  const parsed = await parseRawMessage(message);
  const attachments = parsed.attachments
    .filter((a) => !/pkcs7-signature/i.test(a.info.contentType) && a.info.filename.toLowerCase() !== 'smime.p7s')
    .map((a) => ({ ...a, info: { ...a.info, id: `smime:${a.info.id}` } }));
  return { parsed, attachments, security };
}

async function readMultipart(req: import('fastify').FastifyRequest): Promise<{ file?: { filename: string; data: Buffer }; fields: Record<string, string> }> {
  const fields: Record<string, string> = {};
  let file: { filename: string; data: Buffer } | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') file = { filename: part.filename, data: await part.toBuffer() };
    else fields[part.fieldname] = String(part.value ?? '');
  }
  return { file, fields };
}

export default defineModule({
  id: 'smime',
  name: 'S/MIME',
  description: 'Signieren und Verschlüsseln von E-Mails (X.509)',
  features: ['smime'],
  migrations,
  isEnabled: () => opensslAvailable(),

  init(ctx) {
    /* Anzeige: S/MIME-Nachrichten prüfen bzw. entschlüsseln */
    ctx.hooks.messageView.push(async (vctx, msg) => {
      const kind = looksLikeSmime(msg);
      if (!kind) return msg;
      try {
        const { parsed, attachments, security } = await decode(vctx.userId, vctx.mail, vctx.folderId, msg);
        remember(cacheKey(vctx.userId, vctx.accountId, vctx.folderId, msg.id), attachments);
        // Liefert der Liste die echte Art nach (dort ist sie z. B. bei Relays/Graph nicht immer erkennbar)
        const smime = security.encrypted ? 'encrypted' : security.signed ? 'signed' : kind;
        if (security.encrypted && !security.decrypted) return { ...msg, smime, security };
        return {
          ...msg,
          smime,
          html: parsed.detail.html,
          text: parsed.detail.text,
          preview: parsed.detail.preview,
          invite: parsed.detail.invite ?? msg.invite,
          attachments: attachments.map((a) => a.info),
          hasAttachments: attachments.some((a) => !a.info.inline),
          security,
        };
      } catch (err) {
        ctx.log.warn({ err }, 'S/MIME-Verarbeitung fehlgeschlagen');
        return { ...msg, smime: kind, security: { error: `S/MIME-Verarbeitung fehlgeschlagen: ${(err as Error).message}` } };
      }
    });

    /* Anhänge entschlüsselter Nachrichten ausliefern */
    ctx.hooks.attachmentResolvers.push(async (vctx, messageId, attachmentId): Promise<BinaryContent | undefined> => {
      if (!attachmentId.startsWith('smime:')) return undefined;
      const key = cacheKey(vctx.userId, vctx.accountId, vctx.folderId, messageId);
      let atts = cache.get(key);
      if (!atts) {
        const msg = await vctx.mail.getMessage(vctx.folderId, messageId);
        atts = (await decode(vctx.userId, vctx.mail, vctx.folderId, msg)).attachments;
        remember(key, atts);
      }
      const a = atts.find((x) => x.info.id === attachmentId);
      if (!a) throw new BadRequestError('Anhang nicht gefunden');
      return { filename: a.info.filename, contentType: a.info.contentType, data: a.content };
    });

    /* Versand: erst signieren, dann verschlüsseln */
    ctx.hooks.rawSend.push({
      id: 'smime-sign',
      order: 10,
      applies: (m) => !!m.smime?.sign,
      transform: (c, raw) => signMessage(c.userId, raw, c.message.from.address),
    });
    ctx.hooks.rawSend.push({
      id: 'smime-encrypt',
      order: 20,
      applies: (m) => !!m.smime?.encrypt,
      transform: (c, raw) =>
        encryptMessage(
          c.userId,
          raw,
          [...(c.message.to ?? []), ...(c.message.cc ?? []), ...(c.message.bcc ?? [])].map((a) => a.address),
          c.message.from.address,
        ),
    });
  },

  routes(app) {
    /* ───────────── Eigene Zertifikate ───────────── */
    app.get('/certs', async (req) => smimeStore.list(req.user.id));

    /** Upload: .p12/.pfx (+ Passwort) oder PEM mit Zertifikat und Schlüssel */
    app.post('/certs', async (req) => {
      const { file, fields } = await readMultipart(req);
      if (!file) throw new BadRequestError('Keine Datei übermittelt');
      const password = fields.password ?? '';
      const text = file.data.toString('utf8');
      if (text.includes('-----BEGIN CERTIFICATE-----') && /PRIVATE KEY-----/.test(text)) {
        const certs = splitPem(text);
        const keyBlock = text.match(/-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----/)?.[0];
        if (!keyBlock || !certs[0]) throw new BadRequestError('PEM enthält kein Zertifikat/keinen Schlüssel');
        const key = crypto.createPrivateKey({ key: keyBlock, passphrase: password || undefined });
        return smimeStore.add(req.user.id, certs[0], key.export({ type: 'pkcs8', format: 'pem' }).toString(), certs.slice(1).join('\n'));
      }
      try {
        const { certPem, keyPem, chainPem } = await readPkcs12(file.data, password);
        return smimeStore.add(req.user.id, certPem, keyPem, chainPem);
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
    });

    app.delete<{ Params: { id: string } }>('/certs/:id', async (req) => {
      smimeStore.delete(req.user.id, req.params.id);
      return { ok: true };
    });

    /* ───────────── Empfänger-Zertifikate ───────────── */
    app.get('/contacts', async (req) => smimeStore.contacts(req.user.id));

    app.post('/contacts', async (req) => {
      const { file, fields } = await readMultipart(req);
      if (!file) throw new BadRequestError('Keine Datei übermittelt');
      let pem: string;
      try {
        pem = toPem(file.data);
        certDetails(pem);
      } catch {
        throw new BadRequestError('Kein gültiges X.509-Zertifikat (PEM/DER erwartet)');
      }
      const emails = smimeStore.saveContact(req.user.id, splitPem(pem)[0] ?? pem, fields.email);
      if (!emails.length) throw new BadRequestError('Zertifikat enthält keine E-Mail-Adresse – bitte Adresse angeben');
      return { ok: true, emails };
    });

    app.delete<{ Params: { email: string } }>('/contacts/:email', async (req) => {
      smimeStore.deleteContact(req.user.id, req.params.email);
      return { ok: true };
    });

    /** Welche Empfänger haben ein Zertifikat? → { "a@b.de": true, … } */
    app.get<{ Querystring: { emails?: string } }>('/recipients', async (req) => {
      const out: Record<string, boolean> = {};
      for (const e of (req.query.emails ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        out[e] = !!smimeStore.recipientCert(req.user.id, e);
      }
      return out;
    });

    /** Kann der Benutzer mit dieser Adresse signieren? */
    app.get<{ Querystring: { address?: string } }>('/can-sign', async (req) => ({
      canSign: !!(req.query.address && smimeStore.signerFor(req.user.id, req.query.address)),
    }));
  },
});
