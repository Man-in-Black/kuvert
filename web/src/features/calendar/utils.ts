import { addDays, differenceInCalendarDays, format, isSameDay } from 'date-fns';
import { de } from 'date-fns/locale';
import type { AccountInfo, CalendarEvent, CalendarInfo } from '@kuvert/shared';

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parst ISO-Zeitpunkt oder reines Datum (lokal, 00:00) */
export function parseEventDate(s: string): Date {
  if (DATE_ONLY.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }
  return new Date(s);
}

export function toDateInput(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function toTimeInput(d: Date): string {
  return format(d, 'HH:mm');
}

export function eventColor(ev: CalendarEvent, cal?: CalendarInfo, acc?: AccountInfo): string {
  return cal?.color || ev.color || acc?.color || '#2563eb';
}

/** Lesbare Zeitangabe, z. B. "Mo., 23. Nov. 2026 · 10:00–11:00" */
export function formatEventRange(ev: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): string {
  const start = parseEventDate(ev.start);
  const end = parseEventDate(ev.end);
  const day = (d: Date) => format(d, 'EEE, d. MMM yyyy', { locale: de });
  if (ev.allDay) {
    const lastDay = addDays(end, -1);
    if (differenceInCalendarDays(lastDay, start) <= 0) return `${day(start)} · ganztägig`;
    return `${day(start)} – ${day(lastDay)} · ganztägig`;
  }
  if (isSameDay(start, end)) return `${day(start)} · ${format(start, 'HH:mm')}–${format(end, 'HH:mm')}`;
  return `${day(start)} ${format(start, 'HH:mm')} – ${day(end)} ${format(end, 'HH:mm')}`;
}

/** HTML → reiner Text (ohne Skriptausführung) */
export function htmlToPlain(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n'), 'text/html');
    return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return html;
  }
}

export function eventDescription(ev: CalendarEvent): string {
  if (ev.description) return ev.description;
  if (ev.descriptionHtml) return htmlToPlain(ev.descriptionHtml);
  return '';
}

export const SHOW_AS_LABELS: Record<NonNullable<CalendarEvent['showAs']>, string> = {
  busy: 'Beschäftigt',
  free: 'Frei',
  tentative: 'Mit Vorbehalt',
  oof: 'Abwesend',
  workingElsewhere: 'An anderem Ort tätig',
};

export const REMINDER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Keine Erinnerung' },
  { value: '0', label: 'Zum Beginn' },
  { value: '5', label: '5 Minuten vorher' },
  { value: '10', label: '10 Minuten vorher' },
  { value: '15', label: '15 Minuten vorher' },
  { value: '30', label: '30 Minuten vorher' },
  { value: '60', label: '1 Stunde vorher' },
  { value: '1440', label: '1 Tag vorher' },
];

export function meetingLabel(provider?: string): string {
  if (provider === 'teams') return 'Teams-Besprechung';
  if (provider === 'meet') return 'Google Meet';
  if (provider === 'kuvert') return 'Kuvert-Anruf';
  return 'Online-Meeting';
}

/** Link zu einem Kuvert-Anruf dieses Servers (/join/…) */
const JOIN_LINK = /https?:\/\/[^\s<>"')\]]+\/join\/[\w-]{16,64}/g;

/** Pfad im eigenen Kuvert (z. B. /join/abc…), wenn der Link auf diesen Server zeigt – sonst null */
export function kuvertJoinPath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === window.location.origin && /^\/join\/[\w-]{16,64}\/?$/.test(u.pathname) ? u.pathname : null;
  } catch {
    return null;
  }
}

/** Kuvert-Anruf-Link aus Ort oder Beschreibung eines Termins */
export function kuvertMeetingUrl(ev: Pick<CalendarEvent, 'location' | 'description'>): string | null {
  for (const text of [ev.location, ev.description]) {
    for (const m of text?.match(JOIN_LINK) ?? []) if (kuvertJoinPath(m)) return m;
  }
  return null;
}

/** Online-Besprechung eines Termins: vom Anbieter (Teams, Meet …) oder ein Kuvert-Anruf */
export function eventMeeting(ev: CalendarEvent): { url: string; provider?: string } | null {
  if (ev.onlineMeetingUrl) return { url: ev.onlineMeetingUrl, provider: ev.onlineMeetingProvider };
  const url = kuvertMeetingUrl(ev);
  return url ? { url, provider: 'kuvert' } : null;
}
