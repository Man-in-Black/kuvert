/**
 * Abbildung RRULE (RFC 5545) ↔ Microsoft Graph patternedRecurrence.
 * Unterstützt: DAILY/WEEKLY/MONTHLY/YEARLY mit INTERVAL, BYDAY, BYMONTHDAY,
 * BYMONTH, BYSETPOS, COUNT, UNTIL, WKST.
 */

export interface GraphRecurrencePattern {
  type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly';
  interval: number;
  month?: number;
  dayOfMonth?: number;
  daysOfWeek?: string[];
  firstDayOfWeek?: string;
  index?: 'first' | 'second' | 'third' | 'fourth' | 'last';
}

export interface GraphRecurrenceRange {
  type: 'endDate' | 'noEnd' | 'numbered';
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
  recurrenceTimeZone?: string;
}

export interface GraphRecurrence {
  pattern: GraphRecurrencePattern;
  range: GraphRecurrenceRange;
}

const DAY_TO_GRAPH: Record<string, string> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday',
};
const GRAPH_TO_DAY: Record<string, string> = Object.fromEntries(Object.entries(DAY_TO_GRAPH).map(([k, v]) => [v, k]));
const WEEKDAY_BY_INDEX = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const INDEX_TO_GRAPH: Record<number, GraphRecurrencePattern['index']> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' };
const GRAPH_TO_INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

function parseRule(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim().toUpperCase()] = v.trim();
  }
  return out;
}

/** Kalenderdatum eines Zeitpunkts in einer IANA-Zone (YYYY-MM-DD) oder undefined */
function localDateIn(d: Date, tz: string | undefined): string | undefined {
  if (!tz || Number.isNaN(d.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return undefined;
  }
}

/**
 * RRULE → Graph-Recurrence. startDate = erstes Datum (YYYY-MM-DD) in der Zeitzone des Termins.
 * localTz (IANA, z. B. vom Browser): ein genauer UNTIL-Zeitpunkt (z. B. beim Teilen einer
 * Serie) wird in dieses Kalenderdatum umgerechnet – Graph kennt als Serienende nur ein Datum.
 */
export function rruleToGraph(rrule: string, startDate: string, timeZone = 'UTC', localTz?: string): GraphRecurrence {
  const r = parseRule(rrule);
  const start = new Date(`${startDate}T00:00:00Z`);
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  const startWeekday = WEEKDAY_BY_INDEX[start.getUTCDay()]!;
  const startDay = start.getUTCDate();
  const startMonth = start.getUTCMonth() + 1;

  const byday = (r.BYDAY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i);
      return m ? { n: m[1] ? Number(m[1]) : undefined, day: DAY_TO_GRAPH[m[2]!.toUpperCase()]! } : undefined;
    })
    .filter((x): x is { n: number | undefined; day: string } => !!x);
  const setpos = r.BYSETPOS ? Number(r.BYSETPOS.split(',')[0]) : undefined;
  const ordinal = byday.find((b) => b.n !== undefined)?.n ?? setpos;
  const index = ordinal !== undefined ? (INDEX_TO_GRAPH[ordinal] ?? (ordinal < 0 ? 'last' : 'fourth')) : undefined;
  const monthDay = r.BYMONTHDAY ? Number(r.BYMONTHDAY.split(',')[0]) : undefined;
  const month = r.BYMONTH ? Number(r.BYMONTH.split(',')[0]) : startMonth;

  let pattern: GraphRecurrencePattern;
  switch ((r.FREQ ?? 'DAILY').toUpperCase()) {
    case 'WEEKLY':
      pattern = {
        type: 'weekly',
        interval,
        daysOfWeek: byday.length ? byday.map((b) => b.day) : [startWeekday],
        firstDayOfWeek: r.WKST ? (DAY_TO_GRAPH[r.WKST.toUpperCase()] ?? 'monday') : 'monday',
      };
      break;
    case 'MONTHLY':
      pattern =
        byday.length && index
          ? { type: 'relativeMonthly', interval, daysOfWeek: byday.map((b) => b.day), index }
          : { type: 'absoluteMonthly', interval, dayOfMonth: monthDay && monthDay > 0 ? monthDay : startDay };
      break;
    case 'YEARLY':
      pattern =
        byday.length && index
          ? { type: 'relativeYearly', interval, daysOfWeek: byday.map((b) => b.day), index, month }
          : { type: 'absoluteYearly', interval, dayOfMonth: monthDay && monthDay > 0 ? monthDay : startDay, month };
      break;
    case 'DAILY':
    default:
      pattern = { type: 'daily', interval };
  }

  let range: GraphRecurrenceRange;
  if (r.COUNT) {
    range = { type: 'numbered', startDate, numberOfOccurrences: Math.max(1, Number(r.COUNT)), recurrenceTimeZone: timeZone };
  } else if (r.UNTIL) {
    const u = r.UNTIL.replace(/[^0-9]/g, '');
    const m = r.UNTIL.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
    // „…T235959Z“ ist die übliche Datums-Schreibweise (siehe graphToRrule) – nur echte Zeitpunkte umrechnen
    const utc = m && !/T235959Z$/i.test(r.UNTIL) ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : undefined;
    const endDate = (utc && localDateIn(utc, localTz)) ?? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    range = { type: 'endDate', startDate, endDate, recurrenceTimeZone: timeZone };
  } else {
    range = { type: 'noEnd', startDate, recurrenceTimeZone: timeZone };
  }
  return { pattern, range };
}

