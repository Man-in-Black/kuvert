import type { FastifyBaseLogger } from 'fastify';
import type { EmailAddress, MailIdentity, OutgoingMessage, ScheduledSend, SendResult } from '@kuvert/shared';
import { getDb } from './db.js';
import { decryptJson, encryptJson, uuid } from './crypto.js';
import { BadRequestError, NotFoundError } from './errors.js';
import { buildMime, htmlToText } from './mime.js';
import { uploads } from './uploads.js';
import type { AccountService } from './accounts.js';
import type { EventBus } from './events.js';
import type { Hooks } from './hooks.js';
import type { ResolvedOutgoingMessage } from './providers.js';

interface ScheduledRow {
  id: string;
  user_id: string;
  account_id: string;
  payload_enc: string;
  subject: string;
  recipients_json: string;
  send_at: string;
  status: ScheduledSend['status'];
  error: string | null;
}

/**
 * Versand-Logik: Anhänge auflösen, Identität wählen, Rohversand bei S/MIME,
 * verzögerter Versand (Rückgängig/Später senden), Empfänger merken.
 */
export class MailService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private accounts: AccountService,
    private hooks: Hooks,
    private bus: EventBus,
    private log: FastifyBaseLogger,
  ) {}

  /* ───────────── Aufbereitung ───────────── */

  pickIdentity(identities: MailIdentity[], msg: OutgoingMessage): MailIdentity | undefined {
    if (msg.identityId) {
      const byId = identities.find((i) => i.id === msg.identityId);
      if (byId) return byId;
    }
    const addr = msg.from?.address?.toLowerCase();
    return identities.find((i) => i.address.toLowerCase() === addr) ?? identities[0];
  }

  async resolve(userId: string, msg: OutgoingMessage, identities: MailIdentity[]): Promise<ResolvedOutgoingMessage> {
    if (!msg.to?.length && !msg.cc?.length && !msg.bcc?.length) throw new BadRequestError('Mindestens ein Empfänger ist erforderlich');
    const identity = this.pickIdentity(identities, msg);
    const from: EmailAddress = msg.from?.address
      ? msg.from
      : identity
        ? { name: identity.name, address: identity.address }
        : (() => {
            throw new BadRequestError('Absender fehlt');
          })();

    const attachments: ResolvedOutgoingMessage['attachments'] = [];
    for (const a of msg.attachments ?? []) {
      if (a.uploadId) {
        const u = uploads.get(userId, a.uploadId);
        attachments.push({ filename: a.filename || u.filename, contentType: a.contentType || u.contentType, data: u.data, inline: a.inline, contentId: a.contentId });
      } else if (a.contentBase64) {
        attachments.push({
          filename: a.filename,
          contentType: a.contentType || 'application/octet-stream',
          data: Buffer.from(a.contentBase64, 'base64'),
          inline: a.inline,
          contentId: a.contentId,
        });
      }
    }

    return {
      from,
      to: msg.to ?? [],
      cc: msg.cc ?? [],
      bcc: msg.bcc ?? [],
      replyTo: msg.replyTo ?? [],
      subject: msg.subject ?? '',
      html: msg.html,
      text: msg.text ?? (msg.html ? htmlToText(msg.html) : ''),
      attachments,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      reference: msg.reference,
      importance: msg.importance,
      requestReadReceipt: msg.requestReadReceipt,
      identity,
    };
  }

  /* ───────────── Versand ───────────── */

  /** Sendet sofort (ohne Verzögerung). */
  async deliver(userId: string, accountId: string, msg: OutgoingMessage): Promise<void> {
    const mail = this.accounts.require(userId, accountId, 'mail');
    const identities = await mail.listIdentities().catch(() => [] as MailIdentity[]);
    const resolved = await this.resolve(userId, msg, identities);

    const transformers = this.hooks.rawSend.filter((t) => t.applies(msg)).sort((a, b) => a.order - b.order);
    if (transformers.length) {
      let raw = await buildMime(resolved);
      for (const t of transformers) raw = await t.transform({ userId, accountId, message: msg }, raw);
      await mail.sendRaw(raw, {
        from: resolved.from.address,
        to: [...resolved.to, ...resolved.cc, ...resolved.bcc].map((a) => a.address),
        identity: resolved.identity,
      });
    } else {
      await mail.send(resolved);
    }

    if (msg.draftId && msg.draftFolderId) {
      await mail.delete(msg.draftFolderId, [msg.draftId], true).catch((err) => this.log.warn({ err }, 'Entwurf konnte nicht gelöscht werden'));
    }
    this.recordRecipients(userId, [...resolved.to, ...resolved.cc, ...resolved.bcc]);
    for (const h of this.hooks.afterSend) {
      try {
        await h({ userId, accountId, message: msg });
      } catch (err) {
        this.log.warn({ err }, 'afterSend-Hook fehlgeschlagen');
      }
    }
    this.bus.publish(userId, { type: 'mail.changed', accountId });
  }

  /** Sendet sofort oder plant (Undo-Verzögerung bzw. "später senden"). */
  async submit(userId: string, accountId: string, msg: OutgoingMessage, undoSeconds: number): Promise<SendResult> {
    this.accounts.require(userId, accountId, 'mail'); // Konto prüfen
    const now = Date.now();
    let sendAt: Date | null = null;
    if (msg.sendAt) {
      const t = new Date(msg.sendAt);
      if (Number.isNaN(t.getTime())) throw new BadRequestError('Ungültiger Sendezeitpunkt');
      if (t.getTime() > now + 1000) sendAt = t;
    }
    if (!sendAt && undoSeconds > 0) sendAt = new Date(now + undoSeconds * 1000);

    if (!sendAt) {
      await this.deliver(userId, accountId, msg);
      return { status: 'sent' };
    }

    const id = uuid();
    const recipients = [...(msg.to ?? []), ...(msg.cc ?? []), ...(msg.bcc ?? [])];
    getDb()
      .prepare(
        `INSERT INTO scheduled_sends (id, user_id, account_id, payload_enc, subject, recipients_json, send_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, accountId, encryptJson(msg), msg.subject ?? '', JSON.stringify(recipients), sendAt.toISOString());
    const uploadIds = (msg.attachments ?? []).map((a) => a.uploadId).filter((x): x is string => !!x);
    if (uploadIds.length) uploads.keepUntil(uploadIds, new Date(sendAt.getTime() + 86_400_000));
    this.bus.publish(userId, { type: 'send.status', jobId: id, status: 'scheduled', subject: msg.subject });
    return { status: 'scheduled', jobId: id, sendAt: sendAt.toISOString() };
  }

  cancel(userId: string, jobId: string): OutgoingMessage {
    const row = getDb().prepare('SELECT * FROM scheduled_sends WHERE id = ? AND user_id = ?').get(jobId, userId) as ScheduledRow | undefined;
    if (!row) throw new NotFoundError('Geplanter Versand');
    if (row.status !== 'pending') throw new BadRequestError('Die Nachricht wurde bereits verarbeitet');
    getDb().prepare(`UPDATE scheduled_sends SET status = 'cancelled' WHERE id = ?`).run(jobId);
    this.bus.publish(userId, { type: 'send.status', jobId, status: 'cancelled', subject: row.subject });
    // Nachricht zurückgeben, damit der Client den Entwurf wiederherstellen kann
    return decryptJson<OutgoingMessage>(row.payload_enc);
  }

  listScheduled(userId: string): ScheduledSend[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM scheduled_sends WHERE user_id = ? AND (status IN ('pending','sending','failed') OR send_at > datetime('now','-1 day'))
         ORDER BY send_at DESC LIMIT 200`,
      )
      .all(userId) as ScheduledRow[];
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      subject: r.subject,
      to: JSON.parse(r.recipients_json),
      sendAt: r.send_at,
      status: r.status,
      error: r.error,
    }));
  }

  startScheduler() {
    getDb().prepare(`UPDATE scheduled_sends SET status = 'pending' WHERE status = 'sending'`).run();
    this.timer = setInterval(() => void this.tick(), 2000);
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = getDb()
        .prepare(`SELECT * FROM scheduled_sends WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 10`)
        .all(new Date().toISOString()) as ScheduledRow[];
      for (const row of due) {
        const claimed = getDb().prepare(`UPDATE scheduled_sends SET status = 'sending' WHERE id = ? AND status = 'pending'`).run(row.id);
        if (!claimed.changes) continue;
        try {
          await this.deliver(row.user_id, row.account_id, decryptJson<OutgoingMessage>(row.payload_enc));
          getDb().prepare(`UPDATE scheduled_sends SET status = 'sent', payload_enc = ? WHERE id = ?`).run(encryptJson({}), row.id);
          this.bus.publish(row.user_id, { type: 'send.status', jobId: row.id, status: 'sent', subject: row.subject });
        } catch (err) {
          const message = (err as Error).message;
          this.log.error({ err, jobId: row.id }, 'Geplanter Versand fehlgeschlagen');
          getDb().prepare(`UPDATE scheduled_sends SET status = 'failed', error = ? WHERE id = ?`).run(message, row.id);
          this.bus.publish(row.user_id, { type: 'send.status', jobId: row.id, status: 'failed', error: message, subject: row.subject });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Erneut versuchen (fehlgeschlagener Job) */
  retry(userId: string, jobId: string) {
    const r = getDb()
      .prepare(`UPDATE scheduled_sends SET status = 'pending', error = NULL, send_at = ? WHERE id = ? AND user_id = ? AND status = 'failed'`)
      .run(new Date().toISOString(), jobId, userId);
    if (!r.changes) throw new NotFoundError('Fehlgeschlagener Versand');
  }

  /* ───────────── Adress-Historie für Autovervollständigung ───────────── */

  recordRecipients(userId: string, addrs: EmailAddress[]) {
    const stmt = getDb().prepare(
      `INSERT INTO recent_addresses (user_id, address, name) VALUES (?, ?, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET count = count + 1, last_used = datetime('now'), name = COALESCE(excluded.name, name)`,
    );
    getDb().transaction(() => {
      for (const a of addrs) if (a.address) stmt.run(userId, a.address.trim(), a.name ?? null);
    })();
  }
}
