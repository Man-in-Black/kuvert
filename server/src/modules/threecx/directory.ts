/**
 * Bereich „Telefon“: Telefonbuch, Kollegen mit Status und Anrufliste aus der 3CX-Konfigurations-API,
 * laufende Gespräche aus der Call Control API. Kurze Zwischenspeicher schonen die Anlage.
 */
import type { ThreeCxActiveCall, ThreeCxCallLog, ThreeCxCallLogEntry, ThreeCxColleagueList, ThreeCxContact } from '@kuvert/shared';
import { AppError } from '../../core/errors.js';
import type { ThreeCxClient, XapiCallLogRow, XapiContact } from './client.js';

/** Fehler der Konfigurations-API verständlich machen (fehlende Freigabe oder Rolle) */
async function xapi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && (err.code === 'threecx_auth' || err.code === 'threecx_forbidden')) {
      // Antwort von 3CX mitgeben – sonst ist nicht zu erkennen, was genau fehlt
      const up = err.details as { status?: number; detail?: string; path?: string } | undefined;
      const info = up?.status ? ` (3CX: HTTP ${up.status}${up.path ? ` bei ${up.path}` : ''}${up.detail ? ` – ${up.detail}` : ''})` : '';
      // Berichte (Anrufliste) brauchen die Rolle System-Eigentümer; Telefonbuch und Benutzer gehen schon mit weniger
      const report = /^\/xapi\/v1\/Report/i.test(up?.path ?? '');
      throw new AppError(
        403,
        'threecx_no_config_api',
        (report
          ? '3CX verweigert der API-Anwendung die Anrufliste. Sie braucht die Rolle System-Eigentümer. Ist die schon eingestellt, greift vermutlich eine Konsolenbeschränkung (IP-Freigabe für die 3CX-Verwaltung) – sie gilt auch für die API: die IP-Adresse des Kuvert-Servers dort freigeben.'
          : 'Die 3CX-API-Anwendung darf die Konfigurations-API nicht nutzen. In 3CX unter Integrationen → API „3CX Configuration API Access“ aktivieren und eine Rolle mit ausreichenden Rechten wählen. Ist eine Konsolenbeschränkung (IP-Freigabe) aktiv, muss auch die IP-Adresse des Kuvert-Servers freigegeben sein.') + info,
        up,
      );
    }
    throw err;
  }
}

function cached<T>(ttlMs: number) {
  let value: { at: number; key: string; data: Promise<T> } | null = null;
  return (key: string, load: () => Promise<T>, force = false): Promise<T> => {
    if (!force && value && value.key === key && Date.now() - value.at < ttlMs) return value.data;
    const data = load();
    value = { at: Date.now(), key, data };
    // Fehler nicht zwischenspeichern
    data.catch(() => {
      if (value?.data === data) value = null;
    });
    return data;
  };
}

const contactsCache = cached<ThreeCxContact[]>(5 * 60_000);
const usersCache = cached<Awaited<ReturnType<ThreeCxClient['pbxUsers']>>>(15_000);
const entitiesCache = cached<Awaited<ReturnType<ThreeCxClient['entities']>>>(5_000);

const clean = (v: string | null | undefined) => (v ?? '').trim() || null;

function mapContact(c: XapiContact): ThreeCxContact {
  const name = [c.FirstName, c.LastName].map((x) => x?.trim()).filter(Boolean).join(' ') || clean(c.CompanyName) || 'Ohne Namen';
  const phones: ThreeCxContact['phones'] = [];
  const add = (type: ThreeCxContact['phones'][number]['type'], n: string | null | undefined) => {
    const v = clean(n);
    if (v && !phones.some((p) => p.number === v)) phones.push({ type, number: v });
  };
  // PhoneNumber ist in 3CX das Feld „Mobil“
  add('mobile', c.PhoneNumber);
  add('work', c.Business);
  add('home', c.Home);
  add('other', c.Other);
  add('fax', c.BusinessFax);
  return { id: c.Id, name, company: clean(c.CompanyName), department: clean(c.Department), title: clean(c.Title), email: clean(c.Email), phones };
}

export async function searchContacts(client: ThreeCxClient, cacheKey: string, q: string, limit = 200): Promise<ThreeCxContact[]> {
  const all = await contactsCache(cacheKey, () => xapi(async () => (await client.contacts()).map(mapContact).sort((a, b) => a.name.localeCompare(b.name, 'de'))));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all.slice(0, limit);
  const digits = q.replace(/\D/g, '');
  return all
    .filter((c) => {
      const hay = [c.name, c.company, c.department, c.email, ...c.phones.map((p) => p.number)].filter(Boolean).join(' ').toLowerCase();
      if (words.every((w) => hay.includes(w))) return true;
      return digits.length >= 3 && c.phones.some((p) => p.number.replace(/\D/g, '').includes(digits));
    })
    .slice(0, limit);
}

