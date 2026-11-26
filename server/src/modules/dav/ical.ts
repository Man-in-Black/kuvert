/**
 * iCalendar-Verarbeitung (ical.js): VEVENT/VTODO lesen, Serien expandieren,
 * Objekte erzeugen und gezielt ändern (unbekannte Eigenschaften bleiben erhalten).
 */
import crypto from 'node:crypto';
import ICAL from 'ical.js';
import type { Attendee, AttendeeStatus, CalendarEvent, EventInput, Task, TaskInput } from '@kuvert/shared';
import { addDays, dateOnly, isoToTime, isoToZonedTime, nthWeekdayOfMonth, timeToDate, timeToIso, wallMs, zoneRules } from './time.js';

type Component = InstanceType<typeof ICAL.Component>;
type ICalTime = InstanceType<typeof ICAL.Time>;
type ICalEvent = InstanceType<typeof ICAL.Event>;

const MAX_OCCURRENCES = 500;
const MAX_ITERATIONS = 20_000;

export function newUid(): string {
  return `${crypto.randomUUID()}@kuvert`;
}

export function parseCalendar(ics: string): Component {
  return new ICAL.Component(ICAL.parse(ics));
}

function newCalendar(): Component {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', '-//Kuvert//Kuvert Webmail//DE');
  vcal.updatePropertyWithValue('version', '2.0');
  return vcal;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/* ═════════════════════════════ Teilnehmer ═════════════════════════════ */

const PARTSTAT_IN: Record<string, AttendeeStatus> = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  'NEEDS-ACTION': 'needsAction',
  DELEGATED: 'none',
};
const PARTSTAT_OUT: Record<AttendeeStatus, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  needsAction: 'NEEDS-ACTION',
  none: 'NEEDS-ACTION',
};

const mailto = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '').trim() : '');

