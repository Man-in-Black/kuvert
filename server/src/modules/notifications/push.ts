import * as webpush from 'web-push';
import { config } from '../../config.js';
import { getDb, kv } from '../../core/db.js';
import { uuid } from '../../core/crypto.js';

export const migrations = [
  {
    id: 'notifications-001',
    sql: `
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        keys_json TEXT NOT NULL,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  /** Benachrichtigung bleibt stehen, bis sie angeklickt/weggewischt wird (z. B. Terminerinnerung) */
  requireInteraction?: boolean;
}

let vapidPublic = '';

/** VAPID-Schlüssel aus Umgebung oder einmalig generiert im Datenbank-KV. */
export function initVapid(): string {
  let pub = config.vapid.publicKey;
  let priv = config.vapid.privateKey;
  if (!pub || !priv) {
    const stored = kv.get<{ publicKey: string; privateKey: string }>('push', 'vapid');
    if (stored) ({ publicKey: pub, privateKey: priv } = stored);
    else {
      const keys = webpush.generateVAPIDKeys();
      kv.set('push', 'vapid', keys);
      ({ publicKey: pub, privateKey: priv } = keys);
    }
  }
  webpush.setVapidDetails(config.vapid.subject, pub, priv);
  kv.set('push', 'vapidPublicKey', pub);
  vapidPublic = pub;
  return pub;
}

export const pushStore = {
  publicKey: () => vapidPublic,

  subscribe(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
    getDb()
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json, user_agent) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json`,
      )
      .run(uuid(), userId, sub.endpoint, JSON.stringify(sub.keys), userAgent ?? null);
  },

  unsubscribe(userId: string, endpoint: string) {
    getDb().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  },

  hasSubscriptions(userId: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(userId);
  },

  async send(userId: string, payload: PushPayload): Promise<number> {
    const subs = getDb().prepare('SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id = ?').all(userId) as {
      endpoint: string;
      keys_json: string;
    }[];
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, JSON.stringify(payload), {
            TTL: 3600,
            // „high“: Android stellt die Nachricht auch im Doze-Modus sofort zu (sonst erst im nächsten Wartungsfenster)
            urgency: 'high',
          });
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // Abgelaufene/abgemeldete Abos entfernen
          if (status === 404 || status === 410) getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        }
      }),
    );
    return sent;
  },
};
