/**
 * DAV-Sitzung pro Konto: getrennte tsdav-Clients für CalDAV und CardDAV
 * (Discovery + Login einmalig, danach wiederverwendet).
 */
import { DAVClient } from 'tsdav';
import { AppError, AuthError, HttpError, NotFoundError } from '../../core/errors.js';

export interface DavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

/** Wandelt tsdav-/fetch-Fehler in verständliche Fehler um. */
export function mapDavError(err: unknown, what = 'DAV-Server'): Error {
  if (err instanceof AppError) return err;
  const msg = (err as Error)?.message ?? String(err);
  if (/\b401\b|unauthori[sz]ed|invalid credentials/i.test(msg)) return new AuthError(`${what}: Anmeldung fehlgeschlagen – Benutzername oder Passwort falsch`);
  if (/\b403\b|forbidden/i.test(msg)) return new AppError(403, 'dav_forbidden', `${what}: Zugriff verweigert`);
  if (/\b404\b|not found/i.test(msg)) return new NotFoundError('Ressource auf dem DAV-Server');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|EAI_AGAIN/i.test(msg)) return new AppError(502, 'dav_unreachable', `${what} nicht erreichbar: ${msg}`);
  return new AppError(502, 'dav_error', `${what}: ${msg}`);
}

/** Prüft eine Response von tsdav-Schreibaufrufen (die nicht selbst werfen). */
export async function ensureOk(res: Response, action: string): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  if (res.status === 401) throw new AuthError(`${action}: Anmeldung fehlgeschlagen`);
  if (res.status === 404) throw new NotFoundError('Objekt');
  if (res.status === 412) throw new AppError(409, 'conflict', `${action}: Das Objekt wurde zwischenzeitlich geändert – bitte neu laden`);
  const detail = text.match(/<(?:\w+:)?message>([^<]+)</)?.[1] ?? text.slice(0, 200);
  throw new HttpError(res.status, `${action} fehlgeschlagen (${res.status})${detail ? `: ${detail}` : ''}`);
}

export class DavSession {
  private clients: Partial<Record<'caldav' | 'carddav', Promise<DAVClient>>> = {};

  constructor(private creds: () => DavCredentials) {}

  private async create(type: 'caldav' | 'carddav'): Promise<DAVClient> {
    const c = this.creds();
    const client = new DAVClient({
      serverUrl: c.serverUrl,
      credentials: { username: c.username, password: c.password },
      authMethod: 'Basic',
      defaultAccountType: type,
    });
    try {
      await client.login();
    } catch (err) {
      throw mapDavError(err, type === 'caldav' ? 'CalDAV-Server' : 'CardDAV-Server');
    }
    if (!client.account?.homeUrl) {
      throw new AppError(502, 'dav_discovery', `${type === 'caldav' ? 'Kalender' : 'Adressbücher'} konnten auf dem Server nicht gefunden werden`);
    }
    return client;
  }

  private get(type: 'caldav' | 'carddav'): Promise<DAVClient> {
    let p = this.clients[type];
    if (!p) {
      p = this.create(type);
      this.clients[type] = p;
      p.catch(() => {
        if (this.clients[type] === p) delete this.clients[type];
      });
    }
    return p;
  }

  caldav(): Promise<DAVClient> {
    return this.get('caldav');
  }

  carddav(): Promise<DAVClient> {
    return this.get('carddav');
  }

  /** Bei Auth-Fehlern Sitzung verwerfen, damit neue Zugangsdaten greifen */
  reset() {
    this.clients = {};
  }

  basicAuthHeader(): string {
    const c = this.creds();
    return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
  }
}
