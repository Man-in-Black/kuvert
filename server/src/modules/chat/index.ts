/**
 * Team-Chat zwischen Kuvert-Benutzern: Direktnachrichten und Gruppen,
 * Echtzeit über SSE (Nachrichten, Tippen, Lesestatus, Online-Status),
 * Web Push an alle abonnierten Geräte, Dateien, Reaktionen, Antworten.
 *
 * Zusätzlich lassen sich Mattermost und Nextcloud Talk anbinden (bridges/):
 * deren Unterhaltungen laufen über dieselben Routen und erscheinen in derselben
 * Oberfläche – IDs mit dem Präfix "x~" werden an die jeweilige Brücke weitergereicht.
 *
 * Abschalten: KUVERT_DISABLED_MODULES=chat · nur die Anbindungen: CHAT_BRIDGES=false
 */
import { z } from 'zod';
import { DEFAULT_CHAT_SETTINGS, mentionHandle, mentionsHandle, type ChatConversation, type ChatMessage, type ChatRing, type ChatSettings, type ChatUser, type ServerEvent } from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { defineModule, type ModuleContext } from '../../core/module.js';
import { uploads } from '../../core/uploads.js';
import { users } from '../../core/users.js';
import { parse, sendFile } from '../../routes/util.js';
import { pushStore } from '../notifications/push.js';
import { bridgeMigrations, extPrefs, isExternalId, parseExtId, previewText as extPreview } from './bridges/common.js';
import { gifFile } from './bridges/gif.js';
import { BridgeManager } from './bridges/manager.js';
import { MAX_ATTACHMENTS, MAX_BODY, PAGE_SIZE, chatStore, migrations } from './store.js';

let ctxRef: ModuleContext | null = null;
let manager: BridgeManager | null = null;

const bridgesEnabled = () => process.env.CHAT_BRIDGES !== 'false';

function bridges(): BridgeManager {
  if (!manager) throw new AppError(503, 'chat_bridges_disabled', 'Die Anbindung von Mattermost/Nextcloud Talk/Teams ist nicht aktiv');
  return manager;
}

/** Externe Unterhaltung: Brücke + entfernte ID */
function extConv(userId: string, id: string) {
  const bridge = bridges().forId(userId, id);
  return { bridge, remote: parseExtId(id, 1).parts[0]! };
}

/** Externe Nachricht: Brücke + entfernte Unterhaltung/Nachricht */
function extMsg(userId: string, id: string) {
  const bridge = bridges().forId(userId, id);
  const [conv, msg] = parseExtId(id, 2).parts as [string, string];
  return { bridge, conv, msg, conversationId: bridge.convId(conv) };
}
let cleanupTimer: NodeJS.Timeout | null = null;
const offlineTimers = new Map<string, NodeJS.Timeout>();

/* ───────────────────────────── Hilfsfunktionen ───────────────────────────── */

function chatSettings(userId: string): ChatSettings {
  const stored = users.getSettings(userId).modules?.chat as Partial<ChatSettings> | undefined;
  return { ...DEFAULT_CHAT_SETTINGS, ...(stored ?? {}) };
}

function publishTo(userIds: Iterable<string>, event: ServerEvent) {
  for (const id of userIds) ctxRef!.bus.publish(id, event);
}

function publishToMembers(conversationId: string, event: ServerEvent, except?: string) {
  publishTo(
    chatStore.memberIds(conversationId).filter((id) => id !== except),
    event,
  );
}

function publishMessage(message: ChatMessage) {
  publishToMembers(message.conversationId, { type: 'chat.message', conversationId: message.conversationId, message });
}

function previewText(m: ChatMessage): string {
  const text = m.body
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (m.attachments.length === 1) return `📎 ${m.attachments[0]!.filename}`;
  if (m.attachments.length > 1) return `📎 ${m.attachments.length} Dateien`;
  return '';
}

/** Web Push an alle Geräte der Mitglieder (sofern das Benachrichtigungsmodul aktiv ist); der Service Worker
 *  unterdrückt die Anzeige, wenn auf dem Gerät ein Kuvert-Fenster sichtbar ist */
