/**
 * Client für die REST-API von Paperless-ngx (https://docs.paperless-ngx.com/api/).
 * Authentifizierung: `Authorization: Token …` (persönlicher Token je Benutzer,
 * in Paperless unter „Mein Profil → API-Token“). Fehler kommen als DRF-JSON ({ detail } oder Feldfehler).
 */
import { AppError, BadRequestError, HttpError } from '../../core/errors.js';

export function normalizePaperlessUrl(v: string): string {
  let s = (v ?? '').trim();
  if (!s) throw new BadRequestError('URL von Paperless fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/api\/?$/i, '').replace(/\/+$/, '')}`;
  } catch {
    throw new BadRequestError('URL von Paperless ist ungültig');
  }
}

/** Dateiname aus Content-Disposition (filename* bevorzugt) */
export function filenameFromDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = h.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
    } catch {
      /* weiter */
    }
  }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1]?.trim();
}

/** Lesbare Fehlermeldung aus einer DRF-Antwort ({ detail }, { feld: [..] } oder ["…"]) */
function drfDetail(text: string): string {
  try {
    const p = JSON.parse(text) as unknown;
    if (typeof p === 'string') return p;
    if (Array.isArray(p)) return p.map(String).join(' ');
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      if (typeof o.detail === 'string') return o.detail;
      return Object.entries(o)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : String(v)}`)
        .join('; ');
    }
  } catch {
    /* kein JSON */
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class PaperlessClient {
  constructor(
    readonly baseUrl: string,
    private token: string,
  ) {}

  private url(path: string, query?: Query) {
    const u = new URL(`${this.baseUrl}/api/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  async fetch(path: string, opts: { query?: Query; method?: string; body?: FormData | string; json?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Token ${this.token}`, Accept: 'application/json, */*' };
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new AppError(502, 'paperless_unreachable', `Paperless nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.ok) return res;

    const detail = drfDetail(await res.text().catch(() => ''));
    if (res.status >= 300 && res.status < 400) {
      throw new AppError(400, 'paperless_redirect', 'Paperless leitet auf eine Anmeldeseite um – ist die URL korrekt (ohne /api)?');
    }
    switch (res.status) {
      case 401:
        // Bewusst kein 401 (würde im Frontend als "abgemeldet" gewertet)
        throw new AppError(400, 'paperless_auth', 'Paperless: API-Token ungültig oder widerrufen');
      case 403:
        throw new AppError(403, 'paperless_forbidden', `Paperless: keine Berechtigung${detail ? ` – ${detail}` : ''}`);
      case 404:
        throw new AppError(404, 'not_found', `Paperless: nicht gefunden${detail ? ` – ${detail}` : ''}`);
      case 429:
        throw new AppError(429, 'rate_limited', 'Paperless: Anfragelimit erreicht – bitte einen Moment warten');
      case 400:
        throw new BadRequestError(`Paperless: ${detail || 'ungültige Anfrage'}`);
      default:
        throw new HttpError(res.status, `Paperless-Fehler ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async json<T>(path: string, query?: Query): Promise<T> {
    const res = await this.fetch(path, { query });
    return (await res.json()) as T;
  }

  async post<T>(path: string, json: unknown): Promise<T> {
    const res = await this.fetch(path, { method: 'POST', json });
    return (await res.json()) as T;
  }

  async binary(path: string, query?: Query): Promise<{ data: Buffer; contentType: string; filename?: string }> {
    const res = await this.fetch(path, { query, timeoutMs: 120_000 });
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
      filename: filenameFromDisposition(res.headers.get('content-disposition')),
    };
  }

  /** Alle Einträge einer Liste (Korrespondenten, Tags …) */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const r = await this.json<{ results: T[]; next: string | null }>(path, { page, page_size: 1000 });
      out.push(...r.results);
      if (!r.next || page >= 20) return out;
      page++;
    }
  }
}
