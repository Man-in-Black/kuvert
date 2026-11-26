/**
 * Kalender, Kontakte, Aufgaben, Cloud-Speicher und Online-Meetings –
 * jeweils kontoübergreifend aggregiert.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AddressBook, AddressSuggestion, CalendarEvent, CalendarInfo, Contact, EventInput, PlaceDetails, PlaceSuggestion, Task, TaskList } from '@kuvert/shared';
import { getDb } from '../core/db.js';
import { BadRequestError } from '../core/errors.js';
import { contactMatches } from '../core/contact-search.js';
import { autocompletePlaces, placeDetails } from '../core/places.js';
import { SOURCE_BOOK_ID, type ContactSource } from '../core/hooks.js';
import type { AccountRecord, ModuleContext } from '../core/module.js';
import { uploads } from '../core/uploads.js';
import { parse, sendFile, settleByAccount } from './util.js';

type AccParams = { Params: { accountId: string } };

const attendee = z.object({
  name: z.string().optional(),
  address: z.string(),
  status: z.enum(['accepted', 'declined', 'tentative', 'needsAction', 'none']).optional(),
  type: z.enum(['required', 'optional', 'resource']).optional(),
});

const eventInput = z.object({
  title: z.string().default(''),
  description: z.string().optional(),
  descriptionHtml: z.string().optional(),
  location: z.string().optional(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().optional(),
  timeZone: z.string().optional(),
  attendees: z.array(attendee).optional(),
  recurrence: z.string().nullable().optional(),
  reminderMinutes: z.number().nullable().optional(),
  onlineMeeting: z.boolean().optional(),
  showAs: z.enum(['free', 'busy', 'tentative', 'oof', 'workingElsewhere']).optional(),
});

/**
 * Teiländerung eines Termins: nur gesendete Felder ändern sich. Achtung, Zod 4 setzt
 * `.default()` auch innerhalb von `.partial()` ein – ohne diese Überschreibung würde
 * jedes Verschieben den Titel auf "" setzen.
 */
const eventPatch = eventInput.extend({ title: z.string().optional() }).partial();

const contactInput = z.object({
  displayName: z.string().default(''),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  emails: z.array(z.object({ type: z.string().optional(), address: z.string() })).default([]),
  phones: z.array(z.object({ type: z.string().optional(), number: z.string() })).default([]),
  addresses: z
    .array(
      z.object({
        type: z.string().optional(),
        street: z.string().optional(),
        city: z.string().optional(),
        postalCode: z.string().optional(),
        region: z.string().optional(),
        country: z.string().optional(),
      }),
    )
    .optional(),
  birthday: z.string().nullable().optional(),
  notes: z.string().optional(),
  website: z.string().optional(),
  photoUrl: z.string().optional(),
});

const taskInput = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  due: z.string().nullable().optional(),
  completed: z.boolean().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
});