function readAttendees(vevent: Component): Attendee[] {
  return vevent.getAllProperties('attendee').map((p) => {
    const cutype = String(p.getParameter('cutype') ?? '').toUpperCase();
    const role = String(p.getParameter('role') ?? '').toUpperCase();
    const cn = p.getParameter('cn');
    return {
      address: mailto(p.getFirstValue()),
      name: typeof cn === 'string' ? cn : undefined,
      status: PARTSTAT_IN[String(p.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase()] ?? 'needsAction',
      type: cutype === 'RESOURCE' || cutype === 'ROOM' ? 'resource' : role === 'OPT-PARTICIPANT' ? 'optional' : 'required',
    } satisfies Attendee;
  });
}

function writeAttendees(vevent: Component, attendees: Attendee[], organizerEmail?: string) {
  vevent.removeAllProperties('attendee');
  for (const a of attendees) {
    if (!a.address) continue;
    const p = new ICAL.Property('attendee');
    p.setValue(`mailto:${a.address}`);
    if (a.name) p.setParameter('cn', a.name);
    p.setParameter('partstat', PARTSTAT_OUT[a.status ?? 'needsAction']);
    if (a.type === 'resource') {
      p.setParameter('cutype', 'RESOURCE');
      p.setParameter('role', 'NON-PARTICIPANT');
    } else {
      p.setParameter('role', a.type === 'optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
      p.setParameter('cutype', 'INDIVIDUAL');
    }
    if ((a.status ?? 'needsAction') === 'needsAction') p.setParameter('rsvp', 'TRUE');
    vevent.addProperty(p);
  }
  if (attendees.length && !vevent.getFirstProperty('organizer') && organizerEmail) {
    const org = new ICAL.Property('organizer');
    org.setValue(`mailto:${organizerEmail}`);
    vevent.addProperty(org);
  }
}

/* ═════════════════════════════ Termine lesen ═════════════════════════════ */

export interface ParseContext {
  accountId: string;
  calendarId: string;
  url: string;
  etag?: string;
  /** eigene Adressen (Organisator/Teilnehmer-Erkennung) */
  ownEmails: string[];
}

function tzidOf(vevent: Component, prop = 'dtstart'): string | undefined {
  const tz = vevent.getFirstProperty(prop)?.getParameter('tzid');
  return typeof tz === 'string' ? tz : undefined;
}

function reminderOf(vevent: Component): number | null {
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstProperty('trigger');
    const v = trigger?.getFirstValue() as unknown;
    if (v instanceof ICAL.Duration) {
      const related = String(trigger?.getParameter('related') ?? 'START').toUpperCase();
      if (related !== 'START') continue;
      const secs = v.toSeconds();
      return Math.max(0, Math.round(-secs / 60));
    }
  }
  return null;
}

/** Wandelt ein ical.js-Event (Master oder Ausnahme) in ein CalendarEvent. */
function mapEvent(
  ev: ICalEvent,
  ctx: ParseContext,
  start: ICalTime,
  end: ICalTime | undefined,
  occurrence?: { recurrenceIso: string },
): CalendarEvent {
  const vevent = ev.component;
  const tzStart = tzidOf(vevent, 'dtstart');
  const tzEnd = tzidOf(vevent, 'dtend') ?? tzStart;
  const allDay = start.isDate;
  const startIso = timeToIso(start, tzStart);
  let endIso: string;
  if (end) endIso = timeToIso(end, tzEnd);
  else endIso = allDay ? addDays(startIso, 1) : startIso;
  if (allDay && endIso <= startIso) endIso = addDays(startIso, 1);

  const attendees = readAttendees(vevent);
  const own = ctx.ownEmails.map((e) => e.toLowerCase());
  const organizerAddr = mailto(vevent.getFirstPropertyValue('organizer'));
  const organizerCn = vevent.getFirstProperty('organizer')?.getParameter('cn');
  const me = attendees.find((a) => own.includes(a.address.toLowerCase()));
  const status = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase();
  const transp = String(vevent.getFirstPropertyValue('transp') ?? '').toUpperCase();
  const rrule = vevent.getFirstPropertyValue('rrule') as unknown;
  const description = str(vevent.getFirstPropertyValue('description'));
  const url = str(vevent.getFirstPropertyValue('url'));
  const meetingUrl =
    str(vevent.getFirstPropertyValue('x-google-conference')) ??
    str(vevent.getFirstPropertyValue('x-microsoft-skypeteamsmeetingurl')) ??
    description?.match(/https:\/\/(?:teams\.microsoft\.com|meet\.google\.com|[\w.-]*zoom\.us|[\w.-]+\/call\/)[^\s<>"]+/)?.[0];

  return {
    id: occurrence ? `${ctx.url}#${occurrence.recurrenceIso}` : ctx.url,
    accountId: ctx.accountId,
    calendarId: ctx.calendarId,
    title: ev.summary || '(Ohne Titel)',
    description,
    location: str(ev.location),
    start: startIso,
    end: endIso,
    allDay,
    timeZone: tzStart,
    recurrence: rrule ? String(rrule.toString()) : null,
    recurringEventId: occurrence ? ctx.url : undefined,
    originalStart: occurrence?.recurrenceIso,
    attendees: attendees.length ? attendees : undefined,
    organizer: organizerAddr ? { address: organizerAddr, name: typeof organizerCn === 'string' ? organizerCn : undefined } : undefined,
    onlineMeetingUrl: meetingUrl,
    status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    showAs: transp === 'TRANSPARENT' ? 'free' : status === 'TENTATIVE' ? 'tentative' : 'busy',
    reminderMinutes: reminderOf(vevent),
    myResponse: me?.status,
    isOrganizer: !organizerAddr || own.includes(organizerAddr.toLowerCase()),
    webLink: url,
    color: str(vevent.getFirstPropertyValue('color')),
    etag: ctx.etag,
  };
}

/**
 * Liest alle Termine eines Kalenderobjekts und expandiert Serien im Zeitraum.
 * Instanzen erhalten die ID "<objekt-url>#<recurrence-id als ISO>".
 */
export function parseEvents(ics: string, ctx: ParseContext, range: { start: Date; end: Date }): CalendarEvent[] {
  let vcal: Component;
  try {
    vcal = parseCalendar(ics);
  } catch {
    return [];
  }
  const vevents = vcal.getAllSubcomponents('vevent');
  if (!vevents.length) return [];
  const masters = vevents.filter((v) => !v.getFirstProperty('recurrence-id'));
  const exceptions = vevents.filter((v) => v.getFirstProperty('recurrence-id'));
  const out: CalendarEvent[] = [];
  const overlaps = (s: Date, e: Date) => e > range.start && s < range.end;

  for (const master of masters) {
    const uid = master.getFirstPropertyValue('uid');
    const own = exceptions.filter((x) => x.getFirstPropertyValue('uid') === uid);
    const ev = new ICAL.Event(master, { exceptions: own });
    const tz = tzidOf(master);

    if (!ev.isRecurring()) {
      const s = ev.startDate;
      if (!s) continue;
      const mapped = mapEvent(ev, ctx, s, master.getFirstProperty('dtend') || master.getFirstProperty('duration') ? ev.endDate : undefined);
      const sd = new Date(mapped.allDay ? `${mapped.start}T00:00:00Z` : mapped.start);
      const ed = new Date(mapped.allDay ? `${mapped.end}T00:00:00Z` : mapped.end);
      if (overlaps(sd, ed.getTime() === sd.getTime() ? new Date(sd.getTime() + 1) : ed)) out.push(mapped);
      continue;
    }

    const it = ev.iterator();
    let emitted = 0;
    for (let i = 0; i < MAX_ITERATIONS && emitted < MAX_OCCURRENCES; i++) {
      const next = it.next();
      if (!next) break;
      const occStart = timeToDate(next, tz);
      if (occStart >= range.end) break;
      const details = ev.getOccurrenceDetails(next);
      const sDate = timeToDate(details.startDate, tzidOf(details.item.component) ?? tz);
      let eDate = details.endDate ? timeToDate(details.endDate, tzidOf(details.item.component, 'dtend') ?? tz) : sDate;
      if (eDate.getTime() === sDate.getTime()) eDate = new Date(sDate.getTime() + (details.startDate.isDate ? 86_400_000 : 1));
      if (!overlaps(sDate, eDate)) continue;
      const recurrenceIso = timeToIso(details.recurrenceId, tz);
      const mapped = mapEvent(details.item, ctx, details.startDate, details.endDate, { recurrenceIso });
      if (details.item !== ev) mapped.isException = true;
      // Serienregel vom Master übernehmen, damit die Oberfläche die Serie erkennt
      mapped.recurrence = ev.component.getFirstPropertyValue('rrule')?.toString() ?? mapped.recurrence;
      if (mapped.status === 'cancelled') continue;
      out.push(mapped);
      emitted++;
    }
  }

  // Ausnahmen ohne Master im selben Objekt (kommt bei manchen Servern vor)
  const masterUids = new Set(masters.map((m) => m.getFirstPropertyValue('uid')));
  for (const x of exceptions) {
    if (masterUids.has(x.getFirstPropertyValue('uid'))) continue;
    const ev = new ICAL.Event(x);
    const rid = ev.recurrenceId;
    const mapped = mapEvent(ev, ctx, ev.startDate, ev.endDate, { recurrenceIso: timeToIso(rid, tzidOf(x, 'recurrence-id')) });
    mapped.isException = true;
    const sd = new Date(mapped.allDay ? `${mapped.start}T00:00:00Z` : mapped.start);
    const ed = new Date(mapped.allDay ? `${mapped.end}T00:00:00Z` : mapped.end);
    if (overlaps(sd, ed)) out.push(mapped);
  }
  return out;
}

/** Liest den Master eines Objekts (bei Serien: Beginn = erster Termin, inkl. RRULE). */
export function parseMasterEvent(ics: string, ctx: ParseContext): CalendarEvent | undefined {
  let vcal: Component;
  try {
    vcal = parseCalendar(ics);
  } catch {
    return undefined;
  }
  const master = findMaster(vcal);
  if (!master) return undefined;
  const ev = new ICAL.Event(master);
  if (!ev.startDate) return undefined;
  return mapEvent(ev, ctx, ev.startDate, master.getFirstProperty('dtend') || master.getFirstProperty('duration') ? ev.endDate : undefined);
}

/* ═════════════════════════════ Termine schreiben ═════════════════════════════ */

function setText(comp: Component, name: string, value: string | undefined) {
  if (value === undefined) return;
  if (value === '') comp.removeAllProperties(name);
  else comp.updatePropertyWithValue(name, value);
}

function setTimeProp(comp: Component, name: string, time: ICalTime) {
  comp.removeAllProperties(name);
  const p = new ICAL.Property(name);
  if (time.isDate) p.resetType('date');
  p.setValue(time);
  comp.addProperty(p);
}

/**
 * Setzt eine Zeit-Eigenschaft. Mit TZID als Wandzeit in dieser Zone – wichtig für
 * Serien, damit „09:00“ auch nach der Sommerzeit-Umstellung 09:00 bleibt. Ohne
 * (auflösbare) Zone als UTC bzw. Datum.
 */
function setTimeValue(comp: Component, name: string, iso: string, allDay: boolean, tzid?: string) {
  const zoned = !allDay && tzid ? isoToZonedTime(iso, tzid) : undefined;
  setTimeProp(comp, name, zoned ?? isoToTime(iso, allDay));
  if (zoned) comp.getFirstProperty(name)?.setParameter('tzid', tzid!);
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Ergänzt fehlende VTIMEZONE-Definitionen für alle in VEVENTs verwendeten TZIDs
 * (RFC 5545 verlangt sie). Erzeugt aus der IANA-Zone; unbekannte Zonen bleiben unberührt.
 */
function ensureVtimezones(vcal: Component) {
  const have = new Set(vcal.getAllSubcomponents('vtimezone').map((v) => String(v.getFirstPropertyValue('tzid') ?? '')));
  const used = new Set<string>();
  for (const v of vcal.getAllSubcomponents('vevent')) {
    for (const name of ['dtstart', 'dtend', 'recurrence-id', 'exdate']) {
      for (const p of v.getAllProperties(name)) {
        const tz = p.getParameter('tzid');
        if (typeof tz === 'string' && tz) used.add(tz);
      }
    }
  }
  const offset = (min: number) => ICAL.UtcOffset.fromSeconds(min * 60);
  for (const tzid of used) {
    if (have.has(tzid)) continue;
    const info = zoneRules(tzid);
    if (!info) continue;
    const vtz = new ICAL.Component('vtimezone');
    vtz.addPropertyWithValue('tzid', tzid);
    if (!info.rules.length) {
      const std = new ICAL.Component('standard');
      std.addPropertyWithValue('dtstart', ICAL.Time.fromData({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }));
      std.addPropertyWithValue('tzoffsetfrom', offset(info.offset));
      std.addPropertyWithValue('tzoffsetto', offset(info.offset));
      vtz.addSubcomponent(std);
    }
    for (const r of info.rules) {
      const c = new ICAL.Component(r.kind);
      const day = nthWeekdayOfMonth(1970, r.month, r.weekday, r.nth);
      c.addPropertyWithValue('dtstart', ICAL.Time.fromData({ year: 1970, month: r.month, day, hour: r.hour, minute: r.minute, second: 0, isDate: false }));
      c.addPropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=YEARLY;BYMONTH=${r.month};BYDAY=${r.nth}${DAY_CODES[r.weekday]}`));
      c.addPropertyWithValue('tzoffsetfrom', offset(r.from));
      c.addPropertyWithValue('tzoffsetto', offset(r.to));
      vtz.addSubcomponent(c);
    }
    // VTIMEZONE vor die Termine stellen
    const events = vcal.getAllSubcomponents('vevent');
    for (const e of events) vcal.removeSubcomponent(e);
    vcal.addSubcomponent(vtz);
    for (const e of events) vcal.addSubcomponent(e);
    have.add(tzid);
  }
}

/** Wendet Änderungen aus EventInput auf eine VEVENT-Komponente an. */
function applyEventInput(vevent: Component, input: Partial<EventInput>, opts: { organizerEmail?: string; isMaster: boolean }) {
  setText(vevent, 'summary', input.title);
  setText(vevent, 'location', input.location);
  if (input.description !== undefined) setText(vevent, 'description', input.description);
  else if (input.descriptionHtml !== undefined) setText(vevent, 'description', input.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

  if (input.start !== undefined || input.end !== undefined || input.allDay !== undefined) {
    const curStart = vevent.getFirstPropertyValue('dtstart') as unknown as ICalTime | null;
    const curEnd = vevent.getFirstPropertyValue('dtend') as unknown as ICalTime | null;
    const allDay = input.allDay ?? curStart?.isDate ?? false;
    const tz = tzidOf(vevent);
    // Serien ohne bisherige Zone (neu oder bisher ganztägig) in der Zone des Nutzers verankern
    const recurs = opts.isMaster && (input.recurrence !== undefined ? !!input.recurrence : !!vevent.getFirstProperty('rrule'));
    const writeTz = tz ?? (recurs ? input.timeZone : undefined);
    const writeTzEnd = tzidOf(vevent, 'dtend') ?? writeTz;
    const startIso = input.start ?? (curStart ? timeToIso(curStart, tz) : undefined);
    if (!startIso) throw new Error('Startzeit fehlt');
    let endIso = input.end ?? (curEnd ? timeToIso(curEnd, tzidOf(vevent, 'dtend') ?? tz) : undefined);
    if (allDay) {
      const s = startIso.slice(0, 10);
      let e = (endIso ?? addDays(s, 1)).slice(0, 10);
      if (e <= s) e = addDays(s, 1);
      setTimeProp(vevent, 'dtstart', isoToTime(s, true));
      setTimeProp(vevent, 'dtend', isoToTime(e, true));
    } else {
      if (!endIso || new Date(endIso) < new Date(startIso)) endIso = new Date(new Date(startIso).getTime() + 3600_000).toISOString();
      setTimeValue(vevent, 'dtstart', startIso, false, writeTz);
      setTimeValue(vevent, 'dtend', endIso, false, writeTzEnd);
    }
    vevent.removeAllProperties('duration');
  }

  if (input.attendees !== undefined) writeAttendees(vevent, input.attendees, opts.organizerEmail);

  if (opts.isMaster && input.recurrence !== undefined) {
    vevent.removeAllProperties('rrule');
    const rule = (input.recurrence ?? '').replace(/^RRULE:/i, '').trim();
    if (rule) vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(rule));
  }

  if (input.reminderMinutes !== undefined) {
    for (const a of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(a);
    if (input.reminderMinutes !== null && input.reminderMinutes >= 0) {
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', String(vevent.getFirstPropertyValue('summary') ?? 'Erinnerung'));
      const trigger = new ICAL.Property('trigger');
      trigger.setValue(ICAL.Duration.fromSeconds(-input.reminderMinutes * 60));
      alarm.addProperty(trigger);
      vevent.addSubcomponent(alarm);
    }
  }

  if (input.showAs !== undefined) {
    vevent.updatePropertyWithValue('transp', input.showAs === 'free' ? 'TRANSPARENT' : 'OPAQUE');
    if (input.showAs === 'tentative') vevent.updatePropertyWithValue('status', 'TENTATIVE');
  }

  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
}

/** Erzeugt ein neues Kalenderobjekt. */
export function buildNewEvent(input: EventInput, opts: { uid?: string; organizerEmail?: string }): { uid: string; ics: string } {
  const uid = opts.uid ?? newUid();
  const vcal = newCalendar();
  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue('sequence', 0);
  vcal.addSubcomponent(vevent);
  applyEventInput(vevent, { allDay: false, ...input }, { organizerEmail: opts.organizerEmail, isMaster: true });
  if (!input.title) vevent.updatePropertyWithValue('summary', '(Ohne Titel)');
  ensureVtimezones(vcal);
  return { uid, ics: vcal.toString() };
}

function findMaster(vcal: Component): Component | undefined {
  const vevents = vcal.getAllSubcomponents('vevent');
  return vevents.find((v) => !v.getFirstProperty('recurrence-id')) ?? vevents[0];
}

function bumpSequence(vevent: Component) {
  const seq = Number(vevent.getFirstPropertyValue('sequence') ?? 0) || 0;
  vevent.updatePropertyWithValue('sequence', seq + 1);
}

/** Findet die Ausnahme-VEVENT zu einer Recurrence-ID (ISO-Darstellung wie in parseEvents). */
function findException(vcal: Component, master: Component, recurrenceIso: string): Component | undefined {
  const tz = tzidOf(master);
  return vcal.getAllSubcomponents('vevent').find((v) => {
    const rid = v.getFirstPropertyValue('recurrence-id') as unknown as ICalTime | null;
    if (!rid) return false;
    return timeToIso(rid, tzidOf(v, 'recurrence-id') ?? tz) === recurrenceIso;
  });
}

/**
 * Ändert ein bestehendes Objekt. Bei Instanz-IDs (recurrenceIso gesetzt) wird eine
 * Ausnahme (RECURRENCE-ID) angelegt bzw. aktualisiert – die Serie bleibt unverändert.
 */
export function updateEventIcs(
  ics: string,
  input: Partial<EventInput>,
  opts: { recurrenceIso?: string; organizerEmail?: string },
): string {
  const vcal = parseCalendar(ics);
  const master = findMaster(vcal);
  if (!master) throw new Error('Kein VEVENT im Objekt gefunden');

  if (!opts.recurrenceIso) {
    const before = master.getFirstPropertyValue('dtstart') as unknown as ICalTime | null;
    applyEventInput(master, input, { organizerEmail: opts.organizerEmail, isMaster: true });
    bumpSequence(master);
    const after = master.getFirstPropertyValue('dtstart') as unknown as ICalTime | null;
    if (before && after && master.getFirstProperty('rrule')) {
      realignOverrides(vcal, master, before.isDate === after.isDate ? wallMs(after) - wallMs(before) : null);
    }
    if (input.recurrence !== undefined) dropOverridesAfterUntil(vcal, master);
    ensureVtimezones(vcal);
    return vcal.toString();
  }

  let exc = findException(vcal, master, opts.recurrenceIso);
  if (!exc) {
    exc = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    exc.removeAllProperties('rrule');
    exc.removeAllProperties('rdate');
    exc.removeAllProperties('exdate');
    const allDay = (master.getFirstPropertyValue('dtstart') as unknown as ICalTime | null)?.isDate ?? false;
    setTimeValue(exc, 'recurrence-id', opts.recurrenceIso, allDay, tzidOf(master));
    // Start/Ende der Instanz übernehmen (Dauer des Masters)
    const mStart = master.getFirstPropertyValue('dtstart') as unknown as ICalTime;
    const mEnd = master.getFirstPropertyValue('dtend') as unknown as ICalTime | null;
    const durMs = mEnd ? timeToDate(mEnd, tzidOf(master, 'dtend') ?? tzidOf(master)).getTime() - timeToDate(mStart, tzidOf(master)).getTime() : 0;
    const instStart = allDay ? opts.recurrenceIso.slice(0, 10) : new Date(opts.recurrenceIso).toISOString();
    const instEnd = allDay ? addDays(instStart, Math.max(1, Math.round(durMs / 86_400_000))) : new Date(new Date(instStart).getTime() + durMs).toISOString();
    applyEventInput(exc, { start: instStart, end: instEnd, allDay }, { isMaster: false });
    vcal.addSubcomponent(exc);
  }
  applyEventInput(exc, input, { organizerEmail: opts.organizerEmail, isMaster: false });
  bumpSequence(exc);
  ensureVtimezones(vcal);
  return vcal.toString();
}

/**
 * Nach dem Verschieben einer ganzen Serie: geänderte bzw. gelöschte Einzeltermine
 * (RECURRENCE-ID, EXDATE) um dieselbe Wandzeit-Differenz mitverschieben, damit sie
 * weiter zu ihren Terminen passen. delta = null (ganztägig ↔ mit Uhrzeit): entfernen.
 */
function realignOverrides(vcal: Component, master: Component, deltaMs: number | null) {
  if (deltaMs === 0) return;
  const uid = master.getFirstPropertyValue('uid');
  const shift = (t: ICalTime) => {
    const c = t.clone();
    c.addDuration(ICAL.Duration.fromSeconds(Math.round(deltaMs! / 1000)));
    return c;
  };
  for (const v of vcal.getAllSubcomponents('vevent')) {
    const rid = v.getFirstProperty('recurrence-id');
    if (!rid || v.getFirstPropertyValue('uid') !== uid) continue;
    if (deltaMs === null) vcal.removeSubcomponent(v);
    else rid.setValue(shift(rid.getFirstValue() as unknown as ICalTime));
  }
  for (const p of master.getAllProperties('exdate')) {
    if (deltaMs === null) master.removeProperty(p);
    else p.setValues(p.getValues().map((t) => shift(t as unknown as ICalTime)));
  }
}

/**
 * Nach dem Kürzen einer Serie (UNTIL): Einzeltermin-Ausnahmen und EXDATEs hinter dem
 * neuen Serienende entfernen, damit andere Programme keine verwaisten Termine zeigen.
 */
function dropOverridesAfterUntil(vcal: Component, master: Component) {
  const rule = master.getFirstPropertyValue('rrule') as unknown as { until?: ICalTime | null } | null;
  const until = rule?.until;
  if (!until) return;
  const tz = tzidOf(master);
  const limit = until.isDate ? timeToDate(until).getTime() + 86_400_000 : timeToDate(until, tz).getTime() + 1;
  const after = (t: ICalTime, tzid?: string) => timeToDate(t, tzid ?? tz).getTime() >= limit;
  const uid = master.getFirstPropertyValue('uid');
  for (const v of vcal.getAllSubcomponents('vevent')) {
    const rid = v.getFirstProperty('recurrence-id');
    if (!rid || v.getFirstPropertyValue('uid') !== uid) continue;
    if (after(rid.getFirstValue() as unknown as ICalTime, tzidOf(v, 'recurrence-id'))) vcal.removeSubcomponent(v);
  }
  for (const p of master.getAllProperties('exdate')) {
    const ptz = p.getParameter('tzid');
    const keep = p.getValues().filter((t) => !after(t as unknown as ICalTime, typeof ptz === 'string' ? ptz : undefined));
    if (!keep.length) master.removeProperty(p);
    else if (keep.length !== p.getValues().length) p.setValues(keep);
  }
}

/** Entfernt eine einzelne Instanz einer Serie (EXDATE + Ausnahme löschen). */
export function excludeOccurrence(ics: string, recurrenceIso: string): string {
  const vcal = parseCalendar(ics);
  const master = findMaster(vcal);
  if (!master) throw new Error('Kein VEVENT im Objekt gefunden');
  const exc = findException(vcal, master, recurrenceIso);
  if (exc) vcal.removeSubcomponent(exc);
  const allDay = (master.getFirstPropertyValue('dtstart') as unknown as ICalTime | null)?.isDate ?? false;
  const tz = tzidOf(master);
  const zoned = !allDay && tz ? isoToZonedTime(recurrenceIso, tz) : undefined;
  const p = new ICAL.Property('exdate');
  if (allDay) p.resetType('date');
  p.setValue(zoned ?? isoToTime(recurrenceIso, allDay));
  if (zoned) p.setParameter('tzid', tz!);
  master.addProperty(p);
  bumpSequence(master);
  return vcal.toString();
}

/** Setzt den eigenen Teilnahmestatus (PARTSTAT). */
export function setPartstat(ics: string, ownEmails: string[], response: 'accept' | 'tentative' | 'decline'): string {
  const vcal = parseCalendar(ics);
  const own = ownEmails.map((e) => e.toLowerCase());
  const value = response === 'accept' ? 'ACCEPTED' : response === 'tentative' ? 'TENTATIVE' : 'DECLINED';
  let found = false;
  for (const vevent of vcal.getAllSubcomponents('vevent')) {
    for (const p of vevent.getAllProperties('attendee')) {
      if (own.includes(mailto(p.getFirstValue()).toLowerCase())) {
        p.setParameter('partstat', value);
        p.removeParameter('rsvp');
        found = true;
      }
    }
    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  }
  if (!found) throw new Error('Sie sind kein Teilnehmer dieses Termins');
  return vcal.toString();
}

/* ═════════════════════════════ Aufgaben (VTODO) ═════════════════════════════ */

function priorityToImportance(p: unknown): Task['importance'] {
  const n = Number(p);
  if (!n) return 'normal';
  if (n <= 4) return 'high';
  if (n === 5) return 'normal';
  return 'low';
}

function importanceToPriority(i: Task['importance']): number {
  return i === 'high' ? 1 : i === 'low' ? 9 : 5;
}

export function parseTodos(ics: string, ctx: { accountId: string; listId: string; url: string; etag?: string }): Task[] {
  let vcal: Component;
  try {
    vcal = parseCalendar(ics);
  } catch {
    return [];
  }
  return vcal
    .getAllSubcomponents('vtodo')
    .filter((t) => !t.getFirstProperty('recurrence-id'))
    .map((t) => {
      const due = t.getFirstPropertyValue('due') as unknown as ICalTime | null;
      const completedAt = t.getFirstPropertyValue('completed') as unknown as ICalTime | null;
      const created = t.getFirstPropertyValue('created') as unknown as ICalTime | null;
      const modified = t.getFirstPropertyValue('last-modified') as unknown as ICalTime | null;
      const status = String(t.getFirstPropertyValue('status') ?? '').toUpperCase();
      const parent = t
        .getAllProperties('related-to')
        .find((p) => String(p.getParameter('reltype') ?? 'PARENT').toUpperCase() === 'PARENT')
        ?.getFirstValue();
      return {
        id: ctx.url,
        accountId: ctx.accountId,
        listId: ctx.listId,
        title: String(t.getFirstPropertyValue('summary') ?? '') || '(Ohne Titel)',
        notes: str(t.getFirstPropertyValue('description')),
        due: due ? timeToIso(due, tzidOf(t, 'due')) : null,
        completed: status === 'COMPLETED' || !!completedAt,
        completedAt: completedAt ? timeToIso(completedAt) : null,
        importance: priorityToImportance(t.getFirstPropertyValue('priority')),
        createdAt: created ? timeToIso(created) : undefined,
        updatedAt: modified ? timeToIso(modified) : undefined,
        parentId: typeof parent === 'string' ? parent : null,
        etag: ctx.etag,
      } satisfies Task;
    });
}

function applyTodoInput(vtodo: Component, input: TaskInput) {
  setText(vtodo, 'summary', input.title);
  if (input.notes !== undefined) setText(vtodo, 'description', input.notes);
  if (input.due !== undefined) {
    vtodo.removeAllProperties('due');
    if (input.due) {
      const dateOnlyValue = /^\d{4}-\d{2}-\d{2}$/.test(input.due);
      setTimeProp(vtodo, 'due', isoToTime(input.due, dateOnlyValue));
    }
  }
  if (input.importance !== undefined) vtodo.updatePropertyWithValue('priority', importanceToPriority(input.importance));
  if (input.completed !== undefined) {
    if (input.completed) {
      vtodo.updatePropertyWithValue('status', 'COMPLETED');
      vtodo.updatePropertyWithValue('percent-complete', 100);
      if (!vtodo.getFirstProperty('completed')) vtodo.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(new Date(), true));
    } else {
      vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
      vtodo.removeAllProperties('completed');
      vtodo.removeAllProperties('percent-complete');
    }
  }
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vtodo.updatePropertyWithValue('dtstamp', now);
  vtodo.updatePropertyWithValue('last-modified', now);
}

export function buildNewTodo(input: TaskInput): { uid: string; ics: string } {
  const uid = newUid();
  const vcal = newCalendar();
  const vtodo = new ICAL.Component('vtodo');
  vtodo.addPropertyWithValue('uid', uid);
  vtodo.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  vtodo.addPropertyWithValue('status', 'NEEDS-ACTION');
  vcal.addSubcomponent(vtodo);
  applyTodoInput(vtodo, { ...input, title: input.title || '(Ohne Titel)' });
  return { uid, ics: vcal.toString() };
}

export function updateTodoIcs(ics: string, input: TaskInput): string {
  const vcal = parseCalendar(ics);
  const vtodo = vcal.getAllSubcomponents('vtodo').find((t) => !t.getFirstProperty('recurrence-id'));
  if (!vtodo) throw new Error('Kein VTODO im Objekt gefunden');
  applyTodoInput(vtodo, input);
  const seq = Number(vtodo.getFirstPropertyValue('sequence') ?? 0) || 0;
  vtodo.updatePropertyWithValue('sequence', seq + 1);
  return vcal.toString();
}

export { dateOnly };
