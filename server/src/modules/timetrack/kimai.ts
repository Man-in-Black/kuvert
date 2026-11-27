/**
 * Import aus Kimai 2 (REST-API unter /api).
 *
 * Anmeldung: API-Token als Bearer (Kimai ≥ 2.0) oder – bei älteren Installationen – Benutzername
 * und API-Passwort (X-AUTH-USER/X-AUTH-TOKEN). Übernommen werden alle für den Token sichtbaren
 * Kunden, Projekte und Tätigkeiten (auch ausgeblendete) sowie die eigenen Zeiteinträge.
 * Der Import ist wiederholbar: Datensätze werden über (Kimai-Adresse, Kimai-ID) wiedererkannt
 * und aktualisiert. Laufende Kimai-Timer werden übersprungen.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { TtImportStatus, TtKimaiConnection, TtKimaiTestResult } from '@kuvert/shared';
import { getDb, kv } from '../../core/db.js';
import { decrypt, encrypt, uuid } from '../../core/crypto.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { apiFetch } from '../../core/http.js';

/* ═════════════════════════════ Client ═════════════════════════════ */

export interface KimaiAuth {
  baseUrl: string;
  token: string;
  username: string | null;
}

interface KCustomer {
  id: number;
  name: string;
  number?: string | null;
  comment?: string | null;
  visible?: boolean;
  currency?: string | null;
  color?: string | null;
}

interface KProject {
  id: number;
  name: string;
  customer: number | { id: number } | null;
  number?: string | null;
  orderNumber?: string | null;
  comment?: string | null;
  visible?: boolean;
  billable?: boolean;
  color?: string | null;
}

interface KActivity {
  id: number;
  name: string;
  project?: number | { id: number } | null;
  comment?: string | null;
  visible?: boolean;
  billable?: boolean;
  color?: string | null;
}

interface KTimesheet {
  id: number;
  begin: string;
  end: string | null;
  duration?: number | null;
  description?: string | null;
  project: number | { id: number } | null;
  activity: number | { id: number } | null;
  tags?: (string | { name: string })[];
  billable?: boolean;
  exported?: boolean;
  rate?: number | null;
  hourlyRate?: number | null;
  fixedRate?: number | null;
}

const refId = (v: number | { id: number } | null | undefined): number | null => (v == null ? null : typeof v === 'number' ? v : (v.id ?? null));

/** Adresse vereinheitlichen: https ergänzen, /api bzw. kopierte Seitenpfade (/de/timesheet …) entfernen */
export function normalizeKimaiUrl(v: string): string {
  let s = (v ?? '').trim();
  if (!s) throw new BadRequestError('Adresse von Kimai fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/(api(\/doc)?|\w{2}(_\w{2})?\/(timesheet|homepage|dashboard)).*$/i, '').replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    throw new BadRequestError('Adresse von Kimai ist ungültig');
  }
}

export class KimaiClient {
  constructor(private auth: KimaiAuth) {}

  private headers(): Record<string, string> {
    return this.auth.username ? { 'X-AUTH-USER': this.auth.username, 'X-AUTH-TOKEN': this.auth.token } : { Authorization: `Bearer ${this.auth.token}` };
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<{ data: T; headers: Headers }> {
    let res: Response;
    try {
      res = await apiFetch(`${this.auth.baseUrl}/api/${path}`, {
        headers: { Accept: 'application/json', ...this.headers() },
        query,
        noAuthError: true,
        retries: 4,
        timeoutMs: 60_000,
      });
    } catch (err) {
      if (err instanceof AppError) {
        if (err.status === 401) throw new AppError(400, 'kimai_auth', 'Kimai: Anmeldung fehlgeschlagen – API-Token bzw. Benutzername/API-Passwort prüfen');
        if (err.status === 403) throw new AppError(400, 'kimai_forbidden', `Kimai: keine Berechtigung (${err.message})`);
        if (err.status === 404) throw new AppError(404, 'kimai_not_found', `Kimai: ${path} nicht gefunden – stimmt die Adresse?`);
        throw new AppError(err.status >= 500 ? 502 : err.status, 'kimai_error', `Kimai: ${err.message}`);
      }
      throw err;
    }
    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new AppError(502, 'kimai_error', 'Kimai: Antwort ist kein JSON – stimmt die Adresse (ohne /api)?');
    }
    return { data, headers: res.headers };
  }