async function pushNewMessage(message: ChatMessage) {
  const ctx = ctxRef!;
  if (message.kind !== 'text' || !message.senderId) return;
  if (!ctx.registry.modules.some((m) => m.id === 'notifications')) return;
  const conv = chatStore.conversationRow(message.conversationId);
  const sender = users.get(message.senderId);
  for (const userId of chatStore.memberIds(message.conversationId)) {
    if (userId === message.senderId) continue;
    const member = chatStore.member(message.conversationId, userId);
    if (!member || !chatSettings(userId).notify) continue;
    // Stummgeschaltet: nur bei Erwähnung (@name, @all …)
    if (member.muted && !mentionsHandle(message.body, mentionHandle(users.get(userId)?.email))) continue;
    if (!pushStore.hasSubscriptions(userId)) continue;
    try {
      await pushStore.send(userId, {
        title: conv.kind === 'group' ? `${sender?.name ?? 'Jemand'} in ${conv.name ?? 'Gruppe'}` : (sender?.name ?? 'Neue Chatnachricht'),
        body: previewText(message),
        url: `/chat/${message.conversationId}`,
        tag: `chat-${message.conversationId}`,
      });
    } catch (err) {
      ctx.log.debug({ err }, 'Chat-Push fehlgeschlagen');
    }
  }
}

/** Web Push für eine Nachricht aus Mattermost/Talk (nur der eigene Benutzer der Verbindung) */
async function pushExternal(userId: string, message: ChatMessage, info: { kind: 'direct' | 'group'; title: string; sender: string }) {
  const ctx = ctxRef!;
  if (!ctx.registry.modules.some((m) => m.id === 'notifications')) return;
  if (!chatSettings(userId).notify) return;
  // Stummgeschaltet: nur bei Erwähnung
  if (extPrefs.get(userId, message.conversationId).muted && !message.mention) return;
  // Wie in Mattermost/Talk selbst: in Gruppen und Kanälen nur bei Erwähnung
  if (info.kind === 'group' && !message.mention) return;
  if (!pushStore.hasSubscriptions(userId)) return;
  try {
    await pushStore.send(userId, {
      title: info.kind === 'group' ? `${info.sender} in ${info.title}` : info.sender,
      body: extPreview(message),
      url: `/chat/${message.conversationId}`,
      tag: `chat-${message.conversationId}`,
    });
  } catch (err) {
    ctx.log.debug({ err }, 'Chat-Push (extern) fehlgeschlagen');
  }
}

/** Web Push bei einem eingehenden oder verpassten Anruf (Mattermost, Talk, Teams) */
async function pushRing(userId: string, conversationId: string, info: ChatRing) {
  const ctx = ctxRef!;
  if (!ctx.registry.modules.some((m) => m.id === 'notifications')) return;
  if (!chatSettings(userId).notify || extPrefs.get(userId, conversationId).muted) return;
  if (!pushStore.hasSubscriptions(userId)) return;
  try {
    await pushStore.send(userId, {
      ...(info.missed
        ? { title: `Verpasster Anruf von ${info.caller}`, body: info.direct ? 'Zum Zurückrufen öffnen' : `In ${info.title}` }
        : {
            title: info.direct ? `📞 ${info.caller} ruft an` : `📞 ${info.caller} startet einen Anruf in ${info.title}`,
            body: 'Zum Beitreten öffnen',
          }),
      url: `/chat/${conversationId}`,
      // Gleicher Tag: "Verpasst" ersetzt auf dem Gerät die Klingel-Benachrichtigung
      tag: `chat-call-${conversationId}`,
    });
  } catch (err) {
    ctx.log.debug({ err }, 'Chat-Push (Anruf) fehlgeschlagen');
  }
}

/** Online-Status an alle verbundenen Benutzer melden (Abmelden leicht verzögert, damit Reloads nicht flackern) */
function onConnection(userId: string, online: boolean) {
  const ctx = ctxRef!;
  manager?.presence(userId, online);
  const pending = offlineTimers.get(userId);
  if (online) {
    if (pending) {
      clearTimeout(pending);
      offlineTimers.delete(userId);
      return; // war nie "offline" gemeldet
    }
    publishTo(ctx.bus.onlineUserIds().filter((id) => id !== userId), { type: 'chat.presence', userId, online: true });
    return;
  }
  const t = setTimeout(() => {
    offlineTimers.delete(userId);
    if (ctx.bus.hasListeners(userId)) return;
    publishTo(ctx.bus.onlineUserIds(), { type: 'chat.presence', userId, online: false });
  }, 8_000);
  t.unref();
  offlineTimers.set(userId, t);
}

/* ───────────────────────────── Schemas ───────────────────────────── */

