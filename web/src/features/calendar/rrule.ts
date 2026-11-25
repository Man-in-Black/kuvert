/**
 * Wiederholungs-Vorlagen ↔ RRULE (RFC 5545, ohne "RRULE:"-Präfix).
 * Unbekannte Regeln bleiben als "custom" unverändert erhalten.
 */
export type RecurrencePreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type RecurrenceEnd = 'never' | 'count' | 'until';

export interface RecurrenceState {
  preset: RecurrencePreset;
  end: RecurrenceEnd;
  count: number;
  /** YYYY-MM-DD */
  until: string;
  /** Originalregel (für "custom") */
  raw?: string;
}

export const PRESET_LABELS: Record<RecurrencePreset, string> = {
  none: 'Keine Wiederholung',
  daily: 'Täglich',
  weekdays: 'Jeden Werktag (Mo–Fr)',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
  yearly: 'Jährlich',
  custom: 'Benutzerdefiniert',
};

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export const EMPTY_RECURRENCE: RecurrenceState = { preset: 'none', end: 'never', count: 10, until: '' };

function parts(rule: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of rule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = p.split('=');
    if (k && v !== undefined) m.set(k.toUpperCase(), v.toUpperCase());
  }
  return m;
}

function untilToDate(v: string): string {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export function parseRRule(rule: string | null | undefined): RecurrenceState {
  if (!rule) return { ...EMPTY_RECURRENCE };
  const p = parts(rule);
  const freq = p.get('FREQ');
  const byday = p.get('BYDAY');
  const interval = p.get('INTERVAL');
  const known = new Set(['FREQ', 'BYDAY', 'COUNT', 'UNTIL', 'INTERVAL', 'BYMONTHDAY', 'WKST', 'BYMONTH']);
  const hasUnknown = [...p.keys()].some((k) => !known.has(k)) || (interval !== undefined && interval !== '1');

  let preset: RecurrencePreset = 'custom';
  if (!hasUnknown) {
    if (freq === 'DAILY' && !byday) preset = 'daily';
    else if (freq === 'WEEKLY' && byday && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => byday.split(',').includes(d)) && byday.split(',').length === 5)
      preset = 'weekdays';
    else if (freq === 'WEEKLY' && (!byday || byday.split(',').length === 1)) preset = 'weekly';
    else if (freq === 'MONTHLY' && !byday) preset = 'monthly';
    else if (freq === 'YEARLY' && !byday) preset = 'yearly';
  }
  const count = p.get('COUNT');
  const until = p.get('UNTIL');
  return {
    preset,
    end: count ? 'count' : until ? 'until' : 'never',
    count: count ? Number(count) : 10,
    until: until ? untilToDate(until) : '',
    raw: preset === 'custom' ? rule.replace(/^RRULE:/i, '') : undefined,
  };
}

/** Baut die RRULE für eine Vorlage, bezogen auf den Starttermin. */
export function buildRRule(state: RecurrenceState, start: Date): string | null {
  if (state.preset === 'none') return null;
  if (state.preset === 'custom') return state.raw ?? null;
  const rule: string[] = [];
  switch (state.preset) {
    case 'daily':
      rule.push('FREQ=DAILY');
      break;
    case 'weekdays':
      rule.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
      break;
    case 'weekly':
      rule.push('FREQ=WEEKLY', `BYDAY=${DAY_CODES[start.getDay()]}`);
      break;
    case 'monthly':
      rule.push('FREQ=MONTHLY', `BYMONTHDAY=${start.getDate()}`);
      break;
    case 'yearly':
      rule.push('FREQ=YEARLY');
      break;
  }
  if (state.end === 'count' && state.count > 0) rule.push(`COUNT=${Math.floor(state.count)}`);
  if (state.end === 'until' && state.until) rule.push(`UNTIL=${state.until.replace(/-/g, '')}T235959Z`);
  return rule.join(';');
}

/** Kurze, lesbare Beschreibung einer Regel */
export function describeRRule(rule: string | null | undefined): string {
  if (!rule) return '';
  const s = parseRRule(rule);
  if (s.preset === 'custom') return `Wiederholung: ${s.raw}`;
  let text = PRESET_LABELS[s.preset];
  if (s.end === 'count') text += `, ${s.count}×`;
  if (s.end === 'until' && s.until) text += `, bis ${s.until.split('-').reverse().join('.')}`;
  return text;
}
