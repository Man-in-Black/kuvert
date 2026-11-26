/**
 * Client für die 3CX-V20-APIs (Call Control unter /callcontrol, Konfiguration unter /xapi/v1).
 *
 * Anmeldung: POST /connect/token (application/x-www-form-urlencoded) mit
 * client_id, client_secret und grant_type=client_credentials → Bearer-Token, 60 Minuten gültig.
 * Voraussetzung in 3CX: Integrationen → API → Anwendung mit „3CX Call Control API Access“,
 * die Nebenstellen der Benutzer unter „zu überwachende Nebenstellen“ eintragen. Lizenz: 8SC+ ENT/AI.
 */
import crypto from 'node:crypto';
import { AppError, BadRequestError, HttpError } from '../../core/errors.js';

export function normalizeThreeCxUrl(v: string): string {
  let s = (v ?? '').trim();
  if (!s) throw new BadRequestError('Adresse der 3CX-Anlage fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    // Nur Schema, Host und Port – Pfade wie /#/office oder /webclient fallen weg
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new BadRequestError('Adresse der 3CX-Anlage ist ungültig');
  }
}

/**
 * Telefonnummer für 3CX aufbereiten: „(0)“ nach der Landesvorwahl entfernen, nur Ziffern, *, # und
 * ein führendes + behalten. plusPrefix ersetzt ein führendes + (z. B. "00").
 */