const emojiSchema = z
  .string()
  .min(1)
  .max(16)
  .refine((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && !/\s/.test(s), 'Kein gültiges Emoji');

const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), userId: z.string().min(1), connectionId: z.string().max(64).nullish() }),
  z.object({
    kind: z.literal('group'),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).nullish(),
    memberIds: z.array(z.string()).max(500).default([]),
    connectionId: z.string().max(64).nullish(),
  }),
]);

const connectionSchema = z.object({
  type: z.enum(['mattermost', 'talk', 'teams']),
  label: z.string().trim().max(80).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  token: z.string().trim().max(500).optional(),
  fromAccountId: z.string().max(100).optional(),
});

/** Mattermost-Reaktionen können auch eigene Emojis (:name:) sein */
const extEmojiSchema = z.string().min(1).max(64).refine((s) => !/\s/.test(s), 'Kein gültiges Emoji');

const sendSchema = z.object({
  body: z.string().max(MAX_BODY).default(''),
  replyToId: z.string().nullish(),
  uploadIds: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
});

type IdParams = { Params: { id: string } };

function notExternal(id: string) {
  if (isExternalId(id)) throw new BadRequestError('In verbundenen Diensten bitte direkt im Dienst (Mattermost, Nextcloud Talk, Teams) ändern');
}

/* ───────────────────────────── Modul ───────────────────────────── */

