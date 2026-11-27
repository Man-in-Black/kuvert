/**
 * Datenhaltung der Zeiterfassung.
 * Kunden, Projekte und Tätigkeiten sind für alle Benutzer gemeinsam (wie in Kimai),
 * Zeiteinträge gehören einem Benutzer. Zeitstempel als ISO-String in UTC.
 * Aus Kimai übernommene Datensätze tragen ext_source (Kimai-Adresse) und ext_id,
 * damit ein erneuter Import aktualisiert statt verdoppelt.
 */
import type {
  TtActivity,
  TtActivityInput,
  TtCustomer,
  TtCustomerInput,
  TtEntry,
  TtMasterData,
  TtProject,
  TtProjectInput,
  TtRecent,
  TtAdminSettings,
  TtLink,
  TtSettings,
} from '@kuvert/shared';
import { TT_DEFAULT_QUICK_TAGS } from '@kuvert/shared';
import { getDb, kv } from '../../core/db.js';
import { uuid } from '../../core/crypto.js';
import { AppError, BadRequestError, NotFoundError } from '../../core/errors.js';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const migrations = [
  {
    id: 'timetrack-001',
    sql: `
      CREATE TABLE tt_customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        number TEXT,
        comment TEXT,
        color TEXT,
        currency TEXT NOT NULL DEFAULT 'EUR',
        hourly_rate REAL,
        visible INTEGER NOT NULL DEFAULT 1,
        ext_source TEXT,
        ext_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE UNIQUE INDEX tt_customers_ext ON tt_customers(ext_source, ext_id) WHERE ext_source IS NOT NULL;

      CREATE TABLE tt_projects (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES tt_customers(id),
        name TEXT NOT NULL,
        number TEXT,
        order_number TEXT,
        comment TEXT,
        color TEXT,
        hourly_rate REAL,
        billable INTEGER NOT NULL DEFAULT 1,
        visible INTEGER NOT NULL DEFAULT 1,
        ext_source TEXT,
        ext_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX tt_projects_customer ON tt_projects(customer_id);
      CREATE UNIQUE INDEX tt_projects_ext ON tt_projects(ext_source, ext_id) WHERE ext_source IS NOT NULL;

      CREATE TABLE tt_activities (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES tt_projects(id),
        name TEXT NOT NULL,
        comment TEXT,
        color TEXT,
        hourly_rate REAL,
        billable INTEGER NOT NULL DEFAULT 1,
        visible INTEGER NOT NULL DEFAULT 1,
        ext_source TEXT,
        ext_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX tt_activities_project ON tt_activities(project_id);
      CREATE UNIQUE INDEX tt_activities_ext ON tt_activities(ext_source, ext_id) WHERE ext_source IS NOT NULL;

      CREATE TABLE tt_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES tt_projects(id),
        activity_id TEXT REFERENCES tt_activities(id),
        begin_at TEXT NOT NULL,
        end_at TEXT,
        duration INTEGER,
        description TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        billable INTEGER NOT NULL DEFAULT 1,
        hourly_rate REAL,
        fixed_rate REAL,
        rate REAL,
        exported INTEGER NOT NULL DEFAULT 0,
        ext_source TEXT,
        ext_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX tt_entries_user_begin ON tt_entries(user_id, begin_at);
      CREATE INDEX tt_entries_project ON tt_entries(project_id);
      CREATE INDEX tt_entries_activity ON tt_entries(activity_id);
      CREATE UNIQUE INDEX tt_entries_ext ON tt_entries(ext_source, ext_id) WHERE ext_source IS NOT NULL;
      -- höchstens ein laufender Timer je Benutzer
      CREATE UNIQUE INDEX tt_entries_running ON tt_entries(user_id) WHERE end_at IS NULL;
    `,
  },
  {
    // Mehrere Timer gleichzeitig erlauben
    id: 'timetrack-002',
    sql: `
      DROP INDEX IF EXISTS tt_entries_running;
      CREATE INDEX tt_entries_open ON tt_entries(user_id) WHERE end_at IS NULL;
    `,
  },
  {
    // Verknüpfungen (Ticket, Lead …)
    id: 'timetrack-003',
    sql: `
      ALTER TABLE tt_entries ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tt_entries ADD COLUMN rate_manual INTEGER NOT NULL DEFAULT 0;
      -- Aus Kimai übernommene Stundensätze gelten als von Hand festgelegt (Stammdaten haben keine)
      UPDATE tt_entries SET rate_manual = 1 WHERE ext_source IS NOT NULL AND hourly_rate IS NOT NULL;
    `,
  },
];