export function normalizeNumber(raw: string, plusPrefix = ''): string {
  let s = (raw ?? '').trim().replace(/^(tel|callto|sip):/i, '');
  s = s.replace(/\(0\)/g, '');
  const plus = s.startsWith('+');
  s = s.replace(/[^\d*#]/g, '');
  if (!s) throw new BadRequestError('Keine gültige Telefonnummer');
  if (s.length > 32) throw new BadRequestError('Telefonnummer ist zu lang');
  return plus ? `${plusPrefix || '+'}${s}` : s;
}

/** Nebenstelle prüfen (Ziffern, wie in 3CX) */
export function normalizeExtension(v: string): string {
  const s = (v ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) throw new BadRequestError('Nebenstelle muss aus Ziffern bestehen');
  return s;
}

export interface CcDevice {
  dn: string;
  device_id: string;
  user_agent: string;
}

export interface CcParticipant {
  id: number;
  status: string;
  dn: string;
  party_caller_name?: string;
  party_dn?: string;
  party_caller_id?: string;
  device_id?: string;
  callid?: number;
}

export interface CcEntity {
  dn: string;
  type: string;
  devices: CcDevice[];
  participants: CcParticipant[];
}

export interface XapiUser {
  Id: number;
  Number?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  DisplayName?: string | null;
  EmailAddress?: string | null;
  Mobile?: string | null;
  CurrentProfileName?: string | null;
  IsRegistered?: boolean | null;
  HideInPhonebook?: boolean | null;
  Enabled?: boolean | null;
}

export interface XapiContact {
  Id: number;
  FirstName?: string | null;
  LastName?: string | null;
  CompanyName?: string | null;
  Department?: string | null;
  Title?: string | null;
  Email?: string | null;
  PhoneNumber?: string | null;
  Business?: string | null;
  Home?: string | null;
  Other?: string | null;
  BusinessFax?: string | null;
}

export interface XapiCallLogRow {
  CallId?: number;
  CdrId?: string;
  CallHistoryId?: string | null;
  StartTime?: string | null;
  Direction?: string | null;
  Status?: string | null;
  Answered?: boolean | null;
  TalkingDuration?: string | null;
  SourceDn?: string | null;
  SourceCallerId?: string | null;
  SourceDisplayName?: string | null;
  DestinationDn?: string | null;
  DestinationCallerId?: string | null;
  DestinationDisplayName?: string | null;
  actionDnDn?: string | null;
}

export interface CcCallControlResult {
  finalstatus?: string;
  reason?: string;
  reasontext?: string;
  result?: CcParticipant;
}

type Method = 'GET' | 'POST' | 'PATCH';

const tokens = new Map<string, { token: string; expires: number }>();

/** OData-Abfrage (Leerzeichen als %20, nicht +) */
export function odata(query: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export class ThreeCxClient {
  constructor(
    private baseUrl: string,
    private clientId: string,
    private secret: string,
  ) {}

  private get cacheKey() {
    return crypto.createHash('sha256').update(`${this.baseUrl}\n${this.clientId}\n${this.secret}`).digest('hex');
  }

  private async token(force = false): Promise<string> {
    const cached = tokens.get(this.cacheKey);
    if (!force && cached && cached.expires > Date.now()) return cached.token;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.secret, grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AppError(502, 'threecx_unreachable', `3CX nicht erreichbar: ${(err as Error).message}`);
    }
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) throw new AppError(400, 'threecx_credentials', '3CX: Client-ID oder API-Schlüssel ungültig');
      throw new HttpError(res.status, `3CX-Anmeldung fehlgeschlagen (${res.status})`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new AppError(502, 'threecx_token', '3CX: Antwort ohne Zugriffstoken');
    // Eine Minute Puffer vor Ablauf
    const ttl = Math.max(60, (data.expires_in ?? 3600) - 60) * 1000;
    tokens.set(this.cacheKey, { token: data.access_token, expires: Date.now() + ttl });
    return data.access_token;
  }

  async request(method: Method, path: string, body?: unknown): Promise<Response> {
    const send = async (token: string) => {
      try {
        return await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new AppError(502, 'threecx_unreachable', `3CX nicht erreichbar: ${(err as Error).message}`);
      }
    };
    let res = await send(await this.token());
    // Token kann vor Ablauf ungültig werden (z. B. Schlüssel neu erzeugt)
    if (res.status === 401) res = await send(await this.token(true));
    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const p = JSON.parse(text) as { reasontext?: string; reason?: string; title?: string; detail?: string; error?: { message?: string } };
      detail = p.reasontext || p.detail || p.title || p.error?.message || p.reason || '';
    } catch {
      detail = text.slice(0, 200);
    }
    switch (res.status) {
      case 401:
        // Bewusst kein 401 (würde im Frontend als "abgemeldet" gewertet)
        throw new AppError(400, 'threecx_auth', '3CX: Zugriff verweigert – API-Schlüssel oder Lizenz prüfen (Call Control braucht 8SC+ ENT/AI)');
      case 403:
        throw new AppError(403, 'threecx_forbidden', `3CX: nicht erlaubt${detail ? ` – ${detail}` : ''}`);
      case 404:
        throw new AppError(404, 'not_found', `3CX: nicht gefunden${detail ? ` – ${detail}` : ''}`);
      case 422:
      case 424:
        throw new AppError(422, 'threecx_rejected', `3CX hat den Anruf abgelehnt${detail ? `: ${detail}` : ''}`);
      default:
        throw new HttpError(res.status, `3CX-Fehler ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async json<T>(method: Method, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const res = await this.request(method, path, body);
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  }

  /* ───────────── Call Control ───────────── */

  /** Alle Nebenstellen, die die API-Anwendung überwacht */
  async entities(): Promise<CcEntity[]> {
    return (await this.json<CcEntity[]>('GET', '/callcontrol')).data ?? [];
  }

  async devices(dn: string): Promise<CcDevice[]> {
    try {
      return (await this.json<CcDevice[]>('GET', `/callcontrol/${encodeURIComponent(dn)}/devices`)).data ?? [];
    } catch (err) {
      if (err instanceof AppError && (err.status === 403 || err.status === 404)) {
        throw new AppError(409, 'threecx_not_monitored', `Nebenstelle ${dn} wird von der 3CX-API-Anwendung nicht überwacht (3CX: Integrationen → API)`);
      }
      throw err;
    }
  }

  /**
   * Anruf von einer Nebenstelle aus starten. Mit Gerät ist der Ablauf eindeutig (3CX empfiehlt das);
   * ohne Gerät nutzt 3CX bei genau einem registrierten Gerät dieses, sonst den alten MakeCall-Dienst.
   */
  async makeCall(dn: string, destination: string, deviceId?: string | null): Promise<{ status: number; data: CcCallControlResult | null }> {
    const path = deviceId
      ? `/callcontrol/${encodeURIComponent(dn)}/devices/${encodeURIComponent(deviceId)}/makecall`
      : `/callcontrol/${encodeURIComponent(dn)}/makecall`;
    return this.json<CcCallControlResult>('POST', path, { destination, timeout: 30 });
  }

  /** Aktuelle Gespräche einer Nebenstelle */
  async participants(dn: string): Promise<CcParticipant[]> {
    return (await this.json<CcParticipant[]>('GET', `/callcontrol/${encodeURIComponent(dn)}/participants`)).data ?? [];
  }

  async drop(dn: string, participantId: number): Promise<void> {
    await this.request('POST', `/callcontrol/${encodeURIComponent(dn)}/participants/${participantId}/drop`, {});
  }

  /* ───────────── Konfigurations-API (optional, braucht „3CX Configuration API Access“) ───────────── */

  async xapi<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return (await this.json<T>('GET', `/xapi/v1/${path}${odata(query)}`)).data as T;
  }

  /** Benutzer der Anlage (Nebenstellen) */
  async pbxUsers(): Promise<XapiUser[]> {
    const data = await this.xapi<{ value?: XapiUser[] }>('Users', {
      $select: 'Id,Number,FirstName,LastName,DisplayName,EmailAddress,Mobile,CurrentProfileName,IsRegistered,HideInPhonebook,Enabled',
      $top: 2000,
    });
    return data?.value ?? [];
  }

  /** Benutzer der Anlage mit Nebenstelle und E-Mail (für die automatische Zuordnung) */
  async users(): Promise<{ number: string; email: string }[]> {
    return (await this.pbxUsers())
      .filter((u) => u.Number && u.EmailAddress)
      .map((u) => ({ number: String(u.Number), email: String(u.EmailAddress).trim().toLowerCase() }));
  }

  async setProfile(userId: number, profile: string): Promise<void> {
    await this.request('PATCH', `/xapi/v1/Users(${userId})`, { CurrentProfileName: profile });
  }

  /** Telefonbuch der Anlage */
  async contacts(): Promise<XapiContact[]> {
    const data = await this.xapi<{ value?: XapiContact[] }>('Contacts', {
      $select: 'Id,FirstName,LastName,CompanyName,Department,Title,Email,PhoneNumber,Business,Home,Other,BusinessFax',
      $top: 5000,
    });
    return data?.value ?? [];
  }

  /**
   * Anrufliste (wie „Berichte → Anrufbericht“). Parameter in Klammern gehören zur URL und
   * brauchen auch leer einen Wert; Zeichenketten in einfachen Anführungszeichen.
   */
  async callLog(from: Date, to: Date, query: Record<string, string | number | boolean | undefined>): Promise<XapiCallLogRow[]> {
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const fn =
      `ReportCallLogData/Pbx.GetCallLogData(periodFrom=${iso(from)},periodTo=${iso(to)},sourceType=0,sourceFilter='',` +
      `destinationType=0,destinationFilter='',callsType=0,callTimeFilterType=0,callTimeFilterFrom='0:00:0',` +
      `callTimeFilterTo='0:00:0',hidePcalls=false)`;
    const data = await this.xapi<{ value?: XapiCallLogRow[] }>(fn, query);
    return data?.value ?? [];
  }
}
