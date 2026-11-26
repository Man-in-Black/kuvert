/**
 * Kalender-Provider für Microsoft Graph (inkl. Teams-Besprechungen und
 * Kalendern freigegebener Postfächer). Kalender-IDs: "me|<id>" bzw. "<shared>|<id>".
 */
import type { Attendee, AttendeeStatus, CalendarEvent, CalendarInfo, EventInput, EventResponse, ShowAs } from '@kuvert/shared';
import { AuthError, BadRequestError } from '../../core/errors.js';
import { htmlToPlainText } from '../../core/mime.js';
import type { AccountContext } from '../../core/module.js';
import type { CalendarProvider } from '../../core/providers.js';
import { addDays, decId, enc, encId, escapeHtml, fromGraphDateTime, localDate, mbPath, qs, toGraphZoned, type GraphClient } from './graph.js';
import { TeamsMeetingsProvider } from './meetings.js';
import { graphToRrule, rruleToGraph, type GraphRecurrence } from './recurrence.js';

interface GDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface GEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: 'html' | 'text'; content?: string };
  location?: { displayName?: string };
  start?: GDateTime;
  end?: GDateTime;
  isAllDay?: boolean;
  recurrence?: GraphRecurrence | null;
  seriesMasterId?: string | null;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  originalStart?: string | null;
  attendees?: { emailAddress?: { name?: string; address?: string }; status?: { response?: string }; type?: string }[];
  organizer?: { emailAddress?: { name?: string; address?: string } };
  onlineMeeting?: { joinUrl?: string } | null;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeetingUrl?: string | null;
  showAs?: string;
  isReminderOn?: boolean;
  reminderMinutesBeforeStart?: number;
  responseStatus?: { response?: string };
  isOrganizer?: boolean;
  webLink?: string;
  isCancelled?: boolean;
  changeKey?: string;
  originalStartTimeZone?: string;
}

interface GCalendar {
  id: string;
  name: string;
  color?: string;
  hexColor?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
  owner?: { name?: string; address?: string };
  allowedOnlineMeetingProviders?: string[];
  defaultOnlineMeetingProvider?: string;
}

const EVENT_SELECT = [
  'id',
  'subject',
  'bodyPreview',
  'body',
  'location',
  'start',
  'end',
  'isAllDay',
  'recurrence',
  'seriesMasterId',
  'type',
  'originalStart',
  'attendees',
  'organizer',
  'onlineMeeting',
  'isOnlineMeeting',
  'onlineMeetingProvider',
  'onlineMeetingUrl',
  'showAs',
  'isReminderOn',
  'reminderMinutesBeforeStart',
  'responseStatus',
  'isOrganizer',
  'webLink',
  'isCancelled',
  'changeKey',
  'originalStartTimeZone',
].join(',');

const UTC_PREFER = ['outlook.timezone="UTC"', 'outlook.body-content-type="html"'];

/** Outlook-Farbnamen → Hex */
const COLOR_MAP: Record<string, string> = {
  lightBlue: '#4f9fe0',
  lightGreen: '#5cb85c',
  lightOrange: '#f0a030',
  lightGray: '#9aa1ad',
  lightYellow: '#d9b72b',
  lightTeal: '#3fb6b2',
  lightPink: '#e573a8',
  lightBrown: '#a0785a',
  lightRed: '#e05555',
};

const RESPONSE_MAP: Record<string, AttendeeStatus> = {
  accepted: 'accepted',
  organizer: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  notResponded: 'needsAction',
  none: 'none',
};

const SHOW_AS: ShowAs[] = ['free', 'busy', 'tentative', 'oof', 'workingElsewhere'];

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Teams-Beitrittslink im Termintext (z. B. bei Einladungen anderer Organisationen oder per Fallback eingefügt) */
const TEAMS_LINK = /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"']+/i;
function teamsLinkFromBody(html?: string): string | undefined {
  return html?.match(TEAMS_LINK)?.[0].replace(/&amp;/g, '&');
}

/**
 * Vollständige Beschreibung als Klartext. `bodyPreview` ist bei Graph auf
 * 255 Zeichen gekürzt und dient nur als Rückfall, falls kein Body geladen wurde.
 */