export default defineModule({
  id: 'chat',
  name: 'Team-Chat',
  description: 'Direktnachrichten und Gruppen zwischen Kuvert-Benutzern mit Echtzeit, Dateien und Reaktionen',
  features: bridgesEnabled() ? ['chat', 'chatBridges'] : ['chat'],
  migrations: [...migrations, ...bridgeMigrations],

  init(ctx) {
    ctxRef = ctx;
    ctx.bus.internal.on('user.connection', onConnection);
    if (bridgesEnabled()) {
      manager = new BridgeManager(
        ctx,
        (userId, message, info) => void pushExternal(userId, message, info),
        (userId, conversationId, info) => void pushRing(userId, conversationId, info),
      );
      // Etwas verzögert, damit der Start nicht auf entfernte Server wartet
      setTimeout(() => manager?.startAll(), 3_000).unref();
    }
    const cleanup = () => {
      try {
        const n = chatStore.cleanupOrphans();
        if (n) ctx.log.info(`Chat: ${n} verwaiste Unterhaltung(en) entfernt`);
      } catch (err) {
        ctx.log.warn({ err }, 'Chat-Aufräumen fehlgeschlagen');
      }
    };
    setTimeout(cleanup, 10_000).unref();
    cleanupTimer = setInterval(cleanup, 6 * 3600_000);
    cleanupTimer.unref();
  },

  shutdown() {
    manager?.stopAll();
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const t of offlineTimers.values()) clearTimeout(t);
    offlineTimers.clear();
  },

  routes(app, ctx) {
    /* ─────────── Benutzer ─────────── */

    /** Alle Benutzer der Instanz mit Online-Status (Verzeichnis für neue Chats und Namen) */
    app.get('/users', async () => chatStore.directory(new Set(ctx.bus.onlineUserIds())));

    /* ─────────── Unterhaltungen ─────────── */

    app.get('/conversations', async (req): Promise<ChatConversation[]> => {
      const own = chatStore.list(req.user.id);
      if (!manager) return own;
      return [...own, ...(await manager.conversations(req.user.id))];
    });

    app.post('/conversations', async (req) => {
      const body = parse(createSchema, req.body);
      if (body.connectionId) {
        const bridge = bridges().get(req.user.id, body.connectionId);
        const conv =
          body.kind === 'direct'
            ? await bridge.openDirect(bridge.remoteUid(body.userId))
            : await bridge.createGroup(body.name, body.memberIds.map((id) => bridge.remoteUid(id)));
        publishTo([req.user.id], { type: 'chat.conversation', conversationId: conv.id });
        return bridges().withPrefs(req.user.id, conv);
      }
      if (body.kind === 'direct') {
        const { id, created } = chatStore.openDirect(req.user.id, body.userId);
        if (created) publishTo([req.user.id], { type: 'chat.conversation', conversationId: id });
        return chatStore.get(id, req.user.id);
      }
      const id = chatStore.createGroup(req.user.id, body);
      publishToMembers(id, { type: 'chat.conversation', conversationId: id });
      return chatStore.get(id, req.user.id);
    });

    app.get<IdParams>('/conversations/:id', async (req) => {
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        return bridges().withPrefs(req.user.id, await bridge.getConversation(remote));
      }
      return chatStore.get(req.params.id, req.user.id);
    });

    /** Mitglieder mit Namen (Detailansicht; bei verbundenen Diensten vom Dienst abgefragt) */
    app.get<IdParams>('/conversations/:id/participants', async (req): Promise<ChatUser[]> => {
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        return bridge.members(remote);
      }
      chatStore.requireMember(req.params.id, req.user.id);
      const ids = new Set(chatStore.memberIds(req.params.id));
      return chatStore.directory(new Set(ctx.bus.onlineUserIds())).filter((u) => ids.has(u.id));
    });

    app.patch<IdParams>('/conversations/:id', async (req) => {
      notExternal(req.params.id);
      const body = parse(z.object({ name: z.string().max(80).optional(), description: z.string().max(500).nullish() }), req.body);
      const sys = chatStore.update(req.params.id, req.user.id, body);
      if (sys) publishMessage(sys);
      publishToMembers(req.params.id, { type: 'chat.conversation', conversationId: req.params.id });
      return chatStore.get(req.params.id, req.user.id);
    });

    /** Persönliche Einstellungen: stummschalten, anheften */
    app.put<IdParams>('/conversations/:id/prefs', async (req) => {
      const body = parse(z.object({ muted: z.boolean().optional(), pinned: z.boolean().optional() }), req.body);
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        // Mattermost: angeheftet = Favorit beim Dienst; stummschalten bleibt in Kuvert
        if (body.pinned !== undefined && bridge.setFavorite) {
          await bridge.setFavorite(remote, body.pinned);
          extPrefs.set(req.user.id, req.params.id, { muted: body.muted });
          publishTo([req.user.id], { type: 'chat.categories', connectionId: bridge.conn.id });
        } else extPrefs.set(req.user.id, req.params.id, body);
        publishTo([req.user.id], { type: 'chat.conversation', conversationId: req.params.id });
        return bridges().withPrefs(req.user.id, await bridge.getConversation(remote));
      }
      chatStore.setPrefs(req.params.id, req.user.id, body);
      publishTo([req.user.id], { type: 'chat.conversation', conversationId: req.params.id });
      return chatStore.get(req.params.id, req.user.id);
    });

    app.post<IdParams>('/conversations/:id/members', async (req) => {
      notExternal(req.params.id);
      const body = parse(z.object({ userIds: z.array(z.string()).min(1).max(500) }), req.body);
      const { added, message } = chatStore.addMembers(req.params.id, req.user.id, body.userIds);
      if (message) publishMessage(message);
      if (added.length) publishToMembers(req.params.id, { type: 'chat.conversation', conversationId: req.params.id });
      return chatStore.get(req.params.id, req.user.id);
    });

    app.patch<{ Params: { id: string; userId: string } }>('/conversations/:id/members/:userId', async (req) => {
      notExternal(req.params.id);
      const body = parse(z.object({ role: z.enum(['owner', 'member']) }), req.body);
      chatStore.setRole(req.params.id, req.user.id, req.params.userId, body.role);
      publishToMembers(req.params.id, { type: 'chat.conversation', conversationId: req.params.id });
      return chatStore.get(req.params.id, req.user.id);
    });

    /** Mitglied entfernen; eigene ID = Gruppe verlassen */
    app.delete<{ Params: { id: string; userId: string } }>('/conversations/:id/members/:userId', async (req) => {
      const { id, userId } = req.params;
      notExternal(id);
      const before = chatStore.memberIds(id);
      const { deleted, message } = chatStore.removeMember(id, req.user.id, userId);
      publishTo([userId], { type: 'chat.conversation', conversationId: id, removed: true });
      if (deleted) {
        publishTo(before, { type: 'chat.conversation', conversationId: id, removed: true });
      } else {
        if (message) publishMessage(message);
        publishToMembers(id, { type: 'chat.conversation', conversationId: id });
      }
      return { ok: true };
    });

    /* ─────────── Nachrichten ─────────── */

    app.get<IdParams & { Querystring: { before?: string; beforeId?: string; limit?: string } }>('/conversations/:id/messages', async (req) => {
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        let beforeId: string | undefined;
        if (req.query.beforeId) {
          const m = extMsg(req.user.id, req.query.beforeId);
          if (m.conv !== remote) throw new BadRequestError('Nachricht gehört zu einer anderen Unterhaltung');
          beforeId = m.msg;
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), 200);
        return bridge.messages(remote, { beforeId, limit });
      }
      chatStore.requireMember(req.params.id, req.user.id);
      const before = req.query.before ? Number(req.query.before) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return chatStore.messages(req.params.id, {
        before: Number.isFinite(before) ? before : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
    });

    app.post<IdParams>('/conversations/:id/messages', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const body = parse(sendSchema, req.body);
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        const text = body.body.replace(/\s+$/, '');
        const uploadIds = [...new Set(body.uploadIds ?? [])];
        if (!text.trim() && !uploadIds.length) throw new BadRequestError('Leere Nachricht');
        let replyTo: string | null = null;
        if (body.replyToId) {
          const m = extMsg(req.user.id, body.replyToId);
          if (m.conv !== remote) throw new BadRequestError('Bezugsnachricht nicht gefunden');
          replyTo = m.msg;
        }
        const files = uploadIds.map((id) => uploads.get(req.user.id, id));
        const message = await bridge.send(remote, { body: text, replyTo, files });
        for (const id of uploadIds) uploads.delete(req.user.id, id);
        publishTo([req.user.id], { type: 'chat.message', conversationId: message.conversationId, message });
        return message;
      }
      const message = chatStore.send(req.params.id, req.user.id, body);
      publishMessage(message);
      // Lesestand des Absenders an die anderen melden (Lesebestätigungen)
      publishToMembers(req.params.id, { type: 'chat.read', conversationId: req.params.id, userId: req.user.id, seq: message.seq });
      void pushNewMessage(message).catch((err) => ctx.log.debug({ err }, 'Chat-Push fehlgeschlagen'));
      return message;
    });

    app.post<IdParams>('/conversations/:id/read', async (req) => {
      const body = parse(z.object({ seq: z.number().int().positive().optional() }), req.body ?? {});
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        try {
          await bridge.markRead(remote);
        } catch (err) {
          // Dienst lehnt ab (z. B. Teams-Chat einer fremden Organisation) → Lesestand nur in Kuvert merken
          req.log.info({ err, conversation: req.params.id }, 'Gelesen-Markieren beim Dienst fehlgeschlagen – nur in Kuvert gemerkt');
          extPrefs.set(req.user.id, req.params.id, { readUntil: new Date().toISOString() });
        }
        // Andere Tabs des Benutzers aktualisieren
        if (body.seq) publishTo([req.user.id], { type: 'chat.read', conversationId: req.params.id, userId: req.user.id, seq: body.seq });
        return { ok: true, seq: body.seq ?? null };
      }
      const seq = chatStore.markRead(req.params.id, req.user.id, body.seq);
      if (seq !== null) publishToMembers(req.params.id, { type: 'chat.read', conversationId: req.params.id, userId: req.user.id, seq });
      return { ok: true, seq };
    });

    /** "… schreibt" an die anderen Mitglieder (Client drosselt auf ca. alle 3 s) */
    app.post<IdParams>('/conversations/:id/typing', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      if (isExternalId(req.params.id)) {
        const { bridge, remote } = extConv(req.user.id, req.params.id);
        await bridge.typing(remote).catch(() => undefined);
        return { ok: true };
      }
      chatStore.requireMember(req.params.id, req.user.id);
      publishToMembers(req.params.id, { type: 'chat.typing', conversationId: req.params.id, userId: req.user.id }, req.user.id);
      return { ok: true };
    });

    app.patch<IdParams>('/messages/:id', async (req) => {
      const body = parse(z.object({ body: z.string().max(MAX_BODY) }), req.body);
      if (isExternalId(req.params.id)) {
        const { bridge, conv, msg } = extMsg(req.user.id, req.params.id);
        if (!body.body.trim()) throw new BadRequestError('Leere Nachricht – zum Entfernen bitte löschen');
        const message = await bridge.edit(conv, msg, body.body.replace(/\s+$/, ''));
        publishTo([req.user.id], { type: 'chat.message.updated', conversationId: message.conversationId, message });
        return message;
      }
      const message = chatStore.edit(req.params.id, req.user.id, body.body);
      publishToMembers(message.conversationId, { type: 'chat.message.updated', conversationId: message.conversationId, message });
      return message;
    });

    app.delete<IdParams>('/messages/:id', async (req) => {
      if (isExternalId(req.params.id)) {
        const { bridge, conv, msg } = extMsg(req.user.id, req.params.id);
        const message = await bridge.delete(conv, msg);
        publishTo([req.user.id], { type: 'chat.message.updated', conversationId: message.conversationId, message });
        return message;
      }
      const message = chatStore.delete(req.params.id, req.user.id);
      publishToMembers(message.conversationId, { type: 'chat.message.updated', conversationId: message.conversationId, message });
      return message;
    });

    /** Reaktion umschalten (gleiches Emoji erneut = entfernen) */
    app.post<IdParams>('/messages/:id/reactions', async (req) => {
      if (isExternalId(req.params.id)) {
        const { emoji } = parse(z.object({ emoji: extEmojiSchema }), req.body);
        const { bridge, conv, msg } = extMsg(req.user.id, req.params.id);
        const message = await bridge.react(conv, msg, emoji);
        publishTo([req.user.id], { type: 'chat.message.updated', conversationId: message.conversationId, message });
        return message;
      }
      const body = parse(z.object({ emoji: emojiSchema }), req.body);
      const message = chatStore.toggleReaction(req.params.id, req.user.id, body.emoji);
      publishToMembers(message.conversationId, { type: 'chat.message.updated', conversationId: message.conversationId, message });
      return message;
    });

    /** Volltextsuche in allen eigenen Unterhaltungen */
    app.get<{ Querystring: { q?: string } }>('/search', async (req) => {
      const q = (req.query.q ?? '').trim();
      if (q.length < 2) return [];
      const own = chatStore.search(req.user.id, q.slice(0, 200));
      if (!manager) return own;
      const ext = await manager.search(req.user.id, q.slice(0, 200));
      return [...own, ...ext].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 80);
    });

    /* ─────────── Dateien ─────────── */

    app.get<IdParams & { Querystring: { inline?: string } }>('/files/:id', async (req, reply) => {
      const inline = req.query.inline === '1';
      if (isExternalId(req.params.id)) {
        const bridge = bridges().forId(req.user.id, req.params.id);
        const ref = parseExtId(req.params.id, 1).parts[0]!;
        // GIFs aus Giphy/Tenor (Markdown-Bilder in Mattermost/Talk) – gleich für alle Dienste
        return sendFile(reply, (await gifFile(ref)) ?? (await bridge.file(ref, inline)), inline);
      }
      const file = chatStore.file(req.params.id, req.user.id);
      return sendFile(reply, file, inline);
    });

    /* ─────────── Verbundene Dienste (Mattermost, Nextcloud Talk) ─────────── */

    /** Profilbild einer Person eines verbundenen Dienstes */
    app.get<IdParams>('/ext/avatar/:id', async (req, reply) => {
      if (!isExternalId(req.params.id)) throw new NotFoundError('Avatar');
      const bridge = bridges().forId(req.user.id, req.params.id);
      const file = await bridge.avatar(parseExtId(req.params.id, 1).parts[0]!);
      return sendFile(reply, file, true);
    });

    app.get('/connections', async (req) => (manager ? manager.list(req.user.id) : []));

    /** Abschnitte der Seitenleiste verbundener Dienste (Mattermost: Favoriten, Kanäle, Direktnachrichten, eigene) */
    app.get('/categories', async (req) => (manager ? manager.categories(req.user.id) : []));

    app.post('/connections', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const body = parse(connectionSchema, req.body);
      const conn = await bridges().add(req.user.id, body);
      audit.log('chat.connection_added', { req, details: { type: conn.type, baseUrl: conn.baseUrl, username: conn.username } });
      publishTo([req.user.id], { type: 'chat.connection', connectionId: conn.id, status: conn.status });
      return conn;
    });

    app.patch<IdParams>('/connections/:id', async (req) => {
      const body = parse(z.object({ label: z.string().trim().min(1).max(80) }), req.body);
      return bridges().rename(req.user.id, req.params.id, body.label);
    });

    /** Verbindung neu aufbauen (z. B. nach einer Störung) */
    app.post<IdParams>('/connections/:id/restart', async (req) => bridges().restart(req.user.id, req.params.id));

    app.delete<IdParams>('/connections/:id', async (req) => {
      bridges().remove(req.user.id, req.params.id);
      audit.log('chat.connection_removed', { req, details: { id: req.params.id } });
      publishTo([req.user.id], { type: 'chat.connection', connectionId: req.params.id, status: 'ok' });
      return { ok: true };
    });

    /** Personen des Dienstes suchen (neue Unterhaltung) */
    app.get<IdParams & { Querystring: { q?: string } }>('/connections/:id/users', async (req): Promise<ChatUser[]> => {
      const q = (req.query.q ?? '').trim();
      if (q.length < 1) return [];
      return bridges().get(req.user.id, req.params.id).searchUsers(q.slice(0, 100));
    });
  },
});
