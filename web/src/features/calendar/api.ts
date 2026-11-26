/** Datenzugriff für den Kalender (React Query). Alle Keys beginnen mit 'calendar'. */
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import type { CalendarEvent, CalendarInfo, EventInput, EventResponse } from '@kuvert/shared';
import { api } from '@/lib/api';

export interface AccountError {
  accountId: string;
  account: string;
  message: string;
}

export interface CalendarRef {
  accountId: string;
  calendarId: string;
}

/** Eindeutiger Schlüssel eines Kalenders über alle Konten */
export const calKey = (c: CalendarRef) => `${c.accountId}|${c.calendarId}`;
export const calKeyOf = (c: CalendarInfo) => calKey({ accountId: c.accountId, calendarId: c.id });

export function useCalendars() {
  return useQuery({
    queryKey: ['calendar', 'calendars'],
    queryFn: () => api<{ calendars: CalendarInfo[]; errors: AccountError[] }>('/calendar/calendars'),
    staleTime: 5 * 60_000,
  });
}

/** Termine eines Zeitraums direkt abrufen (ohne Cache) */
export function fetchEvents(range: { start: string; end: string }, calendars: CalendarRef[]) {
  return api<{ events: CalendarEvent[]; errors: AccountError[] }>('/calendar/events/query', {
    method: 'POST',
    body: { start: range.start, end: range.end, calendars },
  });
}

export function useEvents(range: { start: string; end: string } | null, calendars: CalendarRef[]) {
  const sel = calendars.map(calKey).sort().join(',');
  return useQuery({
    queryKey: ['calendar', 'events', range?.start, range?.end, sel],
    queryFn: () =>
      api<{ events: CalendarEvent[]; errors: AccountError[] }>('/calendar/events/query', {
        method: 'POST',
        body: { start: range!.start, end: range!.end, calendars },
      }),
    enabled: !!range && calendars.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Einzelnen Termin laden – mit der Serien-ID den Serienmaster (Beginn = erster Termin der Serie) */
export function getEvent(accountId: string, calendarId: string, eventId: string) {
  return api<CalendarEvent>(`/calendar/accounts/${encodeURIComponent(accountId)}/events/item`, {
    query: { calendarId, eventId },
  });
}

export function createEvent(accountId: string, calendarId: string, event: EventInput) {
  return api<CalendarEvent>(`/calendar/accounts/${encodeURIComponent(accountId)}/events`, {
    method: 'POST',
    body: { calendarId, event },
  });
}

export function updateEvent(accountId: string, calendarId: string, eventId: string, event: Partial<EventInput>) {
  return api<CalendarEvent>(`/calendar/accounts/${encodeURIComponent(accountId)}/events`, {
    method: 'PATCH',
    body: { calendarId, eventId, event },
  });
}

export function deleteEvent(accountId: string, calendarId: string, eventId: string) {
  return api(`/calendar/accounts/${encodeURIComponent(accountId)}/events`, {
    method: 'DELETE',
    query: { calendarId, eventId },
  });
}

export function respondToEvent(accountId: string, calendarId: string, eventId: string, response: EventResponse, comment?: string) {
  return api(`/calendar/accounts/${encodeURIComponent(accountId)}/events/respond`, {
    method: 'POST',
    body: { calendarId, eventId, response, comment },
  });
}

export function invalidateEvents(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: ['calendar', 'events'] });
}
