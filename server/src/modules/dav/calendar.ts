/**
 * CalDAV: Kalender (VEVENT) und Aufgaben (VTODO).
 *
 * IDs: Kalender/Aufgabenliste = Collection-URL, Termin/Aufgabe = Objekt-URL.
 * Serien-Instanzen: "<objekt-url>#<recurrence-id ISO>" – Änderungen an einer Instanz
 * erzeugen eine Ausnahme (RECURRENCE-ID), Löschen einer Instanz setzt ein EXDATE.
 */
import type { DAVCalendar, DAVClient } from 'tsdav';
import type { CalendarEvent, CalendarInfo, EventInput, EventResponse, Task, TaskInput, TaskList } from '@kuvert/shared';
import { AuthError, NotFoundError } from '../../core/errors.js';
import type { AccountContext } from '../../core/module.js';
import type { CalendarProvider, TasksProvider } from '../../core/providers.js';
import {
  buildNewEvent,
  buildNewTodo,
  excludeOccurrence,
  parseEvents,
  parseMasterEvent,
  parseTodos,
  setPartstat,
  updateEventIcs,
  updateTodoIcs,
} from './ical.js';
import { DavSession, ensureOk, mapDavError } from './session.js';

const CAL_TTL = 5 * 60_000;
const objectFilter = (u: string) => !!u && !u.endsWith('/');

const VTODO_FILTER = [
  {
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': { _attributes: { name: 'VTODO' } },
    },
  },
];

function colorOf(c: DAVCalendar): string | undefined {
  const raw = c.calendarColor as unknown;
  const s = typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as { _text?: string })._text ?? '') : '';
  const m = s.trim().match(/^#([0-9a-fA-F]{6})/);
  return m ? `#${m[1]}` : undefined;
}

function nameOf(c: DAVCalendar, fallback: string): string {
  return typeof c.displayName === 'string' && c.displayName.trim() ? c.displayName : fallback;
}

const supports = (c: DAVCalendar, comp: 'VEVENT' | 'VTODO') => !c.components?.length || c.components.includes(comp);

function safeFilename(uid: string): string {
  return `${uid.replace(/[^A-Za-z0-9._-]/g, '_')}.ics`;
}

function collectionUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export class DavCalendarProvider implements CalendarProvider, TasksProvider {
  private calCache: { at: number; list: DAVCalendar[] } | null = null;

  constructor(
    private ctx: AccountContext,
    private session: DavSession,
    private ownEmails: () => string[],
  ) {}

  private get accountId() {
    return this.ctx.account.id;
  }

  /** Führt einen DAV-Aufruf aus und vereinheitlicht Fehler. */
  private async call<T>(fn: (client: DAVClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session.caldav());
    } catch (err) {
      const mapped = mapDavError(err, 'CalDAV-Server');
      if (mapped instanceof AuthError) this.session.reset();
      throw mapped;
    }
  }

  private async calendars(force = false): Promise<DAVCalendar[]> {
    if (!force && this.calCache && Date.now() - this.calCache.at < CAL_TTL) return this.calCache.list;
    const list = await this.call((c) => c.fetchCalendars());
    this.calCache = { at: Date.now(), list };
    return list;
  }

  private async getObject(collection: string, url: string): Promise<{ url: string; etag?: string; data: string }> {
    const objs = await this.call((c) =>
      c.fetchCalendarObjects({ calendar: { url: collection }, objectUrls: [url], urlFilter: () => true }),
    );
    const obj = objs.find((o) => o.data);
    if (!obj) throw new NotFoundError('Kalenderobjekt');
    return { url: obj.url, etag: obj.etag, data: String(obj.data) };
  }

  private splitId(eventId: string): { url: string; rid?: string } {
    const i = eventId.indexOf('#');
    return i < 0 ? { url: eventId } : { url: eventId.slice(0, i), rid: eventId.slice(i + 1) };
  }

  /* ═════════════════════════════ Kalender ═════════════════════════════ */

  async listCalendars(): Promise<CalendarInfo[]> {
    const list = (await this.calendars(true)).filter((c) => supports(c, 'VEVENT'));
    return list.map((c, i) => ({
      id: c.url,
      accountId: this.accountId,
      name: nameOf(c, 'Kalender'),
      color: colorOf(c),
      readOnly: false,
      isDefault: i === 0,
      canOnlineMeeting: false,
    }));
  }

  async listEvents(calendarId: string, range: { start: string; end: string }): Promise<CalendarEvent[]> {
    const objs = await this.call((c) =>
      c.fetchCalendarObjects({ calendar: { url: calendarId }, timeRange: { start: range.start, end: range.end }, urlFilter: objectFilter }),
    );
    const r = { start: new Date(range.start), end: new Date(range.end) };
    const own = this.ownEmails();
    return objs.flatMap((o) =>
      o.data
        ? parseEvents(String(o.data), { accountId: this.accountId, calendarId, url: o.url, etag: o.etag, ownEmails: own }, r)
        : [],
    );
  }

  /** Liest ein (geändertes) Objekt erneut und liefert den passenden Termin. */
  private async reloadEvent(calendarId: string, eventId: string, hint?: { start?: string; end?: string }): Promise<CalendarEvent> {
    const { url } = this.splitId(eventId);
    const obj = await this.getObject(calendarId, url);
    const anchor = hint?.start ? new Date(hint.start) : new Date();
    const range = { start: new Date(anchor.getTime() - 400 * 86_400_000), end: new Date(anchor.getTime() + 400 * 86_400_000) };
    const events = parseEvents(obj.data, { accountId: this.accountId, calendarId, url: obj.url, etag: obj.etag, ownEmails: this.ownEmails() }, range);
    const exact = events.find((e) => e.id === eventId);
    if (exact) return exact;
    // Serie: erste Instanz ab Startzeitpunkt bzw. erste überhaupt
    const sorted = events.sort((a, b) => (a.start < b.start ? -1 : 1));
    const fromAnchor = hint?.start ? sorted.find((e) => e.start >= hint.start!.slice(0, 10)) : undefined;
    const ev = fromAnchor ?? sorted[0];
    if (!ev) throw new NotFoundError('Termin');
    return ev;
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const { url, rid } = this.splitId(eventId);
    if (rid) return this.reloadEvent(calendarId, eventId, { start: rid });
    const obj = await this.getObject(calendarId, url);
    const ev = parseMasterEvent(obj.data, { accountId: this.accountId, calendarId, url: obj.url, etag: obj.etag, ownEmails: this.ownEmails() });
    if (!ev) throw new NotFoundError('Termin');
    return ev;
  }

  async createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
    const { uid, ics } = buildNewEvent(input, { organizerEmail: this.ownEmails()[0] });
    const filename = safeFilename(uid);
    await this.call(async (c) => ensureOk(await c.createCalendarObject({ calendar: { url: calendarId }, filename, iCalString: ics }), 'Termin anlegen'));
    const url = new URL(filename, collectionUrl(calendarId)).href;
    try {
      return await this.reloadEvent(calendarId, url, input);
    } catch {
      const r = { start: new Date(new Date(input.start).getTime() - 86_400_000), end: new Date(new Date(input.end).getTime() + 86_400_000) };
      const parsed = parseEvents(ics, { accountId: this.accountId, calendarId, url, ownEmails: this.ownEmails() }, r);
      if (parsed[0]) return parsed[0];
      throw new NotFoundError('Neu angelegter Termin');
    }
  }

  async updateEvent(calendarId: string, eventId: string, input: Partial<EventInput>): Promise<CalendarEvent> {
    const { url, rid } = this.splitId(eventId);
    const obj = await this.getObject(calendarId, url);
    const updated = updateEventIcs(obj.data, input, { recurrenceIso: rid, organizerEmail: this.ownEmails()[0] });
    await this.call(async (c) => ensureOk(await c.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: updated } }), 'Termin ändern'));
    return this.reloadEvent(calendarId, eventId, { start: input.start ?? rid });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const { url, rid } = this.splitId(eventId);
    if (rid) {
      const obj = await this.getObject(calendarId, url);
      const updated = excludeOccurrence(obj.data, rid);
      await this.call(async (c) =>
        ensureOk(await c.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: updated } }), 'Termin löschen'),
      );
      return;
    }
    await this.call(async (c) => ensureOk(await c.deleteCalendarObject({ calendarObject: { url } }), 'Termin löschen'));
  }

  async respondToEvent(calendarId: string, eventId: string, response: EventResponse): Promise<void> {
    // Antwort gilt für die gesamte Serie (Instanz-IDs werden auf das Objekt abgebildet)
    const { url } = this.splitId(eventId);
    const obj = await this.getObject(calendarId, url);
    const updated = setPartstat(obj.data, this.ownEmails(), response);
    await this.call(async (c) => ensureOk(await c.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: updated } }), 'Antwort senden'));
  }

  /* ═════════════════════════════ Aufgaben ═════════════════════════════ */

  async listTaskLists(): Promise<TaskList[]> {
    const list = (await this.calendars()).filter((c) => supports(c, 'VTODO'));
    return list.map((c, i) => ({ id: c.url, accountId: this.accountId, name: nameOf(c, 'Aufgaben'), isDefault: i === 0, color: colorOf(c) }));
  }

  async listTasks(listId: string, opts: { showCompleted?: boolean }): Promise<Task[]> {
    const objs = await this.call((c) => c.fetchCalendarObjects({ calendar: { url: listId }, filters: VTODO_FILTER, urlFilter: objectFilter }));
    const tasks = objs.flatMap((o) => (o.data ? parseTodos(String(o.data), { accountId: this.accountId, listId, url: o.url, etag: o.etag }) : []));
    return tasks
      .filter((t) => opts.showCompleted || !t.completed)
      .sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
        if (a.due || b.due) return a.due ? -1 : 1;
        return a.title.localeCompare(b.title, 'de');
      });
  }

  private async reloadTask(listId: string, url: string, fallbackIcs?: string): Promise<Task> {
    try {
      const obj = await this.getObject(listId, url);
      const t = parseTodos(obj.data, { accountId: this.accountId, listId, url: obj.url, etag: obj.etag })[0];
      if (t) return t;
    } catch (err) {
      if (!fallbackIcs) throw err;
    }
    const t = fallbackIcs ? parseTodos(fallbackIcs, { accountId: this.accountId, listId, url })[0] : undefined;
    if (!t) throw new NotFoundError('Aufgabe');
    return t;
  }

  async createTask(listId: string, input: TaskInput): Promise<Task> {
    const { uid, ics } = buildNewTodo(input);
    const filename = safeFilename(uid);
    await this.call(async (c) => ensureOk(await c.createCalendarObject({ calendar: { url: listId }, filename, iCalString: ics }), 'Aufgabe anlegen'));
    return this.reloadTask(listId, new URL(filename, collectionUrl(listId)).href, ics);
  }

  async updateTask(listId: string, taskId: string, input: TaskInput): Promise<Task> {
    const obj = await this.getObject(listId, taskId);
    const updated = updateTodoIcs(obj.data, input);
    await this.call(async (c) => ensureOk(await c.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: updated } }), 'Aufgabe ändern'));
    return this.reloadTask(listId, obj.url, updated);
  }

  async deleteTask(_listId: string, taskId: string): Promise<void> {
    await this.call(async (c) => ensureOk(await c.deleteCalendarObject({ calendarObject: { url: taskId } }), 'Aufgabe löschen'));
  }

  async dispose(): Promise<void> {
    this.calCache = null;
  }
}