  async test(): Promise<TtKimaiTestResult> {
    const me = (await this.get<{ username?: string; alias?: string | null }>('users/me')).data;
    let version: string | null = null;
    try {
      version = (await this.get<{ version?: string }>('version')).data.version ?? null;
    } catch {
      /* /api/version braucht je nach Version eigene Rechte */
    }
    const user = me.alias || me.username || null;
    return { ok: true, version, user, message: `Verbunden als ${user ?? 'unbekannt'}${version ? ` (Kimai ${version})` : ''}` };
  }

  /** Stammdaten (sichtbar und ausgeblendet) */
  async list<T>(path: 'customers' | 'projects' | 'activities'): Promise<T[]> {
    const { data } = await this.get<T[]>(path, { visible: 3, ...(path === 'projects' ? { ignoreDates: 1 } : {}) });
    if (!Array.isArray(data)) throw new AppError(502, 'kimai_error', `Kimai: unerwartete Antwort für ${path}`);
    return data;
  }

  /** Eigene Zeiteinträge seitenweise (älteste zuerst) */
  async *timesheets(pageSize: number, onTotal: (n: number | null) => void): AsyncGenerator<KTimesheet[]> {
    for (let page = 1; ; page++) {
      let res: { data: KTimesheet[]; headers: Headers };
      try {
        res = await this.get<KTimesheet[]>('timesheets', { page, size: pageSize, order: 'ASC', orderBy: 'begin' });
      } catch (err) {
        // Seite hinter dem Ende meldet Kimai teils als 404
        if (page > 1 && err instanceof AppError && err.status === 404) return;
        throw err;
      }
      if (page === 1) {
        const total = Number(res.headers.get('x-total-count'));
        onTotal(Number.isFinite(total) && res.headers.has('x-total-count') ? total : null);
      }
      if (!Array.isArray(res.data) || !res.data.length) return;
      yield res.data;
      const pages = Number(res.headers.get('x-total-pages'));
      if (res.headers.has('x-total-pages') && Number.isFinite(pages) ? page >= pages : res.data.length < pageSize) return;
    }
  }
}

/* ═════════════════════════════ Gespeicherte Verbindung ═════════════════════════════ */

interface StoredConn {
  baseUrl: string;
  username: string | null;
  tokenEnc: string;
  lastImport?: TtImportStatus | null;
}

const KV_SCOPE = 'timetrack.kimai';

export const kimaiConn = {
  get(userId: string): TtKimaiConnection | null {
    const s = kv.get<StoredConn>(KV_SCOPE, userId);
    if (!s) return null;
    return { baseUrl: s.baseUrl, username: s.username, tokenConfigured: !!s.tokenEnc, lastImport: running.get(userId) ?? s.lastImport ?? null };
  },

  /** Zugang zusammensetzen; token leer = gespeicherten verwenden (nur bei gleicher Adresse) */
  resolve(userId: string, input: { baseUrl: string; token?: string; username?: string | null }): KimaiAuth {
    const baseUrl = normalizeKimaiUrl(input.baseUrl);
    const username = input.username?.trim() || null;
    let token = input.token?.trim() || '';
    if (!token) {
      const s = kv.get<StoredConn>(KV_SCOPE, userId);
      if (s?.tokenEnc && s.baseUrl === baseUrl) token = decrypt(s.tokenEnc);
    }
    if (!token) throw new BadRequestError(username ? 'API-Passwort fehlt' : 'API-Token fehlt');
    return { baseUrl, token, username };
  },

  save(userId: string, auth: KimaiAuth) {
    const prev = kv.get<StoredConn>(KV_SCOPE, userId);
    kv.set(KV_SCOPE, userId, { baseUrl: auth.baseUrl, username: auth.username, tokenEnc: encrypt(auth.token), lastImport: prev?.lastImport ?? null } satisfies StoredConn);
  },

  setLastImport(userId: string, status: TtImportStatus) {
    const prev = kv.get<StoredConn>(KV_SCOPE, userId);
    if (prev) kv.set(KV_SCOPE, userId, { ...prev, lastImport: status });
  },

  remove(userId: string) {
    getDb().prepare('DELETE FROM kv WHERE scope = ? AND key = ?').run(KV_SCOPE, userId);
  },
};

