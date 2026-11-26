/**
 * Google Kalender (Calendar API v3) inkl. Google-Meet-Konferenzen.
 */
import crypto from 'node:crypto';
import type { Attendee, AttendeeStatus, CalendarEvent, CalendarInfo, EventInput, EventResponse } from '@kuvert/shared';
import { BadRequestError, HttpError } from '../../core/errors.js';
import { htmlToText } from '../../core/mime.js';
import type { CalendarProvider } from '../../core/providers.js';
import { gurl, type GoogleClient } from './client.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

interface GCalListEntry {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  primary?: boolean;
  defaultReminders?: { method: string; minutes: number }[];
}

interface GAttendee {
  email: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  comment?: string;
}

interface GEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  transparency?: 'opaque' | 'transparent';
  attendees?: GAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType: string; uri: string }[];
    conferenceSolution?: { name?: string; key?: { type?: string } };
  };
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
  etag?: string;
}

const STATUS_MAP: Record<NonNullable<GAttendee['responseStatus']>, AttendeeStatus> = {
  needsAction: 'needsAction',
  declined: 'declined',
  tentative: 'tentative',
  accepted: 'accepted',
};

function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Instanz, deren Zeit vom Serienmuster abweicht (Google liefert keinen eigenen Typ) */
function isMovedInstance(e: GEvent): boolean {
  if (!e.recurringEventId || !e.originalStartTime) return false;
  const orig = e.originalStartTime.date ?? e.originalStartTime.dateTime;
  const cur = e.start?.date ?? e.start?.dateTime;
  if (!orig || !cur) return false;
  if (e.originalStartTime.date || e.start?.date) return orig.slice(0, 10) !== cur.slice(0, 10) || !!e.originalStartTime.date !== !!e.start?.date;
  return new Date(orig).getTime() !== new Date(cur).getTime();
}

