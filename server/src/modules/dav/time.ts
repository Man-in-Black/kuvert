/**
 * Zeitumrechnung für iCalendar-Daten: ical.js-Zeiten → JS-Date/ISO, inkl.
 * Unterstützung für TZIDs ohne mitgelieferte VTIMEZONE (IANA- und Windows-Namen).
 */
import ICAL from 'ical.js';

type ICalTime = InstanceType<typeof ICAL.Time>;

/** Häufige Windows-Zeitzonennamen (Outlook/Exchange) → IANA */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const validZones = new Map<string, boolean>();

function isValidZone(tz: string): boolean {
  let v = validZones.get(tz);
  if (v === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      v = true;
    } catch {
      v = false;
    }
    validZones.set(tz, v);
  }
  return v;
}

/** Normalisiert einen TZID-Parameter zu einer gültigen IANA-Zone (oder undefined). */
export function normalizeTzid(tzid: unknown): string | undefined {
  if (typeof tzid !== 'string' || !tzid.trim()) return undefined;
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  if (isValidZone(t)) return t;
  // z. B. "/mozilla.org/20050126_1/Europe/Berlin" oder "/freeassociation.sourceforge.net/Europe/Berlin"
  const m = t.match(/([A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?)$/);
  if (m && isValidZone(m[1]!)) return m[1];
  return undefined;
}

/** UTC-Offset (in Minuten) einer Zeitzone zu einem Zeitpunkt. */
function zoneOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Lokale Wandzeit in einer Zone → UTC-Date */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMinutes(guess, tz);
  let ts = guess - off1 * 60000;
  const off2 = zoneOffsetMinutes(ts, tz);
  if (off2 !== off1) ts = guess - off2 * 60000;
  return new Date(ts);
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0');

export function dateOnly(t: { year: number; month: number; day: number }): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

/** ical.js-Zeit → Date. tzidHint wird genutzt, wenn die Zone nicht aufgelöst werden konnte. */
export function timeToDate(t: ICalTime, tzidHint?: string): Date {
  if (t.isDate) return new Date(Date.UTC(t.year, t.month - 1, t.day));
  if (t.zone && t.zone !== ICAL.Timezone.localTimezone) return t.toJSDate();
  const tz = normalizeTzid(tzidHint ?? (t as unknown as { timezone?: string }).timezone);
  if (tz) return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
  return t.toJSDate();
}

/** ical.js-Zeit → ISO (Datum bei ganztägig, sonst UTC-Zeitstempel) */
export function timeToIso(t: ICalTime, tzidHint?: string): string {
  return t.isDate ? dateOnly(t) : timeToDate(t, tzidHint).toISOString();
}

/** ISO-String (Datum oder Zeitpunkt) → ical.js-Zeit (UTC bzw. Datum) */
export function isoToTime(iso: string, allDay: boolean): ICalTime {
  if (allDay) {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) throw new Error(`Ungültiges Datum: ${iso}`);
    return ICAL.Time.fromData({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), isDate: true });
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Ungültiger Zeitpunkt: ${iso}`);
  return ICAL.Time.fromJSDate(d, true);
}

/** Datumsteil eines ISO-Strings um n Tage verschieben (für exklusive Enddaten) */
export function addDays(dateIso: string, days: number): string {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateIso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/**
 * Zeitpunkt → Wandzeit in einer Zone (ohne Zonenbezug, für DTSTART;TZID=…).
 * undefined, wenn die Zone nicht aufgelöst werden kann.
 */
export function isoToZonedTime(iso: string, tzid: string | undefined): ICalTime | undefined {
  const tz = normalizeTzid(tzid);
  const d = new Date(iso);
  if (!tz || Number.isNaN(d.getTime())) return undefined;
  if (tz === 'UTC') return undefined;
  const local = new Date(d.getTime() + zoneOffsetMinutes(d.getTime(), tz) * 60000);
  return ICAL.Time.fromData({
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    isDate: false,
  });
}

/** Wandzeit-Komponenten als Millisekunden (Zone wird ignoriert) – für Verschiebungen „um x Stunden/Tage“ */
export function wallMs(t: ICalTime): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);
}

export interface ZoneRule {
  /** 'daylight' (Sommerzeit) oder 'standard' */
  kind: 'daylight' | 'standard';
  /** Offsets in Minuten vor/nach dem Wechsel */
  from: number;
  to: number;
  /** Monat 1–12, Wochentag 0=So, n-ter Wochentag (−1 = letzter), Wandzeit vor dem Wechsel */
  month: number;
  weekday: number;
  nth: number;
  hour: number;
  minute: number;
}

/**
 * Jährliche Zeitumstellungen einer Zone als Regeln (für eine VTIMEZONE).
 * Leeres Array = keine Sommerzeit; offset = aktueller Standard-Offset.
 */
export function zoneRules(tzid: string, year = new Date().getUTCFullYear()): { offset: number; rules: ZoneRule[] } | undefined {
  const tz = normalizeTzid(tzid);
  if (!tz) return undefined;
  const rules: ZoneRule[] = [];
  const DAY = 86_400_000;
  const end = Date.UTC(year + 1, 0, 1);
  let prev = zoneOffsetMinutes(Date.UTC(year, 0, 1), tz);
  for (let t = Date.UTC(year, 0, 1); t < end; t += DAY) {
    const next = zoneOffsetMinutes(t + DAY, tz);
    if (next === prev) continue;
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2);
      if (zoneOffsetMinutes(mid, tz) === prev) lo = mid;
      else hi = mid;
    }
    const at = Math.ceil((lo + 1) / 60_000) * 60_000;
    const wall = new Date(at + prev * 60_000); // Wandzeit vor dem Wechsel
    const day = wall.getUTCDate();
    const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    rules.push({
      kind: next > prev ? 'daylight' : 'standard',
      from: prev,
      to: next,
      month: wall.getUTCMonth() + 1,
      weekday: wall.getUTCDay(),
      nth: day + 7 > daysInMonth ? -1 : Math.ceil(day / 7),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
    });
    prev = next;
  }
  const standard = rules.find((r) => r.kind === 'standard')?.to ?? prev;
  return { offset: standard, rules: rules.length === 2 ? rules : [] };
}

/** Datum des n-ten Wochentags eines Monats (n = −1: letzter) */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWd = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((lastWd - weekday + 7) % 7);
}