/* ═════════════════════════════ Import ═════════════════════════════ */

/** Laufende Importe je Benutzer (nur im Speicher) */
const running = new Map<string, TtImportStatus>();

export function importStatus(userId: string): TtImportStatus | null {
  return running.get(userId) ?? kimaiConn.get(userId)?.lastImport ?? null;
}

const nowIso = () => new Date().toISOString();
const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
const color = (v: string | null | undefined) => (v && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : null);

/**
 * Startet den Import im Hintergrund. notify() wird bei Fortschritt (gedrosselt) und am Ende aufgerufen.
 */
export function startKimaiImport(
  userId: string,
  auth: KimaiAuth,
  opts: { log: FastifyBaseLogger; notify: (scope: 'import' | 'entries' | 'masterdata') => void },
): TtImportStatus {
  const cur = running.get(userId);
  if (cur?.state === 'running') throw new AppError(409, 'tt_import_running', 'Es läuft bereits ein Import');
  const status: TtImportStatus = {
    state: 'running',
    phase: 'customers',
    done: 0,
    total: null,
    counts: { customers: 0, projects: 0, activities: 0, created: 0, updated: 0, skipped: 0 },
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
  };
  running.set(userId, status);

  let lastNotify = 0;
  const progress = (force = false) => {
    if (force || Date.now() - lastNotify > 700) {
      lastNotify = Date.now();
      opts.notify('import');
    }
  };

  void (async () => {
    try {
      await runImport(userId, auth, status, progress, opts.notify);
      status.state = 'done';
      status.phase = 'done';
    } catch (err) {
      status.state = 'error';
      status.error = err instanceof Error ? err.message : String(err);
      opts.log.warn({ err, userId }, 'Kimai-Import fehlgeschlagen');
    } finally {
      status.finishedAt = nowIso();
      kimaiConn.setLastImport(userId, { ...status });
      running.delete(userId);
      opts.notify('masterdata');
      opts.notify('entries');
      progress(true);
    }
  })();

  return { ...status };
}

