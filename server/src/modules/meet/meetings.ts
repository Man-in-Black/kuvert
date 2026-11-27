/**
 * Meetings mit festem Link (z. B. aus einem Kalendertermin): Der Link /join/<token> bleibt gültig,
 * bis das Meeting gelöscht wird. Wer angemeldet ist, tritt direkt bei; Gäste klopfen an und warten,
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
];

interface MeetingRow {
  id: string;
  token: string;
  title: string;
  owner_id: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  token: string;
  title: string;
  ownerId: string;
  createdAt: string;
}

/** Nicht erratbarer Teil der Einladungslinks (144 Bit) */
export const newLinkToken = () => randomBytes(18).toString('base64url');

/** Vollständiger Link zum Beitreten */
export const joinUrl = (token: string) => `${config.publicUrl}/join/${token}`;

const toMeeting = (r: MeetingRow): Meeting => ({ id: r.id, token: r.token, title: r.title, ownerId: r.owner_id, createdAt: r.created_at });

export const toPublicMeeting = (m: Meeting): MeetMeeting => ({ id: m.id, title: m.title, url: joinUrl(m.token), createdAt: m.createdAt });

const db = () => getDb();

export const meetings = {
  create(ownerId: string, title: string): Meeting {
    const id = randomUUID();
    db().prepare('INSERT INTO meet_meetings (id, token, title, owner_id) VALUES (?, ?, ?, ?)').run(id, newLinkToken(), title, ownerId);
    return this.require(id);
  },

  get(id: string): Meeting | null {
    const r = db().prepare('SELECT * FROM meet_meetings WHERE id = ?').get(id) as MeetingRow | undefined;
    return r ? toMeeting(r) : null;
  },

  require(id: string): Meeting {
    const m = this.get(id);
    if (!m) throw new AppError(404, 'not_found', 'Meeting nicht gefunden');
    return m;
  },

  byToken(token: string): Meeting | null {
    if (!/^[\w-]{16,64}$/.test(token)) return null;
    const r = db().prepare('SELECT * FROM meet_meetings WHERE token = ?').get(token) as MeetingRow | undefined;
    return r ? toMeeting(r) : null;
  },

  listForOwner(ownerId: string): Meeting[] {
    return (db().prepare('SELECT * FROM meet_meetings WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200').all(ownerId) as MeetingRow[]).map(toMeeting);
  },

  rename(id: string, title: string) {
    db().prepare('UPDATE meet_meetings SET title = ? WHERE id = ?').run(title, id);
  },

  delete(id: string) {
    db().prepare('DELETE FROM meet_meetings WHERE id = ?').run(id);
  },
};
