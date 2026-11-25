/**
 * Benachrichtigungen:
 *  - neue Mails per Polling (Graph/Gmail-History/IMAP-STATUS) und IMAP IDLE (Push)
 *  - Echtzeit an offene Browser-Tabs (SSE) und Web Push an jedes abonnierte Gerät;
 *    der Service Worker zeigt nichts an, wenn auf dem Gerät ein Kuvert-Fenster sichtbar ist
 *  - Terminerinnerungen aus allen Kalendern
 */
import { z } from 'zod';
import type { CalendarEvent, MessageSummary } from '@kuvert/shared';
import { config } from '../../config.js';
import { runInBackground } from '../../core/background.js';
import { defineModule, type AccountRecord, type ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { parse } from '../../routes/util.js';
import { initVapid, migrations, pushStore } from './push.js';

let ctxRef: ModuleContext | null = null;

/** Link in den Web-Client (gleiches Format wie web/src/features/mail/links.ts) */
function messageUrl(accountId: string, folderId: string, id: string): string {
  const b = (v: string) => Buffer.from(v, 'utf8').toString('base64url');
  return `/mail/f/${accountId}/${b(folderId)}?m=${[accountId, folderId, id].map(b).join('.')}`;
}
let pollTimer: NodeJS.Timeout | null = null;
let reminderTimer: NodeJS.Timeout | null = null;
const polling = new Set<string>();
const watchers = new Map<string, () => void>();
const debounce = new Map<string, NodeJS.Timeout>();
/** Zuletzt gemeldete Nachrichten-IDs je Konto (neueste zuerst) */
const announced = new Map<string, string[]>();

/* ═════════════════════════════ Neue Mails ═════════════════════════════ */

async function pollAccount(acc: AccountRecord) {
  const ctx = ctxRef!;
  if (polling.has(acc.id)) return;
  polling.add(acc.id);
  try {
    const mail = ctx.accounts.providersFor(acc).mail;
    if (!mail?.pollInbox) return;
    const prev = ctx.kv.get<string>('poll', acc.id);
    const { state, newMessages } = await mail.pollInbox(prev);
    ctx.kv.set('poll', acc.id, state);
    if (!prev || !newMessages.length) return;
    // Jede Mail nur einmal melden – auch falls ein Provider sie erneut als neu liefert
    const already = announced.get(acc.id) ?? [];
    const fresh = newMessages.filter((m) => !already.includes(m.id));
    if (!fresh.length) return;
    announced.set(acc.id, [...fresh.map((m) => m.id), ...already].slice(0, 500));
    const folderId = (await mail.getSpecialFolderId('inbox')) ?? '';
    const messages = fresh.slice(0, 20).map((m) => ({ ...m, accountId: acc.id }));
    await notifyNewMail(acc, folderId, messages);
  } catch (err) {
    ctx.log.debug({ err, accountId: acc.id }, 'Polling fehlgeschlagen');
  } finally {
    polling.delete(acc.id);
  }
}

async function notifyNewMail(acc: AccountRecord, folderId: string, messages: MessageSummary[]) {
  const ctx = ctxRef!;
  for (const h of ctx.hooks.newMail) {
    try {
      await h({ userId: acc.userId, accountId: acc.id, folderId, messages });
    } catch (err) {
      ctx.log.warn({ err }, 'newMail-Hook fehlgeschlagen');
    }
  }
  if (acc.settings.notify === false) {
    ctx.bus.publish(acc.userId, { type: 'mail.changed', accountId: acc.id, folderId });
    return;
  }
  ctx.bus.publish(acc.userId, { type: 'mail.new', accountId: acc.id, folderId, messages });
  // Web Push an alle Geräte – unabhängig davon, ob irgendwo ein Tab offen ist. Ob angezeigt wird,
  // entscheidet der Service Worker je Gerät (nicht, wenn dort ein Kuvert-Fenster sichtbar ist).
  if (pushStore.hasSubscriptions(acc.userId)) {
    const first = messages[0]!;
    await pushStore.send(acc.userId, {
      title: messages.length > 1 ? `${messages.length} neue Nachrichten – ${acc.name}` : (first.from?.name || first.from?.address || 'Neue Nachricht'),
      body: messages.length > 1 ? messages.slice(0, 3).map((m) => `• ${m.subject}`).join('\n') : first.subject,
      url: messageUrl(acc.id, folderId, first.id),
      tag: `mail-${acc.id}`,
    });
  }
}

function mailAccounts(): AccountRecord[] {
  const ctx = ctxRef!;
  return ctx.accounts.listAllEnabled().filter((a) => ctx.accounts.capabilities(a).includes('mail'));
}

/** Automatisches Polling läuft als Hintergrundarbeit (nachrangig gegenüber der Oberfläche) */
function pollInBackground(acc: AccountRecord) {
  return runInBackground(() => pollAccount(acc));
}

async function pollAll() {
  await Promise.all(mailAccounts().map((a) => pollInBackground(a)));
}

/** IMAP IDLE & Co.: bei Änderungen sofort (entprellt) pollen */
async function startWatcher(acc: AccountRecord) {
  const ctx = ctxRef!;
  stopWatcher(acc.id);
  if (!acc.enabled || !ctx.accounts.capabilities(acc).includes('mail')) return;
  try {
    const mail = ctx.accounts.providersFor(acc).mail;
    if (!mail?.watchInbox) return;
    const stop = await mail.watchInbox(() => {
      clearTimeout(debounce.get(acc.id));
      debounce.set(
        acc.id,
        setTimeout(() => {
          const fresh = ctx.accounts.findById(acc.id);
          if (fresh?.enabled) void pollInBackground(fresh);
        }, 1500),
      );
    });
    watchers.set(acc.id, stop);
  } catch (err) {
    ctx.log.debug({ err, accountId: acc.id }, 'Push-Überwachung nicht möglich – nutze Polling');
  }
}

function stopWatcher(accountId: string) {
  const stop = watchers.get(accountId);
  watchers.delete(accountId);
  clearTimeout(debounce.get(accountId));
  try {
    stop?.();
  } catch {
    /* egal */
  }
}

/* ═════════════════════════════ Terminerinnerungen ═════════════════════════════ */

const eventCache = new Map<string, { loaded: number; events: CalendarEvent[] }>();
const notified = new Map<string, number>();

async function loadUpcoming(userId: string): Promise<CalendarEvent[]> {
  const ctx = ctxRef!;
  const cached = eventCache.get(userId);
  if (cached && Date.now() - cached.loaded < 10 * 60_000) return cached.events;
  const start = new Date(Date.now() - 5 * 60_000).toISOString();
  const end = new Date(Date.now() + 26 * 3600_000).toISOString();
  const events: CalendarEvent[] = [];
  for (const acc of ctx.accounts.withCapability(userId, 'calendar')) {
    try {
      const cal = ctx.accounts.providersFor(acc).calendar!;
      for (const c of await cal.listCalendars()) {
        const list = await cal.listEvents(c.id, { start, end });
        events.push(...list.map((e) => ({ ...e, accountId: acc.id })));
      }
    } catch (err) {
      ctx.log.debug({ err, accountId: acc.id }, 'Kalender für Erinnerungen nicht lesbar');
    }
  }
  eventCache.set(userId, { loaded: Date.now(), events });
  return events;
}

async function checkReminders() {
  const ctx = ctxRef!;
  const userIds = new Set(ctx.accounts.listAllEnabled().map((a) => a.userId));
  const now = Date.now();
  for (const userId of userIds) {
    const settings = users.getSettings(userId);
    if (!settings.notifications.calendarReminders) continue;
    const online = ctx.bus.hasListeners(userId);
    if (!online && !pushStore.hasSubscriptions(userId)) continue;
    const events = await loadUpcoming(userId);
    for (const ev of events) {
      if (ev.allDay || ev.status === 'cancelled' || ev.myResponse === 'declined') continue;
      if (ev.reminderMinutes === null) continue;
      const minutes = ev.reminderMinutes ?? 15;
      const startMs = new Date(ev.start).getTime();
      const remindAt = startMs - minutes * 60_000;
      const key = `${userId}|${ev.accountId}|${ev.id}|${ev.start}`;
      if (now < remindAt || now > startMs || notified.has(key)) continue;
      notified.set(key, startMs);
      ctx.bus.publish(userId, { type: 'calendar.reminder', event: ev, minutesBefore: minutes });
      if (pushStore.hasSubscriptions(userId)) {
        const time = new Date(ev.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        await pushStore.send(userId, {
          title: ev.title || 'Termin',
          body: `${time}${ev.location ? ` · ${ev.location}` : ''}`,
          url: '/calendar',
          tag: `event-${ev.id}`,
          requireInteraction: true,
        });
      }
    }
  }
  for (const [k, startMs] of notified) if (startMs < now - 3600_000) notified.delete(k);
}

/* ═════════════════════════════ Modul ═════════════════════════════ */

export default defineModule({
  id: 'notifications',
  name: 'Benachrichtigungen',
  description: 'Neue Mails (Polling/IDLE), Web Push und Terminerinnerungen',
  features: ['push'],
  migrations,

  init(ctx) {
    ctxRef = ctx;
    initVapid();

    // Erste Runde verzögert, danach im Intervall
    setTimeout(() => void pollAll(), 5_000).unref();
    pollTimer = setInterval(() => void pollAll(), Math.max(15, config.pollIntervalSec) * 1000);
    reminderTimer = setInterval(() => void checkReminders().catch((err) => ctx.log.warn({ err }, 'Erinnerungen fehlgeschlagen')), 30_000);

    setTimeout(() => {
      for (const acc of mailAccounts()) void startWatcher(acc);
    }, 3_000).unref();

    ctx.bus.internal.on('account.created', (acc) => {
      void pollInBackground(acc);
      void startWatcher(acc);
    });
    ctx.bus.internal.on('account.updated', (acc) => {
      // Provider wurde ggf. neu erzeugt → Überwachung neu starten
      setTimeout(() => void startWatcher(acc), 500);
    });
    ctx.bus.internal.on('account.deleted', (acc) => {
      stopWatcher(acc.id);
      announced.delete(acc.id);
      ctx.kv.delete('poll', acc.id);
      eventCache.delete(acc.userId);
    });
    ctx.bus.internal.on('user.event', (userId, e) => {
      if (e.type === 'calendar.changed') eventCache.delete(userId);
    });
  },

  shutdown() {
    if (pollTimer) clearInterval(pollTimer);
    if (reminderTimer) clearInterval(reminderTimer);
    for (const id of [...watchers.keys()]) stopWatcher(id);
  },

  routes(app, ctx) {
    app.get('/vapid', async () => ({ publicKey: pushStore.publicKey() }));

    app.post('/push/subscribe', async (req) => {
      const body = parse(
        z.object({
          subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
        }),
        req.body,
      );
      pushStore.subscribe(req.user.id, body.subscription, req.headers['user-agent']);
      return { ok: true };
    });

    app.post('/push/unsubscribe', async (req) => {
      const body = parse(z.object({ endpoint: z.string() }), req.body);
      pushStore.unsubscribe(req.user.id, body.endpoint);
      return { ok: true };
    });

    /** Testbenachrichtigung (Web Push an alle Geräte des Benutzers) */
    app.post('/test', async (req) => {
      const sent = await pushStore.send(req.user.id, { title: 'Kuvert', body: 'Testbenachrichtigung – alles funktioniert 🎉', url: '/settings/notifications', tag: 'test' });
      return { ok: true, sent };
    });

    /** Manuell alle Konten abfragen (z. B. "Jetzt abrufen") */
    app.post('/poll', async (req) => {
      await Promise.all(ctx.accounts.withCapability(req.user.id, 'mail').map((a) => pollAccount(a)));
      return { ok: true };
    });
  },
});
