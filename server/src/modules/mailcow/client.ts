/**
 * Minimaler Client für die mailcow-API (https://<host>/api/v1/…, Header X-API-Key).
 * Besonderheiten:
 *  - Schreibende Aufrufe sind POST auf /add|edit|delete/… und liefern ein Array
 *    aus { type: 'success' | 'danger' | 'error', msg } – HTTP 200 auch bei Fehlern.
 *  - Der API-Schlüssel muss "read-write" sein; die Kuvert-IP muss in mailcow freigegeben sein.
 */
import { AppError, HttpError } from '../../core/errors.js';

export interface MailcowResultEntry {
  type?: string;
  msg?: unknown;
  log?: unknown;
}

function msgText(msg: unknown): string {
  if (Array.isArray(msg)) return msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
  if (typeof msg === 'string') return msg;
  return msg === undefined || msg === null ? '' : JSON.stringify(msg);
}

/** Übersetzt gängige mailcow-Meldungscodes */
const MESSAGES: Record<string, string> = {
  access_denied: 'Zugriff verweigert',
  object_exists: 'Objekt existiert bereits',
  mailbox_invalid: 'Ungültiges Postfach',
  domain_not_found: 'Domain nicht gefunden',
  domain_invalid: 'Ungültige Domain',
  password_complexity: 'Passwort erfüllt nicht die Komplexitätsregeln von mailcow',
  password_mismatch: 'Passwörter stimmen nicht überein',
  mailbox_quota_exceeded: 'Kontingent der Domain überschritten',
  mailbox_quota_exceeds_domain_quota: 'Kontingent überschreitet das Domain-Limit',
  max_mailbox_exceeded: 'Maximale Anzahl Postfächer der Domain erreicht',
  alias_invalid: 'Ungültige Alias-Adresse',
  goto_invalid: 'Ungültiges Weiterleitungsziel',
  is_alias: 'Adresse ist bereits ein Alias',
  is_mailbox: 'Adresse ist bereits ein Postfach',
};

function describe(entries: MailcowResultEntry[]): string {
  return entries
    .map((e) => {
      const text = msgText(e.msg);
      const code = Array.isArray(e.msg) && typeof e.msg[0] === 'string' ? e.msg[0] : text;
      return MESSAGES[code] ? `${MESSAGES[code]} (${text})` : text;
    })
    .filter(Boolean)
    .join('; ');
}

export class MailcowClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}/api/v1/${path.replace(/^\/+/, '')}`;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new AppError(502, 'mailcow_unreachable', `mailcow nicht erreichbar: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* kein JSON */
    }
    const authFailed =
      res.status === 401 ||
      res.status === 403 ||
      (data && typeof data === 'object' && !Array.isArray(data) && (data as MailcowResultEntry).type === 'error' && /authentication failed/i.test(msgText((data as MailcowResultEntry).msg)));
    if (authFailed) {
      // Bewusst kein 401 (würde im Frontend als "abgemeldet" interpretiert)
      throw new AppError(400, 'mailcow_auth', 'mailcow: API-Schlüssel ungültig oder IP-Adresse von Kuvert nicht in mailcow freigegeben');
    }
    if (!res.ok) throw new HttpError(res.status, `mailcow-Fehler ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : msgText((data as MailcowResultEntry)?.msg)}`);
    return data;
  }

  /** GET /api/v1/get/… – liefert immer ein Array (Einzelobjekte werden eingepackt) */
  async getList<T = Record<string, unknown>>(path: string): Promise<T[]> {
    const data = await this.request('GET', `get/${path}`);
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === 'object') {
      // Leere Ergebnisse kommen teils als {} oder als Fehlerobjekt
      const o = data as Record<string, unknown>;
      if (Object.keys(o).length === 0) return [];
      if (o.type === 'error' || o.type === 'danger') throw new AppError(400, 'mailcow_error', `mailcow: ${msgText(o.msg)}`);
      return [o as T];
    }
    return [];
  }

  async getObject<T = Record<string, unknown>>(path: string): Promise<T> {
    return (await this.request('GET', `get/${path}`)) as T;
  }

  /** POST /api/v1/{add|edit|delete}/… – wirft bei danger/error-Einträgen */
  async write(path: string, body: unknown): Promise<MailcowResultEntry[]> {
    const data = await this.request('POST', path, body);
    const entries: MailcowResultEntry[] = Array.isArray(data) ? (data as MailcowResultEntry[]) : data && typeof data === 'object' ? [data as MailcowResultEntry] : [];
    const failed = entries.filter((e) => e.type === 'danger' || e.type === 'error');
    if (failed.length) throw new AppError(400, 'mailcow_error', `mailcow: ${describe(failed)}`);
    return entries;
  }
}