const looksLikeHtml = (s: string) => /<\/?[a-z][\s\S]*>/i.test(s);

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(private g: GoogleClient) {}

  private calUrl(calendarId: string, suffix = '') {
    return `${BASE}/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const items = await this.g.paged<GCalListEntry, { items?: GCalListEntry[]; nextPageToken?: string }>(
      (pageToken) => gurl(`${BASE}/users/me/calendarList`, { pageToken, maxResults: 250 }),
      (r) => r.items,
    );
    return items
      .filter((c) => c.accessRole !== 'freeBusyReader')
      .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
      .map((c) => {
        const readOnly = c.accessRole !== 'owner' && c.accessRole !== 'writer';
        return {
          id: c.id,
          accountId: this.g.accountId,
          name: c.summaryOverride || c.summary,
          color: c.backgroundColor,
          readOnly,
          isDefault: !!c.primary,
          canOnlineMeeting: !readOnly,
          onlineMeetingProvider: 'meet',
        };
      });
  }

  private toEvent(e: GEvent, calendarId: string, defaultReminder?: number): CalendarEvent {
    const allDay = !!e.start?.date;
    const self = e.attendees?.find((a) => a.self);
    const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
    const rawDesc = e.description ?? '';
    const html = looksLikeHtml(rawDesc);
    const override = e.reminders?.overrides?.find((r) => r.method === 'popup') ?? e.reminders?.overrides?.[0];
    const rrule = e.recurrence?.find((r) => r.startsWith('RRULE:'));
    return {
      id: e.id,
      accountId: this.g.accountId,
      calendarId,
      title: e.summary ?? '(Ohne Titel)',
      description: html ? htmlToText(rawDesc) : rawDesc || undefined,
      descriptionHtml: html ? rawDesc : undefined,
      location: e.location,
      start: allDay ? e.start!.date! : new Date(e.start?.dateTime ?? Date.now()).toISOString(),
      end: allDay ? (e.end?.date ?? addDays(e.start!.date!, 1)) : new Date(e.end?.dateTime ?? e.start?.dateTime ?? Date.now()).toISOString(),
      allDay,
      timeZone: e.start?.timeZone,
      recurrence: rrule ? rrule.slice('RRULE:'.length) : null,
      recurringEventId: e.recurringEventId,
      isException: isMovedInstance(e) || undefined,
      originalStart: e.originalStartTime
        ? (e.originalStartTime.date ?? (e.originalStartTime.dateTime ? new Date(e.originalStartTime.dateTime).toISOString() : undefined))
        : undefined,
      attendees: e.attendees?.map<Attendee>((a) => ({
        name: a.displayName,
        address: a.email,
        status: a.responseStatus ? STATUS_MAP[a.responseStatus] : 'none',
        type: a.resource ? 'resource' : a.optional ? 'optional' : 'required',
      })),
      organizer: e.organizer?.email ? { name: e.organizer.displayName, address: e.organizer.email } : undefined,
      onlineMeetingUrl: e.hangoutLink ?? video,
      onlineMeetingProvider: e.hangoutLink || video ? (e.conferenceData?.conferenceSolution?.name ?? 'Google Meet') : undefined,
      status: e.status,
      showAs: e.transparency === 'transparent' ? 'free' : 'busy',
      reminderMinutes: override ? override.minutes : e.reminders?.useDefault ? (defaultReminder ?? null) : null,
      myResponse: self?.responseStatus ? STATUS_MAP[self.responseStatus] : undefined,
      isOrganizer: e.organizer?.self ?? !e.attendees?.length,
      webLink: e.htmlLink,
      etag: e.etag,
    };
  }

  async listEvents(calendarId: string, range: { start: string; end: string }): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await this.g.json<{
        items?: GEvent[];
        nextPageToken?: string;
        defaultReminders?: { method: string; minutes: number }[];
      }>(
        gurl(this.calUrl(calendarId), {
          singleEvents: true,
          orderBy: 'startTime',
          timeMin: new Date(range.start).toISOString(),
          timeMax: new Date(range.end).toISOString(),
          maxResults: 2500,
          pageToken,
        }),
      );
      const def = res.defaultReminders?.find((r) => r.method === 'popup')?.minutes ?? res.defaultReminders?.[0]?.minutes;
      for (const e of res.items ?? []) if (e.status !== 'cancelled') out.push(this.toEvent(e, calendarId, def));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** EventInput → Google-Event (nur gesetzte Felder) */
  private toBody(input: Partial<EventInput>, existing?: GEvent): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.summary = input.title;
    if (input.descriptionHtml !== undefined || input.description !== undefined) body.description = input.descriptionHtml ?? input.description;
    if (input.location !== undefined) body.location = input.location;
    const allDay = input.allDay ?? (existing ? !!existing.start?.date : false);
    if (input.start !== undefined || input.end !== undefined || input.allDay !== undefined) {
      const start = input.start ?? existing?.start?.dateTime ?? existing?.start?.date;
      let end = input.end ?? existing?.end?.dateTime ?? existing?.end?.date;
      if (!start) throw new BadRequestError('Startzeit fehlt');
      if (allDay) {
        const s = start.slice(0, 10);
        let e = (end ?? s).slice(0, 10);
        if (e <= s) e = addDays(s, 1);
        body.start = { date: s };
        body.end = { date: e };
      } else {
        end ??= new Date(new Date(start).getTime() + 3600_000).toISOString();
        body.start = { dateTime: new Date(start).toISOString(), timeZone: input.timeZone };
        body.end = { dateTime: new Date(end).toISOString(), timeZone: input.timeZone };
      }
    }
    if (input.attendees !== undefined) {
      body.attendees = input.attendees.map((a) => {
        const prev = existing?.attendees?.find((x) => x.email.toLowerCase() === a.address.toLowerCase());
        return {
          ...(prev ?? {}),
          email: a.address,
          displayName: a.name ?? prev?.displayName,
          optional: a.type === 'optional',
          resource: a.type === 'resource' || undefined,
        };
      });
    }
    if (input.recurrence !== undefined) {
      body.recurrence = input.recurrence ? [`RRULE:${input.recurrence.replace(/^RRULE:/i, '')}`] : [];
    }
    if (input.reminderMinutes !== undefined) {
      body.reminders =
        input.reminderMinutes === null
          ? { useDefault: false, overrides: [] }
          : { useDefault: false, overrides: [{ method: 'popup', minutes: input.reminderMinutes }] };
    }
    if (input.showAs !== undefined) body.transparency = input.showAs === 'free' ? 'transparent' : 'opaque';
    if (input.onlineMeeting && !existing?.hangoutLink && !existing?.conferenceData) {
      body.conferenceData = {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      };
    }
    return body;
  }

  private async fetchEvent(calendarId: string, eventId: string): Promise<GEvent> {
    return this.g.json<GEvent>(this.calUrl(calendarId, `/${encodeURIComponent(eventId)}`));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    return this.toEvent(await this.fetchEvent(calendarId, eventId), calendarId);
  }

  async createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
    const created = await this.g.json<GEvent>(
      gurl(this.calUrl(calendarId), { conferenceDataVersion: 1, sendUpdates: input.attendees?.length ? 'all' : 'none' }),
      { method: 'POST', body: this.toBody(input) },
    );
    return this.toEvent(created, calendarId);
  }

  async updateEvent(calendarId: string, eventId: string, input: Partial<EventInput>): Promise<CalendarEvent> {
    const existing = await this.fetchEvent(calendarId, eventId);
    const updated = await this.g.json<GEvent>(
      gurl(this.calUrl(calendarId, `/${encodeURIComponent(eventId)}`), {
        conferenceDataVersion: 1,
        sendUpdates: (input.attendees ?? existing.attendees)?.length ? 'all' : 'none',
      }),
      { method: 'PATCH', body: this.toBody(input, existing) },
    );
    return this.toEvent(updated, calendarId);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.g.fetch(gurl(this.calUrl(calendarId, `/${encodeURIComponent(eventId)}`), { sendUpdates: 'all' }), { method: 'DELETE' });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 410 || err.status === 404)) return; // bereits gelöscht
      throw err;
    }
  }

  async respondToEvent(calendarId: string, eventId: string, response: EventResponse, comment?: string): Promise<void> {
    const ev = await this.fetchEvent(calendarId, eventId);
    const me = this.g.email.toLowerCase();
    const attendees = ev.attendees ?? [];
    const self = attendees.find((a) => a.self) ?? attendees.find((a) => a.email.toLowerCase() === me);
    if (!self) throw new BadRequestError('Sie sind kein Teilnehmer dieses Termins');
    self.responseStatus = response === 'accept' ? 'accepted' : response === 'decline' ? 'declined' : 'tentative';
    if (comment !== undefined) self.comment = comment;
    await this.g.json(gurl(this.calUrl(calendarId, `/${encodeURIComponent(eventId)}`), { sendUpdates: 'all' }), {
      method: 'PATCH',
      body: { attendees },
    });
  }
}