/** Graph-Recurrence → RRULE (ohne "RRULE:"-Präfix) */
export function graphToRrule(rec: GraphRecurrence | null | undefined): string | null {
  if (!rec?.pattern) return null;
  const p = rec.pattern;
  const parts: string[] = [];
  const days = (p.daysOfWeek ?? []).map((d) => GRAPH_TO_DAY[d.toLowerCase()]).filter(Boolean) as string[];
  const n = p.index ? GRAPH_TO_INDEX[p.index] : undefined;
  const interval = p.interval && p.interval > 1 ? `;INTERVAL=${p.interval}` : '';

  switch (p.type) {
    case 'daily':
      parts.push(`FREQ=DAILY${interval}`);
      break;
    case 'weekly':
      parts.push(`FREQ=WEEKLY${interval}`);
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (p.firstDayOfWeek && GRAPH_TO_DAY[p.firstDayOfWeek]) parts.push(`WKST=${GRAPH_TO_DAY[p.firstDayOfWeek]}`);
      break;
    case 'absoluteMonthly':
      parts.push(`FREQ=MONTHLY${interval}`);
      if (p.dayOfMonth) parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeMonthly':
      parts.push(`FREQ=MONTHLY${interval}`);
      if (days.length === 1 && n !== undefined) parts.push(`BYDAY=${n}${days[0]}`);
      else if (days.length) parts.push(`BYDAY=${days.join(',')}`, ...(n !== undefined ? [`BYSETPOS=${n}`] : []));
      break;
    case 'absoluteYearly':
      parts.push(`FREQ=YEARLY${interval}`);
      if (p.month) parts.push(`BYMONTH=${p.month}`);
      if (p.dayOfMonth) parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeYearly':
      parts.push(`FREQ=YEARLY${interval}`);
      if (p.month) parts.push(`BYMONTH=${p.month}`);
      if (days.length === 1 && n !== undefined) parts.push(`BYDAY=${n}${days[0]}`);
      else if (days.length) parts.push(`BYDAY=${days.join(',')}`, ...(n !== undefined ? [`BYSETPOS=${n}`] : []));
      break;
    default:
      return null;
  }

  const range = rec.range;
  if (range?.type === 'numbered' && range.numberOfOccurrences) parts.push(`COUNT=${range.numberOfOccurrences}`);
  else if (range?.type === 'endDate' && range.endDate) parts.push(`UNTIL=${range.endDate.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}
