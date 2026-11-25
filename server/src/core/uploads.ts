import fs from 'node:fs';
import path from 'node:path';
import type { UploadInfo } from '@kuvert/shared';
import { config } from '../config.js';
import { getDb } from './db.js';
import { uuid } from './crypto.js';
import { NotFoundError } from './errors.js';
import type { BinaryContent } from './providers.js';

const dir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(dir, { recursive: true });

/** Temporärer Speicher für Anhänge (Composer-Uploads, aus Cloud importierte Dateien). */
export const uploads = {
  save(userId: string, filename: string, contentType: string, data: Buffer): UploadInfo {
    const id = uuid();
    fs.writeFileSync(path.join(dir, id), data);
    getDb()
      .prepare('INSERT INTO uploads (id, user_id, filename, content_type, size) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, filename, contentType || 'application/octet-stream', data.length);
    return { id, filename, contentType: contentType || 'application/octet-stream', size: data.length };
  },

  get(userId: string, id: string): BinaryContent & { size: number } {
    const row = getDb().prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, userId) as
      | { filename: string; content_type: string; size: number }
      | undefined;
    const file = path.join(dir, id);
    if (!row || !fs.existsSync(file)) throw new NotFoundError('Upload');
    return { filename: row.filename, contentType: row.content_type, data: fs.readFileSync(file), size: row.size };
  },

  /** Upload bis zu einem Zeitpunkt aufbewahren (z. B. für "später senden") */
  keepUntil(ids: string[], until: Date) {
    const stmt = getDb().prepare('UPDATE uploads SET keep_until = ? WHERE id = ?');
    for (const id of ids) stmt.run(until.toISOString(), id);
  },

  delete(userId: string, id: string) {
    getDb().prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(id, userId);
    fs.rmSync(path.join(dir, id), { force: true });
  },

  /** Entfernt Uploads älter als 2 Tage (sofern nicht für geplanten Versand reserviert) */
  cleanup() {
    const rows = getDb()
      .prepare(
        `SELECT id FROM uploads WHERE created_at < datetime('now', '-2 days')
         AND (keep_until IS NULL OR keep_until < strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .all() as { id: string }[];
    for (const r of rows) {
      getDb().prepare('DELETE FROM uploads WHERE id = ?').run(r.id);
      fs.rmSync(path.join(dir, r.id), { force: true });
    }
  },
};