async function runImport(
  userId: string,
  auth: KimaiAuth,
  status: TtImportStatus,
  progress: (force?: boolean) => void,
  notify: (scope: 'masterdata') => void,
) {
  const db = getDb();
  const client = new KimaiClient(auth);
  const src = auth.baseUrl;
  await client.test();

  const findId = (table: string, extId: number): string | undefined =>
    (db.prepare(`SELECT id FROM ${table} WHERE ext_source = ? AND ext_id = ?`).get(src, extId) as { id: string } | undefined)?.id;

  /* ── Kunden ── */
  status.phase = 'customers';
  progress(true);
  const customers = await client.list<KCustomer>('customers');
  status.total = customers.length;
  const customerMap = new Map<number, string>();
  db.transaction(() => {
    for (const c of customers) {
      const vals = [c.name?.trim() || `Kunde ${c.id}`, clean(c.number), clean(c.comment), color(c.color), (c.currency || 'EUR').toUpperCase(), c.visible === false ? 0 : 1];
      let id = findId('tt_customers', c.id);
      if (id) {
        db.prepare(`UPDATE tt_customers SET name=?, number=?, comment=?, color=?, currency=?, visible=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, id);
      } else {
        id = uuid();
        db.prepare('INSERT INTO tt_customers (name, number, comment, color, currency, visible, id, ext_source, ext_id) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, id, src, c.id);
      }
      customerMap.set(c.id, id);
      status.counts.customers++;
      status.done++;
    }
  })();
  progress();

  /* ── Projekte ── */
  status.phase = 'projects';
  status.done = 0;
  const projects = await client.list<KProject>('projects');
  status.total = projects.length;
  const projectMap = new Map<number, string>();
  db.transaction(() => {
    for (const p of projects) {
      const cid = refId(p.customer);
      const customerId = cid != null ? (customerMap.get(cid) ?? findId('tt_customers', cid)) : undefined;
      status.done++;
      if (!customerId) continue;
      const vals = [customerId, p.name?.trim() || `Projekt ${p.id}`, clean(p.number), clean(p.orderNumber), clean(p.comment), color(p.color), p.billable === false ? 0 : 1, p.visible === false ? 0 : 1];
      let id = findId('tt_projects', p.id);
      if (id) {
        db.prepare(
          `UPDATE tt_projects SET customer_id=?, name=?, number=?, order_number=?, comment=?, color=?, billable=?, visible=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(...vals, id);
      } else {
        id = uuid();
        db.prepare('INSERT INTO tt_projects (customer_id, name, number, order_number, comment, color, billable, visible, id, ext_source, ext_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
          ...vals,
          id,
          src,
          p.id,
        );
      }
      projectMap.set(p.id, id);
      status.counts.projects++;
    }
  })();
  progress();

  /* ── Tätigkeiten ── */
  status.phase = 'activities';
  status.done = 0;
  const activities = await client.list<KActivity>('activities');
  status.total = activities.length;
  const activityMap = new Map<number, string>();
  db.transaction(() => {
    for (const a of activities) {
      status.done++;
      const pid = refId(a.project);
      const projectId = pid != null ? (projectMap.get(pid) ?? findId('tt_projects', pid) ?? null) : null;
      if (pid != null && !projectId) continue;
      const vals = [projectId, a.name?.trim() || `Tätigkeit ${a.id}`, clean(a.comment), color(a.color), a.billable === false ? 0 : 1, a.visible === false ? 0 : 1];
      let id = findId('tt_activities', a.id);
      if (id) {
        db.prepare(`UPDATE tt_activities SET project_id=?, name=?, comment=?, color=?, billable=?, visible=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, id);
      } else {
        id = uuid();
        db.prepare('INSERT INTO tt_activities (project_id, name, comment, color, billable, visible, id, ext_source, ext_id) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, id, src, a.id);
      }
      activityMap.set(a.id, id);
      status.counts.activities++;
    }
  })();
  notify('masterdata');
  progress();

  /* ── Zeiteinträge ── */
  status.phase = 'timesheets';
  status.done = 0;
  status.total = null;
  const findEntry = db.prepare('SELECT id, user_id FROM tt_entries WHERE ext_source = ? AND ext_id = ?');
  const insert = db.prepare(
    `INSERT INTO tt_entries (user_id, project_id, activity_id, begin_at, end_at, duration, description, tags_json, billable, hourly_rate, fixed_rate, rate, exported, id, ext_source, ext_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const update = db.prepare(
    `UPDATE tt_entries SET project_id=?, activity_id=?, begin_at=?, end_at=?, duration=?, description=?, tags_json=?, billable=?, hourly_rate=?, fixed_rate=?, rate=?, exported=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  );

  for await (const page of client.timesheets(250, (n) => (status.total = n))) {
    db.transaction(() => {
      for (const t of page) {
        status.done++;
        const pid = refId(t.project);
        const aid = refId(t.activity);
        const projectId = pid != null ? (projectMap.get(pid) ?? findId('tt_projects', pid)) : undefined;
        const activityId = aid != null ? (activityMap.get(aid) ?? findId('tt_activities', aid) ?? null) : null;
        const begin = new Date(t.begin);
        const end = t.end ? new Date(t.end) : null;
        if (!projectId || !end || Number.isNaN(begin.getTime()) || Number.isNaN(end.getTime())) {
          status.counts.skipped++;
          continue;
        }
        const duration = t.duration != null && t.duration >= 0 ? Math.round(t.duration) : Math.max(0, Math.round((end.getTime() - begin.getTime()) / 1000));
        const tags = [...new Set((t.tags ?? []).map((x) => (typeof x === 'string' ? x : x?.name)).filter((x): x is string => !!x?.trim()).map((x) => x.trim()))];
        const vals = [
          projectId,
          activityId,
          begin.toISOString(),
          end.toISOString(),
          duration,
          clean(t.description),
          JSON.stringify(tags),
          t.billable === false ? 0 : 1,
          t.hourlyRate ?? null,
          t.fixedRate ?? null,
          t.rate ?? null,
          t.exported ? 1 : 0,
        ];
        const existing = findEntry.get(src, t.id) as { id: string; user_id: string } | undefined;
        if (existing) {
          // Gehört der Eintrag (über einen anderen Kuvert-Benutzer importiert) jemand anderem, nicht anfassen
          if (existing.user_id !== userId) {
            status.counts.skipped++;
            continue;
          }
          update.run(...vals, existing.id);
          status.counts.updated++;
        } else {
          insert.run(userId, ...vals, uuid(), src, t.id);
          status.counts.created++;
        }
      }
    })();
    progress();
  }
}
