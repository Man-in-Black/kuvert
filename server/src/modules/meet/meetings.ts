/**
 * Meetings mit festem Link (z. B. aus einem Kalendertermin): Der Link /join/<token> bleibt gültig,
 * bis das Meeting gelöscht wird. Spontane Meetings (ohne Termin) verfallen nach einigen Tagen von selbst. Wer angemeldet ist, tritt direkt bei; Gäste klopfen an und warten,
 * bis jemand aus Kuvert sie zulässt.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { MeetMeeting } from '@kuvert/shared';
import { config } from '../../config.js';
import { getDb } from '../../core/db.js';
import { AppError } from '../../core/errors.js';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const migrations = [
  {
    id: 'meet-001',
    sql: `
      CREATE TABLE meet_meetings (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX meet_meetings_owner ON meet_meetings(owner_id);
    `,
  },
  {
    id: 'meet-002',
    sql: `ALTER TABLE meet_meetings ADD COLUMN expires_at TEXT;`,
  },
];

/** Spontane Meetings gelten so lange (z. B. für Gäste, die später noch einmal beitreten) */
export const ADHOC_DAYS = 7;

interface MeetingRow {
  id: string;
  token: string;
  title: string;
  owner_id: string;
  created_at: string;
  expires_at: string | null;
}

export interface Meeting {
  id: string;
  token: string;
  title: string;
  ownerId: string;
  createdAt: string;
  /** Spontane Meetings: verfallen zu diesem Zeitpunkt (ISO), sonst null */
  expiresAt: string | null;
}

/** Nicht erratbarer Teil der Einladungslinks (144 Bit) */
export const newLinkToken = () => randomBytes(18).toString('base64url');

/** Vollständiger Link zum Beitreten */
export const joinUrl = (token: string) => `${config.publicUrl}/join/${token}`;

const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  token: r.token,
  title: r.title,
  ownerId: r.owner_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export const toPublicMeeting = (m: Meeting): MeetMeeting => ({
  id: m.id,
  title: m.title,
  url: joinUrl(m.token),
  createdAt: m.createdAt,
  expiresAt: m.expiresAt,
});

/** Nicht abgelaufen (Vergleich als ISO-Zeichenkette) */
const ALIVE = `(expires_at IS NULL OR expires_at > ${NOW})`;

const db = () => getDb();

export const meetings = {
  /** Meeting anlegen; adhoc = spontan (ohne Termin), verfällt nach ADHOC_DAYS Tagen */
  create(ownerId: string, title: string, opts: { adhoc?: boolean } = {}): Meeting {
    const id = randomUUID();
    const expires = opts.adhoc ? new Date(Date.now() + ADHOC_DAYS * 86_400_000).toISOString() : null;
    db()
      .prepare('INSERT INTO meet_meetings (id, token, title, owner_id, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, newLinkToken(), title, ownerId, expires);
    return this.require(id);
  },

  get(id: string): Meeting | null {
    const r = db().prepare(`SELECT * FROM meet_meetings WHERE id = ? AND ${ALIVE}`).get(id) as MeetingRow | undefined;
    return r ? toMeeting(r) : null;
  },

  require(id: string): Meeting {
    const m = this.get(id);
    if (!m) throw new AppError(404, 'not_found', 'Meeting nicht gefunden');
    return m;
  },

  byToken(token: string): Meeting | null {
    if (!/^[\w-]{16,64}$/.test(token)) return null;
    const r = db().prepare(`SELECT * FROM meet_meetings WHERE token = ? AND ${ALIVE}`).get(token) as MeetingRow | undefined;
    return r ? toMeeting(r) : null;
  },

  listForOwner(ownerId: string): Meeting[] {
    return (
      db().prepare(`SELECT * FROM meet_meetings WHERE owner_id = ? AND ${ALIVE} ORDER BY created_at DESC LIMIT 200`).all(ownerId) as MeetingRow[]
    ).map(toMeeting);
  },

  rename(id: string, title: string) {
    db().prepare('UPDATE meet_meetings SET title = ? WHERE id = ?').run(title, id);
  },

  delete(id: string) {
    db().prepare('DELETE FROM meet_meetings WHERE id = ?').run(id);
  },

  /** Abgelaufene spontane Meetings entfernen – außer solchen mit laufendem Anruf */
  deleteExpired(active: (id: string) => boolean): number {
    const expired = db().prepare(`SELECT id FROM meet_meetings WHERE expires_at IS NOT NULL AND expires_at <= ${NOW}`).all() as { id: string }[];
    let n = 0;
    for (const { id } of expired) {
      if (active(id)) continue;
      this.delete(id);
      n++;
    }
    return n;
  },
};