/* ═════════════════════════════ Hilfsfunktionen ═════════════════════════════ */

/** Beliebige Datumsangabe → ISO in UTC (wirft bei Unsinn) */
export function toIso(v: string, label = 'Zeitpunkt'): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${label} ist ungültig`);
  return d.toISOString();
}

const nn = (v: string | null | undefined) => {
  const s = v?.trim();
  return s ? s : null;
};

const cleanTags = (tags: string[] | undefined) => cleanTagList(tags);

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ═════════════════════════════ Stammdaten ═════════════════════════════ */

interface CustomerRow {
  id: string;
  name: string;
  number: string | null;
  comment: string | null;
  color: string | null;
  currency: string;
  hourly_rate: number | null;
  visible: number;
  ext_source: string | null;
}

interface ProjectRow {
  id: string;
  customer_id: string;
  name: string;
  number: string | null;
  order_number: string | null;
  comment: string | null;
  color: string | null;
  hourly_rate: number | null;
  billable: number;
  visible: number;
  ext_source: string | null;
}

interface ActivityRow {
  id: string;
  project_id: string | null;
  name: string;
  comment: string | null;
  color: string | null;
  hourly_rate: number | null;
  billable: number;
  visible: number;
  ext_source: string | null;
}

const toCustomer = (r: CustomerRow): TtCustomer => ({
  id: r.id,
  name: r.name,
  number: r.number,
  comment: r.comment,
  color: r.color,
  currency: r.currency,
  hourlyRate: r.hourly_rate,
  visible: !!r.visible,
  imported: !!r.ext_source,
});

const toProject = (r: ProjectRow): TtProject => ({
  id: r.id,
  customerId: r.customer_id,
  name: r.name,
  number: r.number,
  orderNumber: r.order_number,
  comment: r.comment,
  color: r.color,
  hourlyRate: r.hourly_rate,
  billable: !!r.billable,
  visible: !!r.visible,
  imported: !!r.ext_source,
});

const toActivity = (r: ActivityRow): TtActivity => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  comment: r.comment,
  color: r.color,
  hourlyRate: r.hourly_rate,
  billable: !!r.billable,
  visible: !!r.visible,
  imported: !!r.ext_source,
});

const db = () => getDb();

export const masterData = {
  all(): TtMasterData {
    return {
      customers: (db().prepare('SELECT * FROM tt_customers ORDER BY name COLLATE NOCASE').all() as CustomerRow[]).map(toCustomer),
      projects: (db().prepare('SELECT * FROM tt_projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[]).map(toProject),
      activities: (db().prepare('SELECT * FROM tt_activities ORDER BY name COLLATE NOCASE').all() as ActivityRow[]).map(toActivity),
    };
  },

  customer(id: string): CustomerRow {
    const r = db().prepare('SELECT * FROM tt_customers WHERE id = ?').get(id) as CustomerRow | undefined;
    if (!r) throw new NotFoundError('Kunde');
    return r;
  },
  project(id: string): ProjectRow {
    const r = db().prepare('SELECT * FROM tt_projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!r) throw new NotFoundError('Projekt');
    return r;
  },
  activity(id: string): ActivityRow {
    const r = db().prepare('SELECT * FROM tt_activities WHERE id = ?').get(id) as ActivityRow | undefined;
    if (!r) throw new NotFoundError('Tätigkeit');
    return r;
  },

  saveCustomer(id: string | null, b: TtCustomerInput): TtCustomer {
    const name = nn(b.name);
    if (!name) throw new BadRequestError('Name fehlt');
    const vals = [name, nn(b.number), nn(b.comment), nn(b.color), (nn(b.currency) ?? ttAdmin.get().defaultCurrency).toUpperCase(), b.hourlyRate ?? null, b.visible === false ? 0 : 1];
    if (id) {
      this.customer(id);
      db()
        .prepare(`UPDATE tt_customers SET name=?, number=?, comment=?, color=?, currency=?, hourly_rate=?, visible=?, updated_at=${NOW} WHERE id=?`)
        .run(...vals, id);
    } else {
      id = uuid();
      db().prepare('INSERT INTO tt_customers (name, number, comment, color, currency, hourly_rate, visible, id) VALUES (?,?,?,?,?,?,?,?)').run(...vals, id);
    }
    return toCustomer(this.customer(id));
  },

  saveProject(id: string | null, b: TtProjectInput): TtProject {
    const name = nn(b.name);
    if (!name) throw new BadRequestError('Name fehlt');
    this.customer(b.customerId);
    const vals = [b.customerId, name, nn(b.number), nn(b.orderNumber), nn(b.comment), nn(b.color), b.hourlyRate ?? null, b.billable === false ? 0 : 1, b.visible === false ? 0 : 1];
    if (id) {
      this.project(id);
      db()
        .prepare(
          `UPDATE tt_projects SET customer_id=?, name=?, number=?, order_number=?, comment=?, color=?, hourly_rate=?, billable=?, visible=?, updated_at=${NOW} WHERE id=?`,
        )
        .run(...vals, id);
    } else {
      id = uuid();
      db()
        .prepare('INSERT INTO tt_projects (customer_id, name, number, order_number, comment, color, hourly_rate, billable, visible, id) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(...vals, id);
    }
    return toProject(this.project(id));
  },

  saveActivity(id: string | null, b: TtActivityInput): TtActivity {
    const name = nn(b.name);
    if (!name) throw new BadRequestError('Name fehlt');
    if (b.projectId) this.project(b.projectId);
    const vals = [b.projectId || null, name, nn(b.comment), nn(b.color), b.hourlyRate ?? null, b.billable === false ? 0 : 1, b.visible === false ? 0 : 1];
    if (id) {
      const prev = this.activity(id);
      // Projektbindung nur ändern, wenn keine Einträge eines anderen Projekts daran hängen
      if (b.projectId && prev.project_id !== b.projectId) {
        const other = db().prepare('SELECT 1 FROM tt_entries WHERE activity_id = ? AND project_id != ? LIMIT 1').get(id, b.projectId);
        if (other) throw new AppError(409, 'tt_activity_in_use', 'Die Tätigkeit wird bereits in anderen Projekten verwendet und kann nicht an ein einzelnes Projekt gebunden werden');
      }
      db()
        .prepare(`UPDATE tt_activities SET project_id=?, name=?, comment=?, color=?, hourly_rate=?, billable=?, visible=?, updated_at=${NOW} WHERE id=?`)
        .run(...vals, id);
    } else {
      id = uuid();
      db().prepare('INSERT INTO tt_activities (project_id, name, comment, color, hourly_rate, billable, visible, id) VALUES (?,?,?,?,?,?,?,?)').run(...vals, id);
    }
    return toActivity(this.activity(id));
  },

  /** Löschen nur, solange nichts daran hängt – sonst archivieren (ausblenden) */
  deleteCustomer(id: string) {
    this.customer(id);
    const n = (db().prepare('SELECT COUNT(*) AS n FROM tt_projects WHERE customer_id = ?').get(id) as { n: number }).n;
    if (n) throw new AppError(409, 'tt_in_use', `Der Kunde hat noch ${n} Projekt${n === 1 ? '' : 'e'} – stattdessen ausblenden oder zuerst die Projekte löschen`);
    db().prepare('DELETE FROM tt_customers WHERE id = ?').run(id);
  },

  deleteProject(id: string) {
    this.project(id);
    const n = (db().prepare('SELECT COUNT(*) AS n FROM tt_entries WHERE project_id = ?').get(id) as { n: number }).n;
    if (n) throw new AppError(409, 'tt_in_use', `Am Projekt hängen ${n} Zeiteinträge – stattdessen ausblenden`);
    db().transaction(() => {
      db().prepare('DELETE FROM tt_activities WHERE project_id = ?').run(id);
      db().prepare('DELETE FROM tt_projects WHERE id = ?').run(id);
    })();
  },

  deleteActivity(id: string) {
    this.activity(id);
    const n = (db().prepare('SELECT COUNT(*) AS n FROM tt_entries WHERE activity_id = ?').get(id) as { n: number }).n;
    if (n) throw new AppError(409, 'tt_in_use', `An der Tätigkeit hängen ${n} Zeiteinträge – stattdessen ausblenden`);
    db().prepare('DELETE FROM tt_activities WHERE id = ?').run(id);
  },
};

/* ═════════════════════════════ Zeiteinträge ═════════════════════════════ */

interface EntryRow {
  id: string;
  user_id: string;
  project_id: string;
  activity_id: string | null;
  begin_at: string;
  end_at: string | null;
  duration: number | null;
  description: string | null;
  tags_json: string;
  links_json: string;
  billable: number;
  hourly_rate: number | null;
  rate_manual: number;
  fixed_rate: number | null;
  rate: number | null;
  exported: number;
  ext_source: string | null;
  customer_id: string;
  customer_name: string;
  project_name: string;
  activity_name: string | null;
  color: string | null;
  currency: string;
}

const ENTRY_SELECT = `
  SELECT e.*, c.id AS customer_id, c.name AS customer_name, p.name AS project_name, a.name AS activity_name,
         COALESCE(a.color, p.color, c.color) AS color, c.currency AS currency
  FROM tt_entries e
  JOIN tt_projects p ON p.id = e.project_id
  JOIN tt_customers c ON c.id = p.customer_id
  LEFT JOIN tt_activities a ON a.id = e.activity_id`;

export function toEntry(r: EntryRow, now = Date.now()): TtEntry {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags_json) as string[];
  } catch {
    /* leer */
  }
  const duration = r.end_at ? (r.duration ?? 0) : Math.max(0, Math.round((now - Date.parse(r.begin_at)) / 1000));
  return {
    id: r.id,
    projectId: r.project_id,
    activityId: r.activity_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    projectName: r.project_name,
    activityName: r.activity_name,
    color: r.color,
    begin: r.begin_at,
    end: r.end_at,
    duration,
    description: r.description,
    tags,
    billable: !!r.billable,
    hourlyRate: r.hourly_rate,
    hourlyRateManual: !!r.rate_manual,
    fixedRate: r.fixed_rate,
    rate: r.end_at ? r.rate : r.fixed_rate ?? (r.hourly_rate != null ? round2((r.hourly_rate * duration) / 3600) : null),
    currency: r.currency,
    exported: !!r.exported,
    imported: !!r.ext_source,
    links: parseLinks(r.links_json),
  };
}

function parseLinks(json: string | null | undefined): TtLink[] {
  try {
    const v = JSON.parse(json || '[]') as TtLink[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Schlagworte bereinigen (Duplikate ohne Groß-/Kleinschreibung entfernen) */
export function cleanTagList(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags ?? []) {
    const v = t.trim().slice(0, 100);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out.slice(0, 30);
}

/** Stundensatz aus Tätigkeit → Projekt → Kunde */
function hourlyRateFor(projectId: string, activityId: string | null): number | null {
  const p = masterData.project(projectId);
  const a = activityId ? masterData.activity(activityId) : null;
  if (a?.hourly_rate != null) return a.hourly_rate;
  if (p.hourly_rate != null) return p.hourly_rate;
  return masterData.customer(p.customer_id).hourly_rate ?? ttAdmin.get().defaultHourlyRate;
}

/** Projekt und Tätigkeit prüfen: Tätigkeit muss global sein oder zum Projekt gehören */
function checkRefs(projectId: string, activityId: string | null) {
  const p = masterData.project(projectId);
  if (activityId) {
    const a = masterData.activity(activityId);
    if (a.project_id && a.project_id !== p.id) throw new BadRequestError('Die Tätigkeit gehört zu einem anderen Projekt');
  }
  return p;
}

/** Höchstzahl gleichzeitig laufender Timer je Benutzer */
const MAX_RUNNING = 10;

export const ROUND_UP_OPTIONS = [0, 5, 10, 15, 30, 60] as const;

const validRound = (v: unknown): v is number => typeof v === 'number' && (ROUND_UP_OPTIONS as readonly number[]).includes(v);

/** Zentrale Vorgaben (Admin-Bereich) */
export const ttAdmin = {
  get(): TtAdminSettings {
    const s = kv.get<Partial<TtAdminSettings>>('timetrack', 'admin') ?? {};
    return {
      defaultHourlyRate: typeof s.defaultHourlyRate === 'number' && s.defaultHourlyRate >= 0 ? s.defaultHourlyRate : null,
      defaultCurrency: typeof s.defaultCurrency === 'string' && /^[A-Z]{3}$/.test(s.defaultCurrency) ? s.defaultCurrency : 'EUR',
      roundUp: validRound(s.roundUp) ? s.roundUp : 15,
      roundUpLocked: !!s.roundUpLocked,
      quickTags: Array.isArray(s.quickTags) ? cleanTagList(s.quickTags).slice(0, 8) : [...TT_DEFAULT_QUICK_TAGS],
      quickTagsLocked: !!s.quickTagsLocked,
      masterDataAdminOnly: !!s.masterDataAdminOnly,
    };
  },
  set(v: TtAdminSettings) {
    kv.set('timetrack', 'admin', v);
  },
};

/** Persönliche Einstellungen; ohne eigene Wahl bzw. bei Festlegung gilt die zentrale Vorgabe */
export const ttSettings = {
  get(userId: string, isAdmin = false): TtSettings {
    const s = kv.get<Partial<TtSettings>>('timetrack.settings', userId) ?? {};
    const a = ttAdmin.get();
    return {
      roundUp: !a.roundUpLocked && validRound(s.roundUp) ? s.roundUp : a.roundUp,
      quickTags: !a.quickTagsLocked && Array.isArray(s.quickTags) ? cleanTagList(s.quickTags).slice(0, 8) : a.quickTags,
      roundUpLocked: a.roundUpLocked,
      quickTagsLocked: a.quickTagsLocked,
      canEditMasterData: !a.masterDataAdminOnly || isAdmin,
      defaultHourlyRate: a.defaultHourlyRate,
      defaultCurrency: a.defaultCurrency,
    };
  },
  /** Nur die persönlichen Felder speichern (undefined = zentrale Vorgabe verwenden) */
  set(userId: string, v: { roundUp?: number; quickTags?: string[] }) {
    const prev = kv.get<Partial<TtSettings>>('timetrack.settings', userId) ?? {};
    kv.set('timetrack.settings', userId, { roundUp: v.roundUp ?? prev.roundUp, quickTags: v.quickTags ?? prev.quickTags });
  },
};

/**
 * Ende so verschieben, dass die Dauer ein volles Vielfaches von `minutes` ist – immer aufgerundet
 * (6 min → 15, 17 min → 30). Angefangene Sekunden zählen nicht, mindestens ein Block.
 */
export function roundUpEnd(beginIso: string, endIso: string, minutes: number): string {
  if (!minutes) return endIso;
  const block = minutes * 60;
  const whole = Math.floor((Date.parse(endIso) - Date.parse(beginIso)) / 60_000) * 60;
  const sec = Math.max(block, Math.ceil(whole / block) * block);
  return new Date(Date.parse(beginIso) + sec * 1000).toISOString();
}

export interface EntryFilter {
  from?: string;
  to?: string;
  projectId?: string;
  customerId?: string;
  activityId?: string;
  q?: string;
  limit?: number;
}

export interface EntryWrite {
  projectId: string;
  activityId: string | null;
  begin: string;
  end: string | null;
  description: string | null;
  tags: string[];
  billable?: boolean;
  fixedRate?: number | null;
  /** Eigener Stundensatz; null/undefined = automatisch */
  hourlyRate?: number | null;
}

export const entries = {
  get(userId: string, id: string): TtEntry {
    const r = db().prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.user_id = ?`).get(id, userId) as EntryRow | undefined;
    if (!r) throw new NotFoundError('Zeiteintrag');
    return toEntry(r);
  },

  /** Laufende Timer, ältester zuerst */
  running(userId: string): TtEntry[] {
    const now = Date.now();
    return (db().prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.end_at IS NULL ORDER BY e.begin_at`).all(userId) as EntryRow[]).map((r) => toEntry(r, now));
  },

  /** Einträge mit Beginn in [from, to), neueste zuerst */
  list(userId: string, f: EntryFilter): { items: TtEntry[]; total: number; truncated: boolean } {
    const where = ['e.user_id = ?'];
    const args: unknown[] = [userId];
    if (f.from) {
      where.push('e.begin_at >= ?');
      args.push(toIso(f.from));
    }
    if (f.to) {
      where.push('e.begin_at < ?');
      args.push(toIso(f.to));
    }
    if (f.projectId) {
      where.push('e.project_id = ?');
      args.push(f.projectId);
    }
    if (f.customerId) {
      where.push('p.customer_id = ?');
      args.push(f.customerId);
    }
    if (f.activityId) {
      where.push('e.activity_id = ?');
      args.push(f.activityId);
    }
    if (f.q) {
      where.push(
        `(e.description LIKE ? ESCAPE '\\' OR e.tags_json LIKE ? ESCAPE '\\' OR e.links_json LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`,
      );
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like, like, like, like, like);
    }
    const limit = Math.min(f.limit ?? 500, 2000);
    const rows = db()
      .prepare(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.begin_at DESC LIMIT ?`)
      .all(...args, limit + 1) as EntryRow[];
    const truncated = rows.length > limit;
    const now = Date.now();
    const items = rows.slice(0, limit).map((r) => toEntry(r, now));
    const sum = db()
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN e.end_at IS NULL THEN 0 ELSE e.duration END), 0) AS s, MAX(e.end_at IS NULL) AS running FROM tt_entries e
         JOIN tt_projects p ON p.id = e.project_id JOIN tt_customers c ON c.id = p.customer_id LEFT JOIN tt_activities a ON a.id = e.activity_id
         WHERE ${where.join(' AND ')}`,
      )
      .get(...args) as { s: number; running: number | null };
    const runningExtra = sum.running ? items.filter((i) => !i.end).reduce((acc, i) => acc + i.duration, 0) : 0;
    return { items, total: sum.s + runningExtra, truncated };
  },

  /** Rohdaten für Auswertung und Export (ohne Limit, älteste zuerst) */
  range(userId: string, from: string, to: string): TtEntry[] {
    const now = Date.now();
    return (db().prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.begin_at >= ? AND e.begin_at < ? ORDER BY e.begin_at`).all(userId, from, to) as EntryRow[]).map((r) =>
      toEntry(r, now),
    );
  },

  create(userId: string, w: EntryWrite): TtEntry {
    const id = uuid();
    const vals = this.prepare(userId, w, null);
    db()
      .prepare(
        `INSERT INTO tt_entries (project_id, activity_id, begin_at, end_at, duration, description, tags_json, billable, hourly_rate, fixed_rate, rate, rate_manual, id, user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...vals, id, userId);
    return this.get(userId, id);
  },

  update(userId: string, id: string, w: EntryWrite): TtEntry {
    this.get(userId, id);
    const vals = this.prepare(userId, w, id);
    db()
      .prepare(
        `UPDATE tt_entries SET project_id=?, activity_id=?, begin_at=?, end_at=?, duration=?, description=?, tags_json=?, billable=?, hourly_rate=?, fixed_rate=?, rate=?, rate_manual=?, updated_at=${NOW}
         WHERE id=? AND user_id=?`,
      )
      .run(...vals, id, userId);
    return this.get(userId, id);
  },

  /** Werte prüfen und Dauer/Betrag berechnen */
  prepare(userId: string, w: EntryWrite, selfId: string | null) {
    const p = checkRefs(w.projectId, w.activityId);
    const begin = toIso(w.begin, 'Beginn');
    let end = w.end ? toIso(w.end, 'Ende') : null;
    if (end && end <= begin) throw new BadRequestError('Das Ende muss nach dem Beginn liegen');
    // Dauer auf den nächsten Block aufrunden (Einstellung des Benutzers, Standard 15 min)
    if (end) end = roundUpEnd(begin, end, ttSettings.get(userId).roundUp);
    if (end && Date.parse(end) - Date.parse(begin) > 7 * 86400_000) throw new BadRequestError('Ein Eintrag darf höchstens sieben Tage lang sein');
    if (!end) {
      const others = this.running(userId).filter((r) => r.id !== selfId);
      if (others.length >= MAX_RUNNING) throw new AppError(409, 'tt_running', `Es laufen bereits ${others.length} Timer – bitte zuerst einen stoppen`);
      if (Date.parse(begin) > Date.now() + 60_000) throw new BadRequestError('Ein laufender Timer kann nicht in der Zukunft beginnen');
    }
    const duration = end ? Math.round((Date.parse(end) - Date.parse(begin)) / 1000) : null;
    const manual = w.hourlyRate != null;
    const hourly = manual ? w.hourlyRate! : hourlyRateFor(w.projectId, w.activityId);
    const fixed = w.fixedRate ?? null;
    const rate = duration == null ? null : fixed ?? (hourly != null ? round2((hourly * duration) / 3600) : null);
    const billable = w.billable ?? !!p.billable;
    return [w.projectId, w.activityId, begin, end, duration, nn(w.description), JSON.stringify(cleanTags(w.tags)), billable ? 1 : 0, hourly, fixed, rate, manual ? 1 : 0] as const;
  },

  /** Laufende Timer beenden (end = jetzt): einen bestimmten (id) oder alle; liefert die gestoppten */
  stop(userId: string, id?: string, at = new Date()): TtEntry[] {
    const list = this.running(userId).filter((r) => !id || r.id === id);
    if (id && !list.length) throw new AppError(409, 'tt_not_running', 'Dieser Timer läuft nicht (mehr)');
    return list.map((run) =>
      this.update(userId, run.id, {
        projectId: run.projectId,
        activityId: run.activityId,
        begin: run.begin,
        end: new Date(Math.max(at.getTime(), Date.parse(run.begin) + 1000)).toISOString(),
        description: run.description,
        tags: run.tags,
        billable: run.billable,
        fixedRate: run.fixedRate,
        hourlyRate: run.hourlyRateManual ? run.hourlyRate : null,
      }),
    );
  },

  /** Nur Schlagworte/Verknüpfungen ändern – ohne Rundung oder Neuberechnung */
  setMeta(userId: string, id: string, m: { tags?: string[]; links?: TtLink[] }): TtEntry {
    this.get(userId, id);
    if (m.tags) db().prepare(`UPDATE tt_entries SET tags_json = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ?`).run(JSON.stringify(cleanTagList(m.tags)), id, userId);
    if (m.links) {
      const seen = new Set<string>();
      const links = m.links.filter((l) => !seen.has(`${l.type}:${l.id}`) && seen.add(`${l.type}:${l.id}`)).slice(0, 20);
      db().prepare(`UPDATE tt_entries SET links_json = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ?`).run(JSON.stringify(links), id, userId);
    }
    return this.get(userId, id);
  },

  delete(userId: string, id: string) {
    this.get(userId, id);
    db().prepare('DELETE FROM tt_entries WHERE id = ? AND user_id = ?').run(id, userId);
  },

  /** Zuletzt verwendete Kombinationen (Projekt, Tätigkeit, Beschreibung) */
  recent(userId: string, limit = 8): TtRecent[] {
    const rows = db()
      .prepare(
        `SELECT e.project_id, e.activity_id, e.description, e.tags_json, MAX(e.begin_at) AS last_used,
                c.name AS customer_name, p.name AS project_name, a.name AS activity_name, COALESCE(a.color, p.color, c.color) AS color
         FROM tt_entries e
         JOIN tt_projects p ON p.id = e.project_id
         JOIN tt_customers c ON c.id = p.customer_id
         LEFT JOIN tt_activities a ON a.id = e.activity_id
         WHERE e.user_id = ? AND e.begin_at >= ? AND p.visible = 1 AND c.visible = 1 AND (a.id IS NULL OR a.visible = 1)
         GROUP BY e.project_id, e.activity_id, COALESCE(e.description, '')
         ORDER BY last_used DESC LIMIT ?`,
      )
      .all(userId, new Date(Date.now() - 60 * 86400_000).toISOString(), limit) as {
      project_id: string;
      activity_id: string | null;
      description: string | null;
      tags_json: string;
      last_used: string;
      customer_name: string;
      project_name: string;
      activity_name: string | null;
      color: string | null;
    }[];
    return rows.map((r) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags_json) as string[];
      } catch {
        /* leer */
      }
      return {
        projectId: r.project_id,
        activityId: r.activity_id,
        description: r.description,
        tags,
        customerName: r.customer_name,
        projectName: r.project_name,
        activityName: r.activity_name,
        color: r.color,
        lastUsed: r.last_used,
      };
    });
  },

  /** Alle bisher verwendeten Schlagworte des Benutzers */
  tags(userId: string): string[] {
    const rows = db().prepare(`SELECT DISTINCT j.value AS tag FROM tt_entries e, json_each(e.tags_json) j WHERE e.user_id = ? ORDER BY 1 COLLATE NOCASE`).all(userId) as {
      tag: string;
    }[];
    return rows.map((r) => r.tag);
  },
};
