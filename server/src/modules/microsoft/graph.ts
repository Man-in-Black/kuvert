/**
 * Schlanker Microsoft-Graph-Client: Token-Verwaltung, Paging, JSON-Batching,
 * Hilfsfunktionen für Postfach-Pfade und kodierte IDs.
 */
import { apiBuffer, apiFetch, apiJson, type RequestOptions } from '../../core/http.js';
import { HttpError } from '../../core/errors.js';
import type { AccountContext } from '../../core/module.js';
import { createTokenManager } from '../../core/oauth.js';
import { msOAuthClient, msRefreshScopes } from './oauth.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphOptions extends Omit<RequestOptions, 'token' | 'query'> {
  /** Zusätzliche Prefer-Werte, z. B. 'outlook.timezone="UTC"' */
  prefer?: string[];
}

export interface BatchRequest {
  id?: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** Relativ zu /v1.0, z. B. "/me/messages/{id}" */
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface BatchResponse {
  id: string;
  status: number;
  body?: any;
}

interface ODataPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/** Baut einen Query-String mit %20 statt "+" (Graph/OData-sicher). */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // Kommas, Doppelpunkte und Schrägstriche lesbar lassen (in Query-Strings erlaubt, OData-üblich)
    parts.push(`${k}=${encodeURIComponent(String(v)).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/')}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const enc = encodeURIComponent;

/** Postfach-Schlüssel "me" oder SMTP-Adresse eines freigegebenen Postfachs → API-Pfad */
export function mbPath(mb: string): string {
  return !mb || mb === 'me' ? '/me' : `/users/${enc(mb)}`;
}

/** Kodiert Postfach + Graph-ID zu einer opaken ID ("me|AAMk…") */
export function encId(mb: string, id: string): string {
  return `${mb || 'me'}|${id}`;
}

export function decId(value: string): { mb: string; id: string } {
  const i = value.indexOf('|');
  if (i < 0) return { mb: 'me', id: value };
  return { mb: value.slice(0, i) || 'me', id: value.slice(i + 1) };
}

/** Führt fn für alle Elemente mit begrenzter Parallelität aus. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export class GraphClient {
  private tm: ReturnType<typeof createTokenManager>;

  constructor(readonly ctx: AccountContext) {
    this.tm = createTokenManager(ctx, msOAuthClient, () => msRefreshScopes(ctx.account.config));
  }

  readonly token = (): Promise<string> => this.tm.getAccessToken();

  url(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${GRAPH}${path}`;
  }

  private opts(o: GraphOptions = {}): RequestOptions {
    const prefer = ['IdType="ImmutableId"', ...(o.prefer ?? [])].join(', ');
    return { ...o, token: this.token, headers: { Prefer: prefer, ...(o.headers ?? {}) } };
  }

  json<T = any>(path: string, o?: GraphOptions): Promise<T> {
    return apiJson<T>(this.url(path), this.opts(o));
  }

  raw(path: string, o?: GraphOptions): Promise<Response> {
    return apiFetch(this.url(path), this.opts(o));
  }

  buffer(path: string, o?: GraphOptions) {
    return apiBuffer(this.url(path), this.opts(o));
  }

  async page<T = any>(path: string, o?: GraphOptions): Promise<{ items: T[]; next?: string }> {
    const r = await this.json<ODataPage<T>>(path, o);
    return { items: r?.value ?? [], next: r?.['@odata.nextLink'] };
  }

  /** Lädt alle Seiten (bis max Einträge). */
  async all<T = any>(path: string, o?: GraphOptions, max = 2000): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    while (url && out.length < max) {
      const p: { items: T[]; next?: string } = await this.page<T>(url, o);
      out.push(...p.items);
      url = p.next;
    }
    return out.slice(0, max);
  }

  /**
   * JSON-Batching (max. 20 Anfragen pro Batch, Antworten in Eingangsreihenfolge).
   * Graph führt die Anfragen eines Batches parallel aus. Betreffen sie dasselbe Element
   * (z. B. mehrere Anhänge einer Nachricht), kollidieren die ChangeKeys
   * („IrresolvableConflict“) – dann `sequential` setzen, das verkettet sie per dependsOn.
   */
  async batch(requests: BatchRequest[], opts: { sequential?: boolean } = {}): Promise<BatchResponse[]> {
    const results: BatchResponse[] = [];
    for (let i = 0; i < requests.length; i += 20) {
      const ids = requests.slice(i, i + 20).map((r, j) => r.id ?? String(i + j));
      const chunk = requests.slice(i, i + 20).map((r, j) => ({
        id: ids[j]!,
        ...(opts.sequential && j > 0 ? { dependsOn: [ids[j - 1]!] } : {}),
        method: r.method,
        url: r.url,
        body: r.body,
        headers: {
          Prefer: 'IdType="ImmutableId"',
          ...(r.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(r.headers ?? {}),
        },
      }));
      const res = await this.json<{ responses: BatchResponse[] }>('/$batch', { method: 'POST', body: { requests: chunk } });
      const byId = new Map((res?.responses ?? []).map((x) => [x.id, x]));
      for (const c of chunk) results.push(byId.get(c.id) ?? { id: c.id, status: 500, body: { error: { message: 'Keine Antwort im Batch' } } });
    }
    return results;
  }

  /** Wie batch(), wirft aber beim ersten Fehler. */
  async batchOrThrow(requests: BatchRequest[], opts: { sequential?: boolean } = {}): Promise<BatchResponse[]> {
    const res = await this.batch(requests, opts);
    const failed = res.find((r) => r.status >= 400);
    if (failed) {
      const msg = failed.body?.error?.message ?? `Fehler ${failed.status}`;
      throw new HttpError(failed.status, `Microsoft Graph: ${msg}`, failed.body);
    }
    return res;
  }
}

/* ───────────── Datums-Hilfen (dateTimeTimeZone) ───────────── */

const UTC_NAMES = new Set(['UTC', 'ETC/UTC', 'COORDINATED UNIVERSAL TIME', 'GMT', 'Z']);

/** Graph dateTimeTimeZone → ISO (bei UTC mit "Z"), sonst lokale Zeit ohne Zone. */
export function fromGraphDateTime(dt?: { dateTime?: string; timeZone?: string } | null): string {
  if (!dt?.dateTime) return '';
  const s = dt.dateTime.replace(/(\.\d{3})\d+$/, '$1');
  const tz = (dt.timeZone ?? 'UTC').toUpperCase();
  if (UTC_NAMES.has(tz)) {
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  return s;
}

/** ISO-Zeitpunkt → Graph dateTimeTimeZone in UTC */
export function toGraphUtc(iso: string): { dateTime: string; timeZone: string } {
  const d = new Date(iso);
  return { dateTime: d.toISOString().replace(/Z$/, ''), timeZone: 'UTC' };
}

/**
 * ISO-Zeitpunkt → Graph dateTimeTimeZone in einer IANA-Zeitzone (lokale Wandzeit),
 * damit Serien über Sommer-/Winterzeit hinweg die lokale Uhrzeit behalten. Fallback: UTC.
 */
export function toGraphZoned(iso: string, timeZone?: string): { dateTime: string; timeZone: string } {
  if (!timeZone || /^utc$/i.test(timeZone)) return toGraphUtc(iso);
  const d = new Date(iso);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
    return { dateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`, timeZone };
  } catch {
    return toGraphUtc(iso);
  }
}

/** Kalenderdatum (YYYY-MM-DD) eines Zeitpunkts in einer Zeitzone */
export function localDate(iso: string, timeZone?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
