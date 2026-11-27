/**
 * Zeiterfassung (angelehnt an Kimai): Timer starten/stoppen, Zeiten nachtragen und bearbeiten,
 * gemeinsame Kunden/Projekte/Tätigkeiten pflegen, Auswertung und CSV-Export, Import aus Kimai 2.
 *
 * Abschalten: KUVERT_DISABLED_MODULES=timetrack
 */
import { z } from 'zod';
import type { TtEntryList, TtKimaiTestResult, TtReport, TtReportRow } from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { BadRequestError } from '../../core/errors.js';
import { defineModule } from '../../core/module.js';
import { parse } from '../../routes/util.js';
import { KimaiClient, importStatus, kimaiConn, startKimaiImport } from './kimai.js';
import { entries, masterData, migrations, toIso } from './store.js';

type IdParams = { Params: { id: string } };

const optText = (max: number) => z.string().max(max).nullable().optional();
const rate = z.number().min(0).max(1_000_000).nullable().optional();
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'Farbe als #rrggbb')
  .nullable()
  .optional();
const tags = z.array(z.string().max(100)).max(30).optional();

const customerSchema = z.object({
  name: z.string().min(1).max(200),
  number: optText(100),
  comment: optText(5000),
  color,
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'Währung als ISO-Code, z. B. EUR').optional(),
  hourlyRate: rate,
  visible: z.boolean().optional(),
});

const projectSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1).max(200),
  number: optText(100),
  orderNumber: optText(100),
  comment: optText(5000),
  color,
  hourlyRate: rate,
  billable: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const activitySchema = z.object({
  projectId: z.string().min(1).nullable(),
  name: z.string().min(1).max(200),
  comment: optText(5000),
  color,
  hourlyRate: rate,
  billable: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const entrySchema = z.object({
  projectId: z.string().min(1),
  activityId: z.string().min(1).nullable().optional(),
  begin: z.string().min(1).max(40),
  end: z.string().min(1).max(40).nullable().optional(),
  description: optText(5000),
  tags,
  billable: z.boolean().optional(),
  fixedRate: rate,
});

const startSchema = z.object({
  projectId: z.string().min(1),
  activityId: z.string().min(1).nullable().optional(),
  description: optText(5000),
  tags,
  billable: z.boolean().optional(),
});

const rangeSchema = z.object({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  tz: z.string().max(64).optional(),
});

const kimaiSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  token: z.string().max(2000).optional(),
  username: z.string().max(200).nullable().optional(),
});

/** Datum (YYYY-MM-DD) eines Zeitpunkts in einer Zeitzone */
function dayFormatter(tz: string | undefined) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  return (iso: string) => fmt.format(new Date(iso));
}