export async function pimRoutes(app: FastifyInstance, ctx: ModuleContext) {
  const { accounts } = ctx;

  /* ═════════════════════════════ Kalender ═════════════════════════════ */

  /* Ortssuche (Google Places) für das Feld „Ort“ im Termin-Dialog */
  const placeQuery = z.object({
    q: z.string().trim().min(2).max(200),
    session: z.string().max(64).optional(),
    lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  });
  app.get('/api/calendar/places', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req): Promise<PlaceSuggestion[]> => {
    const q = parse(placeQuery, req.query);
    return autocompletePlaces(q.q, q.session, q.lang);
  });

  const placeDetailQuery = z.object({
    name: z.string().max(300).optional(),
    session: z.string().max(64).optional(),
    lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  });
  app.get<{ Params: { placeId: string } }>(
    '/api/calendar/places/:placeId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<PlaceDetails> => {
      if (!/^[\w-]{1,300}$/.test(req.params.placeId)) throw new BadRequestError('Ungültige Orts-ID');
      const q = parse(placeDetailQuery, req.query);
      return placeDetails(req.params.placeId, q.name, q.session, q.lang);
    },
  );


  app.get('/api/calendar/calendars', async (req) => {
    const accs = accounts.withCapability(req.user.id, 'calendar');
    const { results, errors } = await settleByAccount(accs, (a) => accounts.providersFor(a as AccountRecord).calendar!.listCalendars());
    const calendars: CalendarInfo[] = results.flatMap((r) => r.value.map((c) => ({ ...c, accountId: r.accountId })));
    return { calendars, errors };
  });

  /** Termine mehrerer Kalender im Zeitraum (ohne Angabe: alle Kalender) */
  app.post('/api/calendar/events/query', async (req) => {
    const body = parse(
      z.object({
        start: z.string(),
        end: z.string(),
        calendars: z.array(z.object({ accountId: z.string(), calendarId: z.string() })).optional(),
      }),
      req.body,
    );
    const accs = accounts.withCapability(req.user.id, 'calendar');
    const wanted = body.calendars;
    const { results, errors } = await settleByAccount(accs, async (a) => {
      const cal = accounts.providersFor(a as AccountRecord).calendar!;
      const ids = wanted ? wanted.filter((w) => w.accountId === a.id).map((w) => w.calendarId) : (await cal.listCalendars()).map((c) => c.id);
      const lists = await Promise.all(ids.map((id) => cal.listEvents(id, { start: body.start, end: body.end })));
      return lists.flat();
    });
    const events: CalendarEvent[] = results.flatMap((r) => r.value.map((e) => ({ ...e, accountId: r.accountId })));
    return { events, errors };
  });

  app.post<AccParams>('/api/calendar/accounts/:accountId/events', async (req) => {
    const body = parse(z.object({ calendarId: z.string(), event: eventInput }), req.body);
    const ev = await accounts.require(req.user.id, req.params.accountId, 'calendar').createEvent(body.calendarId, body.event as EventInput);
    ctx.bus.publish(req.user.id, { type: 'calendar.changed', accountId: req.params.accountId });
    return ev;
  });

  app.patch<AccParams>('/api/calendar/accounts/:accountId/events', async (req) => {
    const body = parse(z.object({ calendarId: z.string(), eventId: z.string(), event: eventPatch }), req.body);
    const ev = await accounts
      .require(req.user.id, req.params.accountId, 'calendar')
      .updateEvent(body.calendarId, body.eventId, body.event as Partial<EventInput>);
    ctx.bus.publish(req.user.id, { type: 'calendar.changed', accountId: req.params.accountId });
    return ev;
  });

  app.get<AccParams & { Querystring: { calendarId: string; eventId: string } }>('/api/calendar/accounts/:accountId/events/item', async (req) => {
    const q = parse(z.object({ calendarId: z.string(), eventId: z.string() }), req.query);
    const cal = accounts.require(req.user.id, req.params.accountId, 'calendar');
    if (!cal.getEvent) throw new BadRequestError('Einzelabruf von Terminen wird von diesem Konto nicht unterstützt');
    return cal.getEvent(q.calendarId, q.eventId);
  });

  app.delete<AccParams & { Querystring: { calendarId: string; eventId: string } }>('/api/calendar/accounts/:accountId/events', async (req) => {
    await accounts.require(req.user.id, req.params.accountId, 'calendar').deleteEvent(req.query.calendarId, req.query.eventId);
    ctx.bus.publish(req.user.id, { type: 'calendar.changed', accountId: req.params.accountId });
    return { ok: true };
  });

  app.post<AccParams>('/api/calendar/accounts/:accountId/events/respond', async (req) => {
    const body = parse(
      z.object({ calendarId: z.string(), eventId: z.string(), response: z.enum(['accept', 'tentative', 'decline']), comment: z.string().optional() }),
      req.body,
    );
    const cal = accounts.require(req.user.id, req.params.accountId, 'calendar');
    if (!cal.respondToEvent) throw new BadRequestError('Antworten auf Einladungen wird nicht unterstützt');
    await cal.respondToEvent(body.calendarId, body.eventId, body.response, body.comment);
    ctx.bus.publish(req.user.id, { type: 'calendar.changed', accountId: req.params.accountId });
    return { ok: true };
  });

  /* ═════════════════════════════ Online-Meetings (Teams/Meet) ═════════════════════════════ */

  app.get('/api/meetings/accounts', async (req) =>
    accounts.withCapability(req.user.id, 'meetings').map((a) => accounts.toInfo(a)),
  );

  app.post<AccParams>('/api/meetings/accounts/:accountId', async (req) => {
    const body = parse(z.object({ subject: z.string().default('Besprechung'), start: z.string(), end: z.string() }), req.body);
    return accounts.require(req.user.id, req.params.accountId, 'meetings').createMeeting(body);
  });

  /* ═════════════════════════════ Kontakte ═════════════════════════════ */

  /** Kontaktquellen ohne Mailkonto (z. B. ein CRM), die der Benutzer eingerichtet hat */
  const sourcesFor = (userId: string): ContactSource[] => ctx.hooks.contactSources.filter((s) => s.available(userId));
  const sourceBook = (s: ContactSource): AddressBook => ({
    id: SOURCE_BOOK_ID,
    accountId: s.id,
    name: s.bookName,
    readOnly: true,
    sourceName: s.name,
    sourceColor: s.color,
  });
  const sourceContacts = async (userId: string, s: ContactSource, search: string | undefined, limit: number) => {
    const all = await s.listContacts(userId);
    return (search?.trim() ? all.filter((c) => contactMatches(c, search)) : all).slice(0, limit);
  };

  app.get('/api/contacts/addressbooks', async (req) => {
    const accs = accounts.withCapability(req.user.id, 'contacts');
    const { results, errors } = await settleByAccount(accs, (a) => accounts.providersFor(a as AccountRecord).contacts!.listAddressBooks());
    const addressBooks: AddressBook[] = [
      ...results.flatMap((r) => r.value.map((b) => ({ ...b, accountId: r.accountId }))),
      ...sourcesFor(req.user.id).map(sourceBook),
    ];
    return { addressBooks, errors };
  });

  app.get<{ Querystring: { accountId?: string; addressBookId?: string; search?: string; cursor?: string; limit?: string } }>(
    '/api/contacts',
    async (req) => {
      const q = req.query;
      const limit = Math.min(Number(q.limit ?? 200) || 200, 1000);
      const sources = sourcesFor(req.user.id).filter((s) => !q.accountId || s.id === q.accountId);
      if (q.accountId && sources.length) {
        return { items: await sourceContacts(req.user.id, sources[0]!, q.search, limit), nextCursor: null };
      }
      if (q.accountId && q.addressBookId) {
        return accounts
          .require(req.user.id, q.accountId, 'contacts')
          .listContacts(q.addressBookId, { search: q.search, cursor: q.cursor, limit });
      }
      const accs = accounts.withCapability(req.user.id, 'contacts').filter((a) => !q.accountId || a.id === q.accountId);
      const { results, errors } = await settleByAccount(accs, async (a) => {
        const c = accounts.providersFor(a as AccountRecord).contacts!;
        const books = await c.listAddressBooks();
        const pages = await Promise.all(books.map((b) => c.listContacts(b.id, { search: q.search, limit })));
        return pages.flatMap((p) => p.items);
      });
      const fromSources = await settleByAccount(sources, (s) => sourceContacts(req.user.id, s, q.search, limit));
      const items: Contact[] = [
        ...results.flatMap((r) => r.value.map((c) => ({ ...c, accountId: r.accountId }))),
        ...fromSources.results.flatMap((r) => r.value),
      ].sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
      return { items, nextCursor: null, errors: [...errors, ...fromSources.errors] };
    },
  );

  app.post<AccParams>('/api/contacts/accounts/:accountId', async (req) => {
    const body = parse(z.object({ addressBookId: z.string(), contact: contactInput }), req.body);
    return accounts.require(req.user.id, req.params.accountId, 'contacts').createContact(body.addressBookId, body.contact);
  });

  app.put<AccParams>('/api/contacts/accounts/:accountId', async (req) => {
    const body = parse(z.object({ addressBookId: z.string(), contactId: z.string(), contact: contactInput }), req.body);
    return accounts.require(req.user.id, req.params.accountId, 'contacts').updateContact(body.addressBookId, body.contactId, body.contact);
  });

  app.delete<AccParams & { Querystring: { addressBookId: string; contactId: string } }>('/api/contacts/accounts/:accountId', async (req) => {
    await accounts.require(req.user.id, req.params.accountId, 'contacts').deleteContact(req.query.addressBookId, req.query.contactId);
    return { ok: true };
  });

  /** Adress-Autovervollständigung: zuletzt verwendet + Kontakte + Verzeichnis */
  app.get<{ Querystring: { q: string } }>('/api/contacts/autocomplete', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return [];
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const recent = (
      getDb()
        .prepare(
          `SELECT address, name FROM recent_addresses WHERE user_id = ? AND (address LIKE ? OR name LIKE ?)
           ORDER BY count DESC, last_used DESC LIMIT 8`,
        )
        .all(req.user.id, like, like) as { address: string; name: string | null }[]
    ).map<AddressSuggestion>((r) => ({ address: r.address, name: r.name ?? undefined, source: 'recent' }));

    const accs = accounts.withCapability(req.user.id, 'contacts');
    const timeout = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    // Parallel zu den Konten anfragen
    const sourcesPending = settleByAccount(sourcesFor(req.user.id), async (s) => {
      const list = s.suggest
        ? await timeout(s.suggest(req.user.id, q, 8), 2500)
        : (await timeout(sourceContacts(req.user.id, s, q, 8), 2500)).flatMap((ct) =>
            ct.emails.map<AddressSuggestion>((e) => ({ address: e.address, name: ct.displayName, source: 'contact', accountId: s.id })),
          );
      return list.map((x) => ({ ...x, label: x.label ?? s.name }));
    });
    const { results } = await settleByAccount(accs, async (a) => {
      const c = accounts.providersFor(a as AccountRecord).contacts!;
      if (c.suggest) return timeout(c.suggest(q, 8), 2500);
      const books = await timeout(c.listAddressBooks(), 2500);
      const pages = await Promise.all(books.slice(0, 3).map((b) => timeout(c.listContacts(b.id, { search: q, limit: 8 }), 2500)));
      return pages
        .flatMap((p) => p.items)
        .flatMap((ct) => ct.emails.map<AddressSuggestion>((e) => ({ address: e.address, name: ct.displayName, source: 'contact', accountId: a.id })));
    });
    // Quellen ohne Mailkonto stehen hinten: Einträge aus den eigenen Adressbüchern haben Vorrang
    const fromSources = await sourcesPending;
    const seen = new Set<string>();
    const out: AddressSuggestion[] = [];
    for (const s of [...recent, ...results.flatMap((r) => r.value), ...fromSources.results.flatMap((r) => r.value)]) {
      const key = s.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 15) break;
    }
    return out;
  });

  /* ═════════════════════════════ Aufgaben ═════════════════════════════ */

  app.get('/api/tasks/lists', async (req) => {
    const accs = accounts.withCapability(req.user.id, 'tasks');
    const { results, errors } = await settleByAccount(accs, (a) => accounts.providersFor(a as AccountRecord).tasks!.listTaskLists());
    const lists: TaskList[] = results.flatMap((r) => r.value.map((l) => ({ ...l, accountId: r.accountId })));
    return { lists, errors };
  });

  app.get<{ Querystring: { accountId: string; listId: string; showCompleted?: string } }>('/api/tasks', async (req) => {
    const tasks: Task[] = await accounts
      .require(req.user.id, req.query.accountId, 'tasks')
      .listTasks(req.query.listId, { showCompleted: req.query.showCompleted === 'true' });
    return tasks;
  });

  app.post<AccParams>('/api/tasks/accounts/:accountId', async (req) => {
    const body = parse(z.object({ listId: z.string(), task: taskInput }), req.body);
    return accounts.require(req.user.id, req.params.accountId, 'tasks').createTask(body.listId, body.task);
  });

  app.patch<AccParams>('/api/tasks/accounts/:accountId', async (req) => {
    const body = parse(z.object({ listId: z.string(), taskId: z.string(), task: taskInput }), req.body);
    return accounts.require(req.user.id, req.params.accountId, 'tasks').updateTask(body.listId, body.taskId, body.task);
  });

  app.delete<AccParams & { Querystring: { listId: string; taskId: string } }>('/api/tasks/accounts/:accountId', async (req) => {
    await accounts.require(req.user.id, req.params.accountId, 'tasks').deleteTask(req.query.listId, req.query.taskId);
    return { ok: true };
  });

  /* ═════════════════════════════ Cloud-Speicher ═════════════════════════════ */

  app.get<AccParams & { Querystring: { folderId?: string; search?: string } }>('/api/storage/accounts/:accountId/items', async (req) => {
    const s = accounts.require(req.user.id, req.params.accountId, 'storage');
    if (req.query.search) {
      if (!s.search) throw new BadRequestError('Suche wird nicht unterstützt');
      return s.search(req.query.search);
    }
    return s.list(req.query.folderId || null);
  });

  app.get<AccParams & { Querystring: { itemId: string } }>('/api/storage/accounts/:accountId/download', async (req, reply) => {
    const file = await accounts.require(req.user.id, req.params.accountId, 'storage').download(req.query.itemId);
    return sendFile(reply, file);
  });

  /** Datei aus der Cloud als Mail-Anhang übernehmen → Upload-ID */
  app.post<AccParams>('/api/storage/accounts/:accountId/attach', async (req) => {
    const body = parse(z.object({ itemId: z.string() }), req.body);
    const file = await accounts.require(req.user.id, req.params.accountId, 'storage').download(body.itemId);
    return uploads.save(req.user.id, file.filename, file.contentType, file.data);
  });

  /** Freigabelink erzeugen (statt Anhang) */
  app.post<AccParams>('/api/storage/accounts/:accountId/share', async (req) => {
    const body = parse(z.object({ itemId: z.string(), expiresDays: z.number().optional(), password: z.string().optional() }), req.body);
    const s = accounts.require(req.user.id, req.params.accountId, 'storage');
    if (!s.createShareLink) throw new BadRequestError('Freigabelinks werden nicht unterstützt');
    return s.createShareLink(body.itemId, { expiresDays: body.expiresDays, password: body.password });
  });

  /** Upload (aus Composer) direkt in die Cloud hochladen – z. B. für große Dateien */
  app.post<AccParams>('/api/storage/accounts/:accountId/upload-from-upload', async (req) => {
    const body = parse(z.object({ uploadId: z.string(), folderId: z.string().nullable().optional() }), req.body);
    const u = uploads.get(req.user.id, body.uploadId);
    return accounts.require(req.user.id, req.params.accountId, 'storage').upload(body.folderId, u.filename, u.data, u.contentType);
  });

  /** Mail-Anhang in der Cloud speichern */
  app.post<AccParams>('/api/storage/accounts/:accountId/save-attachment', async (req) => {
    const body = parse(
      z.object({
        folderId: z.string().nullable().optional(),
        mail: z.object({ accountId: z.string(), folderId: z.string(), messageId: z.string(), attachmentId: z.string() }),
      }),
      req.body,
    );
    const file = await accounts
      .require(req.user.id, body.mail.accountId, 'mail')
      .getAttachment(body.mail.folderId, body.mail.messageId, body.mail.attachmentId);
    return accounts.require(req.user.id, req.params.accountId, 'storage').upload(body.folderId, file.filename, file.data, file.contentType);
  });
}