/** Kollegen mit Status; „telefoniert“ nur für Nebenstellen, die die API-Anwendung überwacht */
export async function colleagues(client: ThreeCxClient, cacheKey: string, myExtension: string, force = false): Promise<ThreeCxColleagueList> {
  const [pbxUsers, entities] = await Promise.all([
    usersCache(cacheKey, () => xapi(() => client.pbxUsers()), force),
    entitiesCache(cacheKey, () => client.entities(), force).catch(() => null),
  ]);
  const busy = new Map<string, boolean>();
  for (const e of entities ?? []) busy.set(e.dn, (e.participants ?? []).length > 0);
  let myProfile: string | null = null;
  const list = pbxUsers
    .filter((u) => u.Number && u.Enabled !== false)
    .filter((u) => !u.HideInPhonebook || u.Number === myExtension)
    .map((u) => {
      const ext = String(u.Number);
      if (ext === myExtension) myProfile = clean(u.CurrentProfileName);
      return {
        extension: ext,
        name: clean(u.DisplayName) ?? ([u.FirstName, u.LastName].map((x) => x?.trim()).filter(Boolean).join(' ') || ext),
        email: clean(u.EmailAddress),
        mobile: clean(u.Mobile),
        profile: clean(u.CurrentProfileName),
        registered: !!u.IsRegistered,
        onCall: busy.has(ext) ? busy.get(ext)! : null,
        me: ext === myExtension,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { colleagues: list, myProfile };
}

export async function setMyProfile(client: ThreeCxClient, cacheKey: string, myExtension: string, profile: string): Promise<void> {
  const users = await xapi(() => client.pbxUsers());
  const me = users.find((u) => String(u.Number) === myExtension);
  if (!me) throw new AppError(404, 'not_found', `Nebenstelle ${myExtension} nicht in 3CX gefunden`);
  await xapi(() => client.setProfile(me.Id, profile));
  // Neuen Status sofort sichtbar machen
  void usersCache(cacheKey, () => xapi(() => client.pbxUsers()), true).catch(() => undefined);
}

/** ISO-8601-Dauer (PT1M23.4S) oder hh:mm:ss → Sekunden */
export function durationSeconds(v: string | null | undefined): number {
  if (!v) return 0;
  const iso = v.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (iso) return Math.round(Number(iso[1] ?? 0) * 86400 + Number(iso[2] ?? 0) * 3600 + Number(iso[3] ?? 0) * 60 + Number(iso[4] ?? 0));
  const hms = v.match(/^(?:(\d+)\.)?(\d+):(\d+):([\d.]+)$/);
  if (hms) return Math.round(Number(hms[1] ?? 0) * 86400 + Number(hms[2]) * 3600 + Number(hms[3]) * 60 + Number(hms[4]));
  return 0;
}

/** Externe Rufnummer bevorzugen, sonst die Nebenstelle */
function partyNumber(callerId: string | null | undefined, dn: string | null | undefined): string | null {
  const cid = clean(callerId);
  if (cid && /^[+\d][\d\s*#()/-]{1,}$/.test(cid)) return cid;
  return clean(dn);
}

function mapCall(r: XapiCallLogRow, ext: string): ThreeCxCallLogEntry {
  const outgoing = r.SourceDn === ext;
  const answered = !!r.Answered;
  const internal = /internal/i.test(r.Direction ?? '');
  const name = outgoing ? clean(r.DestinationDisplayName) : clean(r.SourceDisplayName);
  const number = outgoing ? partyNumber(r.DestinationCallerId, r.DestinationDn) : partyNumber(r.SourceCallerId, r.SourceDn);
  return {
    id: String(r.CdrId ?? r.CallHistoryId ?? `${r.CallId}-${r.StartTime}`),
    start: r.StartTime ?? new Date(0).toISOString(),
    direction: outgoing ? (internal ? 'internal' : 'out') : !answered ? 'missed' : internal ? 'internal' : 'in',
    name: name && name !== number ? name : null,
    number,
    answered,
    talkSeconds: durationSeconds(r.TalkingDuration),
    status: clean(r.Status),
  };
}

/** Eigene Anrufe der letzten Tage (ein Eintrag pro Gespräch, neueste zuerst) */
export async function callLog(client: ThreeCxClient, ext: string, days: number): Promise<ThreeCxCallLog> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const mine = (r: XapiCallLogRow) => r.SourceDn === ext || r.DestinationDn === ext || r.actionDnDn === ext;
  let rows: XapiCallLogRow[];
  try {
    rows = await xapi(() =>
      client.callLog(from, to, { $filter: `SourceDn eq '${ext}' or DestinationDn eq '${ext}'`, $orderby: 'StartTime desc', $top: 500 }),
    );
  } catch (err) {
    // Manche Versionen filtern das Funktionsergebnis nicht – dann ungefiltert holen und selbst filtern
    if (err instanceof AppError && err.code === 'threecx_no_config_api') throw err;
    rows = await xapi(() => client.callLog(from, to, { $orderby: 'StartTime desc', $top: 3000 }));
  }
  const seen = new Set<string>();
  const entries: ThreeCxCallLogEntry[] = [];
  for (const r of rows.filter(mine)) {
    const key = r.CallId !== undefined ? `c${r.CallId}` : `x${r.CdrId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(mapCall(r, ext));
  }
  entries.sort((a, b) => b.start.localeCompare(a.start));
  return { entries: entries.slice(0, 300), days };
}

export async function activeCalls(client: ThreeCxClient, ext: string): Promise<ThreeCxActiveCall[]> {
  const parts = await client.participants(ext).catch((err) => {
    if (err instanceof AppError && (err.status === 403 || err.status === 404)) return [];
    throw err;
  });
  return parts.map((p) => ({
    participantId: p.id,
    status: p.status,
    name: clean(p.party_caller_name),
    number: clean(p.party_caller_id) ?? clean(p.party_dn),
  }));
}