function checkRange(from: string, to: string) {
  const f = toIso(from, 'Beginn des Zeitraums');
  const t = toIso(to, 'Ende des Zeitraums');
  if (t <= f) throw new BadRequestError('Der Zeitraum ist leer');
  if (Date.parse(t) - Date.parse(f) > 3 * 366 * 86400_000) throw new BadRequestError('Der Zeitraum darf höchstens drei Jahre umfassen');
  return { from: f, to: t };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Formel-Injektion in Tabellenkalkulationen verhindern
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export default defineModule({
  id: 'timetrack',
  name: 'Zeiterfassung',
  description: 'Zeiterfassung mit Timer, Kunden/Projekten/Tätigkeiten und Kimai-Import',
  features: ['timetrack'],
  migrations,

  routes(app, ctx) {
    const changed = (userId: string) => ctx.bus.publish(userId, { type: 'timetrack.changed', scope: 'entries' });
    /** Gemeinsame Stammdaten: alle angemeldeten Benutzer informieren */
    const masterChanged = () => {
      for (const id of ctx.bus.onlineUserIds()) ctx.bus.publish(id, { type: 'timetrack.changed', scope: 'masterdata' });
    };

    /* ═════════════════════════════ Stammdaten ═════════════════════════════ */

    app.get('/masterdata', async () => masterData.all());

    app.post('/customers', async (req) => {
      const r = masterData.saveCustomer(null, parse(customerSchema, req.body));
      masterChanged();
      return r;
    });
    app.put<IdParams>('/customers/:id', async (req) => {
      const r = masterData.saveCustomer(req.params.id, parse(customerSchema, req.body));
      masterChanged();
      return r;
    });
    app.delete<IdParams>('/customers/:id', async (req) => {
      masterData.deleteCustomer(req.params.id);
      masterChanged();
      return { ok: true };
    });

    app.post('/projects', async (req) => {
      const r = masterData.saveProject(null, parse(projectSchema, req.body));
      masterChanged();
      return r;
    });
    app.put<IdParams>('/projects/:id', async (req) => {
      const r = masterData.saveProject(req.params.id, parse(projectSchema, req.body));
      masterChanged();
      return r;
    });
    app.delete<IdParams>('/projects/:id', async (req) => {
      masterData.deleteProject(req.params.id);
      masterChanged();
      return { ok: true };
    });

    app.post('/activities', async (req) => {
      const r = masterData.saveActivity(null, parse(activitySchema, req.body));
      masterChanged();
      return r;
    });
    app.put<IdParams>('/activities/:id', async (req) => {
      const r = masterData.saveActivity(req.params.id, parse(activitySchema, req.body));
      masterChanged();
      return r;
    });
    app.delete<IdParams>('/activities/:id', async (req) => {
      masterData.deleteActivity(req.params.id);
      masterChanged();
      return { ok: true };
    });

    /* ═════════════════════════════ Timer ═════════════════════════════ */

    app.get('/active', async (req) => ({ entry: entries.running(req.user.id) }));

    /** Neuen Timer starten – ein laufender wird vorher gestoppt (wie in Kimai) */
    app.post('/start', async (req) => {
      const b = parse(startSchema, req.body);
      const now = new Date();
      entries.stop(req.user.id, now);
      const entry = entries.create(req.user.id, {
        projectId: b.projectId,
        activityId: b.activityId ?? null,
        begin: now.toISOString(),
        end: null,
        description: b.description ?? null,
        tags: b.tags ?? [],
        billable: b.billable,
      });
      changed(req.user.id);
      return entry;
    });

    app.post('/stop', async (req) => {
      const entry = entries.stop(req.user.id);
      changed(req.user.id);
      return { entry };
    });

    /** Eintrag mit gleichen Angaben neu starten */
    app.post<IdParams>('/entries/:id/restart', async (req) => {
      const src = entries.get(req.user.id, req.params.id);
      const now = new Date();
      entries.stop(req.user.id, now);
      const entry = entries.create(req.user.id, {
        projectId: src.projectId,
        activityId: src.activityId,
        begin: now.toISOString(),
        end: null,
        description: src.description,
        tags: src.tags,
        billable: src.billable,
      });
      changed(req.user.id);
      return entry;
    });

    /* ═════════════════════════════ Einträge ═════════════════════════════ */

    app.get('/entries', async (req): Promise<TtEntryList> => {
      const q = parse(
        z.object({
          from: z.string().max(40).optional(),
          to: z.string().max(40).optional(),
          projectId: z.string().max(100).optional(),
          customerId: z.string().max(100).optional(),
          activityId: z.string().max(100).optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(2000).optional(),
        }),
        req.query,
      );
      return entries.list(req.user.id, { ...q, q: q.q?.trim() || undefined });
    });

    app.get('/recent', async (req) => entries.recent(req.user.id));

    app.get('/tags', async (req) => entries.tags(req.user.id));

    app.post('/entries', async (req) => {
      const b = parse(entrySchema, req.body);
      const entry = entries.create(req.user.id, {
        projectId: b.projectId,
        activityId: b.activityId ?? null,
        begin: b.begin,
        end: b.end ?? null,
        description: b.description ?? null,
        tags: b.tags ?? [],
        billable: b.billable,
        fixedRate: b.fixedRate,
      });
      changed(req.user.id);
      return entry;
    });

    app.put<IdParams>('/entries/:id', async (req) => {
      const b = parse(entrySchema, req.body);
      const entry = entries.update(req.user.id, req.params.id, {
        projectId: b.projectId,
        activityId: b.activityId ?? null,
        begin: b.begin,
        end: b.end ?? null,
        description: b.description ?? null,
        tags: b.tags ?? [],
        billable: b.billable,
        fixedRate: b.fixedRate,
      });
      changed(req.user.id);
      return entry;
    });

    app.delete<IdParams>('/entries/:id', async (req) => {
      entries.delete(req.user.id, req.params.id);
      changed(req.user.id);
      return { ok: true };
    });

    /* ═════════════════════════════ Auswertung & Export ═════════════════════════════ */

    app.get('/report', async (req): Promise<TtReport> => {
      const q = parse(rangeSchema, req.query);
      const { from, to } = checkRange(q.from, q.to);
      const day = dayFormatter(q.tz);
      const rows = new Map<string, TtReportRow>();
      const days = new Map<string, number>();
      const tagMap = new Map<string, number>();
      const amounts = new Map<string, number>();
      let total = 0;
      let billable = 0;
      for (const e of entries.range(req.user.id, from, to)) {
        const key = `${e.projectId}|${e.activityId ?? ''}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            customerId: e.customerId,
            customerName: e.customerName,
            projectId: e.projectId,
            projectName: e.projectName,
            activityId: e.activityId,
            activityName: e.activityName,
            color: e.color,
            currency: e.currency,
            duration: 0,
            billableDuration: 0,
            amount: 0,
            count: 0,
          };
          rows.set(key, row);
        }
        row.duration += e.duration;
        row.count++;
        total += e.duration;
        if (e.billable) {
          row.billableDuration += e.duration;
          billable += e.duration;
          if (e.rate) {
            row.amount = Math.round((row.amount + e.rate) * 100) / 100;
            amounts.set(e.currency, Math.round(((amounts.get(e.currency) ?? 0) + e.rate) * 100) / 100);
          }
        }
        const d = day(e.begin);
        days.set(d, (days.get(d) ?? 0) + e.duration);
        for (const t of e.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + e.duration);
      }
      return {
        from,
        to,
        rows: [...rows.values()].sort(
          (a, b) => a.customerName.localeCompare(b.customerName, 'de') || a.projectName.localeCompare(b.projectName, 'de') || b.duration - a.duration,
        ),
        days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, duration]) => ({ date, duration })),
        total,
        billable,
        amounts: [...amounts.entries()].map(([currency, amount]) => ({ currency, amount })),
        tags: [...tagMap.entries()].sort((a, b) => b[1] - a[1]).map(([tag, duration]) => ({ tag, duration })),
      };
    });

    /** CSV (Semikolon, UTF-8 mit BOM – öffnet sich in Excel direkt richtig) */
    app.get('/export.csv', async (req, reply) => {
      const q = parse(rangeSchema, req.query);
      const { from, to } = checkRange(q.from, q.to);
      const tz = (() => {
        try {
          new Intl.DateTimeFormat('de-DE', { timeZone: q.tz || 'Europe/Berlin' });
          return q.tz || 'Europe/Berlin';
        } catch {
          return 'Europe/Berlin';
        }
      })();
      const date = new Intl.DateTimeFormat('de-DE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const time = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      const num = (n: number | null) => (n == null ? '' : n.toFixed(2).replace('.', ','));
      const lines = [['Datum', 'Beginn', 'Ende', 'Dauer (h)', 'Kunde', 'Projekt', 'Tätigkeit', 'Beschreibung', 'Schlagworte', 'Abrechenbar', 'Stundensatz', 'Betrag', 'Währung']];
      for (const e of entries.range(req.user.id, from, to)) {
        lines.push([
          date.format(new Date(e.begin)),
          time.format(new Date(e.begin)),
          e.end ? time.format(new Date(e.end)) : '',
          num(e.duration / 3600),
          e.customerName,
          e.projectName,
          e.activityName ?? '',
          e.description ?? '',
          e.tags.join(', '),
          e.billable ? 'ja' : 'nein',
          num(e.hourlyRate),
          num(e.rate),
          e.currency,
        ]);
      }
      const body = '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n') + '\r\n';
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="zeiterfassung-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"`)
        .header('Cache-Control', 'no-store')
        .send(body);
    });

    /* ═════════════════════════════ Kimai-Import ═════════════════════════════ */

    app.get('/kimai', async (req) => ({ connection: kimaiConn.get(req.user.id), status: importStatus(req.user.id) }));

    app.post('/kimai/test', async (req): Promise<TtKimaiTestResult> => {
      const auth = kimaiConn.resolve(req.user.id, parse(kimaiSchema, req.body));
      return new KimaiClient(auth).test();
    });

    app.post('/kimai/import', async (req) => {
      const auth = kimaiConn.resolve(req.user.id, parse(kimaiSchema, req.body));
      await new KimaiClient(auth).test();
      kimaiConn.save(req.user.id, auth);
      audit.log('timetrack.kimai_import', { req, details: { baseUrl: auth.baseUrl } });
      const userId = req.user.id;
      const status = startKimaiImport(userId, auth, {
        log: ctx.log,
        notify: (scope) => (scope === 'masterdata' ? masterChanged() : ctx.bus.publish(userId, { type: 'timetrack.changed', scope })),
      });
      return { status };
    });

    app.delete('/kimai', async (req) => {
      kimaiConn.remove(req.user.id);
      return { ok: true };
    });
  },
});
