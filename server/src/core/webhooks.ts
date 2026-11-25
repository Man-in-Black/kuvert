/**
 * Ausgehende Webhooks: Ereignisse (neue Mail, Erinnerung, Versandstatus …) werden
 * als JSON per POST an eine URL geschickt – z. B. für n8n, Node-RED, Home Assistant.
 * Signatur: Header X-Kuvert-Signature = sha256=<HMAC-SHA256(secret, body)>.
 */
import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { WEBHOOK_EVENTS, type ServerEvent, type Webhook, type WebhookCreated, type WebhookEvent } from '@kuvert/shared';
import { getDb } from './db.js';
import { decrypt, encrypt, uuid } from './crypto.js';
import { NotFoundError } from './errors.js';
import type { EventBus } from './events.js';

interface WebhookRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  events_json: string;
  secret_enc: string;
  active: number;
  last_delivery_at: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
}

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  name: r.name,
  url: r.url,
  events: JSON.parse(r.events_json) as WebhookEvent[],
  active: !!r.active,
  createdAt: r.created_at,
  lastDeliveryAt: r.last_delivery_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
});

export const webhooks = {
  list(userId: string): Webhook[] {
    return (getDb().prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at').all(userId) as WebhookRow[]).map(toWebhook);
  },

  create(userId: string, input: { name: string; url: string; events: WebhookEvent[]; active?: boolean }): WebhookCreated {
    const id = uuid();
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    getDb()
      .prepare('INSERT INTO webhooks (id, user_id, name, url, events_json, secret_enc, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, input.name, input.url, JSON.stringify(input.events), encrypt(secret), input.active === false ? 0 : 1);
    return { webhook: toWebhook(getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow), secret };
  },

  update(userId: string, id: string, patch: { name?: string; url?: string; events?: WebhookEvent[]; active?: boolean }): Webhook {
    const r = getDb().prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(id, userId) as WebhookRow | undefined;
    if (!r) throw new NotFoundError('Webhook');
    getDb()
      .prepare('UPDATE webhooks SET name = ?, url = ?, events_json = ?, active = ? WHERE id = ?')
      .run(patch.name ?? r.name, patch.url ?? r.url, JSON.stringify(patch.events ?? JSON.parse(r.events_json)), patch.active === undefined ? r.active : patch.active ? 1 : 0, id);
    return toWebhook(getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow);
  },

  delete(userId: string, id: string) {
    getDb().prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(id, userId);
  },

  /** Zustellung mit bis zu 3 Versuchen; Ergebnis wird am Webhook vermerkt */
  async deliver(row: WebhookRow, event: string, data: unknown, log?: FastifyBaseLogger): Promise<{ status: number | null; error: string | null }> {
    const body = JSON.stringify({ id: uuid(), event, createdAt: new Date().toISOString(), data });
    const signature = crypto.createHmac('sha256', decrypt(row.secret_enc)).update(body).digest('hex');
    let status: number | null = null;
    let error: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(row.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Kuvert-Webhook/1.0', 'X-Kuvert-Event': event, 'X-Kuvert-Signature': `sha256=${signature}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        error = res.ok ? null : `HTTP ${res.status}`;
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break;
      } catch (err) {
        error = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt));
    }
    getDb()
      .prepare(`UPDATE webhooks SET last_delivery_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status = ?, last_error = ? WHERE id = ?`)
      .run(status, error, row.id);
    if (error) log?.warn({ webhook: row.id, error }, 'Webhook-Zustellung fehlgeschlagen');
    return { status, error };
  },

  async test(userId: string, id: string) {
    const r = getDb().prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(id, userId) as WebhookRow | undefined;
    if (!r) throw new NotFoundError('Webhook');
    return this.deliver(r, 'test', { message: 'Testereignis von Kuvert' });
  },

  /** Hängt sich an den Ereignisbus und verteilt passende Ereignisse */
  install(bus: EventBus, log: FastifyBaseLogger) {
    bus.internal.on('user.event', (userId: string, e: ServerEvent) => {
      // Nur abonnierbare Ereignisse (spart DB-Abfragen bei Tipp-/Präsenz-Ereignissen des Chats)
      if (!(WEBHOOK_EVENTS as string[]).includes(e.type)) return;
      const rows = getDb().prepare('SELECT * FROM webhooks WHERE user_id = ? AND active = 1').all(userId) as WebhookRow[];
      for (const r of rows) {
        const events = JSON.parse(r.events_json) as string[];
        if (!events.includes(e.type)) continue;
        const { type, ...data } = e;
        void this.deliver(r, type, data, log);
      }
    });
  },
};
