/**
 * Client für die (lesende) REST-API von Mail-Archiver (https://github.com/s1t5/mail-archiver).
 * Authentifizierung: `Authorization: Bearer ma_…` (persönlicher Schlüssel je Benutzer).
 * Fehler kommen als RFC-7807 problem+json.
 */
import { AppError, BadRequestError, HttpError } from '../../core/errors.js';

export function normalizeArchiverUrl(v: string): string {
  let s = (v ?? '').trim();
  if (!s) throw new BadRequestError('URL des Mail-Archivers fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/api(\/v1)?\/?$/i, '').replace(/\/+$/, '')}`;
  } catch {
    throw new BadRequestError('URL des Mail-Archivers ist ungültig');
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

export class ArchiverClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private url(path: string, query?: Record<string, unknown>) {
    const u = new URL(`${this.baseUrl}/api/v1/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  async fetch(path: string, query?: Record<string, unknown>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path, query), {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json, */*' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AppError(502, 'archiver_unreachable', `Mail-Archiver nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const p = JSON.parse(text) as { title?: string; detail?: string };
      detail = p.detail || p.title || '';
    } catch {
      detail = text.slice(0, 200);
    }
    switch (res.status) {
      case 401:
        // Bewusst kein 401 (würde im Frontend als "abgemeldet" gewertet)
        throw new AppError(400, 'archiver_auth', 'Mail-Archiver: API-Schlüssel ungültig, abgelaufen oder widerrufen');
      case 403:
        throw new AppError(403, 'archiver_forbidden', `Mail-Archiver: nicht erlaubt${detail ? ` – ${detail}` : ' (Downloads im Archiv deaktiviert?)'}`);
      case 404:
        throw new AppError(404, 'not_found', `Mail-Archiver: nicht gefunden${detail ? ` – ${detail}` : ' (oder API nicht aktiviert: Api__Enabled=true)'}`);
      case 429:
        throw new AppError(429, 'rate_limited', 'Mail-Archiver: Anfragelimit erreicht – bitte einen Moment warten');
      case 400:
        throw new BadRequestError(`Mail-Archiver: ${detail || 'ungültige Anfrage'}`);
      default:
        throw new HttpError(res.status, `Mail-Archiver-Fehler ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async json<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(path, query);
    return (await res.json()) as T;
  }

  async binary(path: string): Promise<{ data: Buffer; contentType: string; filename?: string }> {
    const res = await this.fetch(path);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameFromDisposition(res.headers.get('content-disposition')),
    };
  }
}