function bodyText(e: GEvent): string | undefined {
  const content = e.body?.content;
  if (!content?.trim()) return e.bodyPreview || undefined;
  const text = e.body?.contentType === 'html' ? htmlToPlainText(content) : content.trim();
  return text || e.bodyPreview || undefined;
}

/** Beschreibung eines EventInput als HTML (Basis für den eingefügten Teams-Block) */
function descriptionAsHtml(input: Partial<EventInput>): string {
  if (input.descriptionHtml) return input.descriptionHtml;
  return input.description ? `<div>${escapeHtml(input.description).replace(/\r?\n/g, '<br>')}</div>` : '';
}

function appendHtml(html: string, block: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GraphCalendarProvider implements CalendarProvider {
  constructor(
    private graph: GraphClient,
    private ctx: AccountContext,
  ) {}

  private sharedMailboxes(): string[] {
    const list = this.ctx.account.settings.sharedMailboxes;
    return Array.isArray(list) ? [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter((s) => s.includes('@')))] : [];
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const mapCal = (mb: string, c: GCalendar, suffix = ''): CalendarInfo => ({
      id: encId(mb, c.id),
      accountId: this.ctx.account.id,
      name: `${c.name}${suffix}`,
      color: c.hexColor || (c.color ? COLOR_MAP[c.color] : undefined),
      readOnly: c.canEdit === false,
      isDefault: mb === 'me' && !!c.isDefaultCalendar,
      owner: c.owner?.address,
      canOnlineMeeting: mb === 'me' && c.canEdit !== false,
      onlineMeetingProvider: 'teams',
    });
    const select = '$select=id,name,color,hexColor,canEdit,isDefaultCalendar,owner';
    const mine = await this.graph.all<GCalendar>(`/me/calendars?$top=200&${select}`);
    const result = mine.map((c) => mapCal('me', c));
    const shared = await Promise.all(
      this.sharedMailboxes().map(async (mb) => {
        try {
          const cals = await this.graph.all<GCalendar>(`/users/${enc(mb)}/calendars?$top=50&${select}`);
          return cals.map((c) => mapCal(mb, c, ` (${mb})`));
        } catch (err) {
          this.ctx.log.debug({ err, mailbox: mb }, 'Kalender des freigegebenen Postfachs nicht verfügbar');
          return [];
        }
      }),
    );
    return [...result, ...shared.flat()];
  }

  private toEvent(e: GEvent, calendarId: string): CalendarEvent {
    const allDay = !!e.isAllDay;
    const start = allDay ? (e.start?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(e.start);
    const end = allDay ? (e.end?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(e.end);
    const attendees: Attendee[] = (e.attendees ?? [])
      .filter((a) => a.emailAddress?.address)
      .map((a) => ({
        name: a.emailAddress?.name || undefined,
        address: a.emailAddress!.address!,
        status: RESPONSE_MAP[a.status?.response ?? 'none'] ?? 'none',
        type: a.type === 'optional' ? 'optional' : a.type === 'resource' ? 'resource' : 'required',
      }));
    const showAs = SHOW_AS.includes(e.showAs as ShowAs) ? (e.showAs as ShowAs) : 'busy';
    const nativeUrl = e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || undefined;
    const bodyUrl = nativeUrl ? undefined : teamsLinkFromBody(e.body?.content);
    return {
      id: e.id,
      accountId: this.ctx.account.id,
      calendarId,
      title: e.subject ?? '',
      description: bodyText(e),
      descriptionHtml: e.body?.contentType === 'html' ? e.body.content : undefined,
      location: e.location?.displayName || undefined,
      start,
      end,
      allDay,
      timeZone: e.originalStartTimeZone,
      recurrence: graphToRrule(e.recurrence),
      recurringEventId: e.seriesMasterId ?? undefined,
      isException: e.type === 'exception' || undefined,
      originalStart: !allDay && e.originalStart ? new Date(e.originalStart).toISOString() : undefined,
      attendees,
      organizer: e.organizer?.emailAddress?.address
        ? { name: e.organizer.emailAddress.name || undefined, address: e.organizer.emailAddress.address }
        : undefined,
      onlineMeetingUrl: nativeUrl ?? bodyUrl,
      onlineMeetingProvider: e.isOnlineMeeting
        ? /teams/i.test(e.onlineMeetingProvider ?? '')
          ? 'teams'
          : e.onlineMeetingProvider
        : bodyUrl
          ? 'teams'
          : undefined,
      status: e.isCancelled ? 'cancelled' : showAs === 'tentative' ? 'tentative' : 'confirmed',
      showAs,
      reminderMinutes: e.isReminderOn ? (e.reminderMinutesBeforeStart ?? 15) : null,
      myResponse: RESPONSE_MAP[e.responseStatus?.response ?? 'none'] ?? 'none',
      isOrganizer: !!e.isOrganizer,
      webLink: e.webLink,
      etag: e.changeKey,
    };
  }

  async listEvents(calendarId: string, range: { start: string; end: string }): Promise<CalendarEvent[]> {
    const c = decId(calendarId);
    const url = `${mbPath(c.mb)}/calendars/${enc(c.id)}/calendarView${qs({
      startDateTime: new Date(range.start).toISOString(),
      endDateTime: new Date(range.end).toISOString(),
      $top: 250,
      $select: EVENT_SELECT,
    })}`;
    const events = await this.graph.all<GEvent>(url, { prefer: UTC_PREFER }, 5000);
    return events.map((e) => this.toEvent(e, calendarId));
  }

  /** EventInput → Graph-Event (nur gesetzte Felder) */
  private async toGraph(input: Partial<EventInput>, existing?: () => Promise<GEvent>): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    const tz = input.timeZone || 'UTC';
    const allDay = input.allDay ?? (input.start ? isDateOnly(input.start) : undefined);

    if (input.title !== undefined) body.subject = input.title;
    if (input.descriptionHtml !== undefined || input.description !== undefined) {
      body.body = input.descriptionHtml
        ? { contentType: 'HTML', content: input.descriptionHtml }
        : { contentType: 'Text', content: input.description ?? '' };
    }
    if (input.location !== undefined) body.location = { displayName: input.location };
    if (allDay !== undefined) body.isAllDay = allDay;

    const dt = (value: string, allDayFlag: boolean | undefined) =>
      allDayFlag ? { dateTime: `${value.slice(0, 10)}T00:00:00`, timeZone: tz } : toGraphZoned(value, input.timeZone);
    if (input.start !== undefined) body.start = dt(input.start, allDay);
    if (input.end !== undefined) {
      let end = input.end;
      if (allDay && input.start && end.slice(0, 10) <= input.start.slice(0, 10)) end = addDays(input.start, 1);
      body.end = dt(end, allDay);
    }

    if (input.attendees !== undefined) {
      body.attendees = input.attendees.map((a) => ({
        emailAddress: { address: a.address, name: a.name || undefined },
        type: a.type ?? 'required',
      }));
    }
    if (input.reminderMinutes !== undefined) {
      body.isReminderOn = input.reminderMinutes !== null;
      if (input.reminderMinutes !== null) body.reminderMinutesBeforeStart = input.reminderMinutes;
    }
    if (input.showAs !== undefined) body.showAs = input.showAs;
    // onlineMeeting wird in create/updateEvent behandelt (requestTeams)
    if (input.recurrence !== undefined) {
      if (!input.recurrence) {
        body.recurrence = null;
      } else {
        let startIso = input.start;
        let recurrenceTz = tz;
        if (!startIso && existing) {
          const cur = await existing();
          startIso = cur.isAllDay ? cur.start?.dateTime?.slice(0, 10) : fromGraphDateTime(cur.start);
          recurrenceTz = cur.originalStartTimeZone || tz;
        }
        const startDate = localDate(startIso ?? new Date().toISOString(), allDay ? undefined : input.timeZone || recurrenceTz);
        body.recurrence = rruleToGraph(input.recurrence, startDate, recurrenceTz, input.timeZone);
      }
    }
    return body;
  }

  /* ───────────── Teams-Besprechungen ───────────── */

  /**
   * Teams-Anbieter, den Exchange für diesen Kalender erlaubt. Ist Teams dort nicht
   * freigegeben, ignoriert Graph `isOnlineMeeting` stillschweigend – dann null.
   */
  private async teamsProviderFor(c: { mb: string; id: string }): Promise<string | null> {
    try {
      const cal = await this.graph.json<GCalendar>(
        `${mbPath(c.mb)}/calendars/${enc(c.id)}?$select=allowedOnlineMeetingProviders,defaultOnlineMeetingProvider`,
      );
      const allowed = cal.allowedOnlineMeetingProviders;
      if (!Array.isArray(allowed)) return 'teamsForBusiness';
      if (allowed.includes('teamsForBusiness')) return 'teamsForBusiness';
      return allowed.find((p) => /teams/i.test(p)) ?? null;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      this.ctx.log.debug({ err }, 'Besprechungsanbieter des Kalenders nicht ermittelbar');
      return 'teamsForBusiness';
    }
  }

  /**
   * Fallback: Teams-Besprechung über /me/onlineMeetings anlegen und den
   * Beitritts-Block in den Termintext einfügen (wie es Outlook auch tut).
   */
  private async embedStandaloneTeams(
    body: Record<string, unknown>,
    ev: { subject: string; start: string; end: string; html: string; location?: string },
  ): Promise<void> {
    const meeting = await new TeamsMeetingsProvider(this.graph)
      .createMeeting({ subject: ev.subject || 'Besprechung', start: ev.start, end: ev.end })
      .catch((err: unknown): never => {
        if (err instanceof AuthError) throw err;
        throw new BadRequestError(
          `Teams-Besprechung konnte nicht erstellt werden: ${err instanceof Error ? err.message : String(err)}. ` +
            'Für dieses Postfach ist Teams in Exchange nicht als Besprechungsanbieter freigegeben, und das separate Anlegen ist ebenfalls fehlgeschlagen.',
        );
      });
    const block = meeting.html ?? `<p><a href="${escapeHtml(meeting.joinUrl)}">An Microsoft Teams-Besprechung teilnehmen</a></p>`;
    body.body = { contentType: 'HTML', content: appendHtml(ev.html, block) };
    if (!ev.location?.trim()) body.location = { displayName: 'Microsoft Teams-Besprechung' };
  }

  /**
   * Teams für einen Termin anfordern: bevorzugt nativ (Exchange erzeugt die
   * Besprechung), sonst per Fallback. Rückgabe: true = nativ angefordert.
   */
  private async requestTeams(
    body: Record<string, unknown>,
    c: { mb: string; id: string },
    ev: { subject: string; start: string; end: string; html: string; location?: string },
  ): Promise<boolean> {
    const provider = await this.teamsProviderFor(c);
    if (provider) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = provider;
      return true;
    }
    this.ctx.log.info({ calendar: c.id }, 'Teams ist für diesen Kalender nicht freigegeben – lege Besprechung separat an');
    await this.embedStandaloneTeams(body, ev);
    return false;
  }

  /**
   * Nach nativem Anfordern prüfen, ob Exchange wirklich eine Teams-Besprechung
   * angelegt hat. Falls nicht (Anforderung stillschweigend ignoriert), Fallback.
   */
  private async ensureTeams(path: string, ev: GEvent): Promise<GEvent> {
    if (ev.onlineMeeting?.joinUrl) return ev;
    const load = () => this.graph.json<GEvent>(`${path}?$select=${EVENT_SELECT}`, { prefer: UTC_PREFER });
    let full = await load();
    if (full.onlineMeeting?.joinUrl || teamsLinkFromBody(full.body?.content)) return full;
    if (full.isOnlineMeeting) {
      // Exchange legt den Link mitunter mit kurzer Verzögerung an
      await sleep(1500);
      full = await load();
      return full;
    }
    this.ctx.log.warn(
      { requested: true, isOnlineMeeting: full.isOnlineMeeting, provider: full.onlineMeetingProvider },
      'Exchange hat keine Teams-Besprechung angelegt – Fallback über /me/onlineMeetings',
    );
    const patch: Record<string, unknown> = {};
    await this.embedStandaloneTeams(patch, {
      subject: full.subject ?? '',
      start: full.isAllDay ? (full.start?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(full.start),
      end: full.isAllDay ? (full.end?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(full.end),
      html: full.body?.content ?? '',
      location: full.location?.displayName,
    });
    await this.graph.json<GEvent>(path, { method: 'PATCH', body: patch, prefer: UTC_PREFER });
    return load();
  }

  async createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
    const c = decId(calendarId);
    const body = await this.toGraph(input);
    const native = input.onlineMeeting
      ? await this.requestTeams(body, c, { subject: input.title, start: input.start, end: input.end, html: descriptionAsHtml(input), location: input.location })
      : false;
    const ev = await this.graph.json<GEvent>(`${mbPath(c.mb)}/calendars/${enc(c.id)}/events`, { method: 'POST', body, prefer: UTC_PREFER });
    if (native) return this.toEvent(await this.ensureTeams(`${mbPath(c.mb)}/events/${enc(ev.id)}`, ev), calendarId);
    return this.toEvent(ev, calendarId);
  }

  async updateEvent(calendarId: string, eventId: string, input: Partial<EventInput>): Promise<CalendarEvent> {
    const c = decId(calendarId);
    const path = `${mbPath(c.mb)}/events/${enc(eventId)}`;
    const body = await this.toGraph(input, () => this.graph.json<GEvent>(`${path}?$select=start,isAllDay,originalStartTimeZone`, { prefer: UTC_PREFER }));
    let native = false;
    if (input.onlineMeeting) {
      const cur = await this.graph.json<GEvent>(`${path}?$select=subject,body,start,end,isAllDay,location,isOnlineMeeting,onlineMeeting,isOrganizer`, {
        prefer: UTC_PREFER,
      });
      const hasMeeting = !!(cur.onlineMeeting?.joinUrl || cur.isOnlineMeeting || teamsLinkFromBody(cur.body?.content));
      if (!hasMeeting) {
        if (cur.isOrganizer === false) throw new BadRequestError('Nur der Organisator kann diesem Termin eine Teams-Besprechung hinzufügen');
        const descChanged = input.descriptionHtml !== undefined || input.description !== undefined;
        native = await this.requestTeams(body, c, {
          subject: input.title ?? cur.subject ?? '',
          start: input.start ?? (cur.isAllDay ? (cur.start?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(cur.start)),
          end: input.end ?? (cur.isAllDay ? (cur.end?.dateTime ?? '').slice(0, 10) : fromGraphDateTime(cur.end)),
          html: descChanged ? descriptionAsHtml(input) : (cur.body?.content ?? ''),
          location: input.location ?? cur.location?.displayName,
        });
      }
    }
    if (Object.keys(body).length === 0) {
      return this.toEvent(await this.graph.json<GEvent>(`${path}?$select=${EVENT_SELECT}`, { prefer: UTC_PREFER }), calendarId);
    }
    const ev = await this.graph.json<GEvent>(path, { method: 'PATCH', body, prefer: UTC_PREFER });
    if (native) return this.toEvent(await this.ensureTeams(path, ev), calendarId);
    return this.toEvent(ev, calendarId);
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const c = decId(calendarId);
    const ev = await this.graph.json<GEvent>(`${mbPath(c.mb)}/events/${enc(eventId)}?$select=${EVENT_SELECT}`, { prefer: UTC_PREFER });
    return this.toEvent(ev, calendarId);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const c = decId(calendarId);
    await this.graph.raw(`${mbPath(c.mb)}/events/${enc(eventId)}`, { method: 'DELETE' });
  }

  async respondToEvent(calendarId: string, eventId: string, response: EventResponse, comment?: string): Promise<void> {
    const c = decId(calendarId);
    const action = { accept: 'accept', tentative: 'tentativelyAccept', decline: 'decline' }[response];
    await this.graph.raw(`${mbPath(c.mb)}/events/${enc(eventId)}/${action}`, {
      method: 'POST',
      body: { comment: comment ?? '', sendResponse: true },
    });
  }
}
