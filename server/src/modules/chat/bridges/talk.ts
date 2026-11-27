/**
 * Nextcloud-Talk-Brücke (OCS API von "spreed").
 * Anmeldung mit Benutzername + App-Passwort (auch aus einem vorhandenen Nextcloud-Konto).
 * Talk hat für REST-Clients keine Push-Verbindung: Die Raumliste wird regelmäßig abgefragt
 * (alle 10 s bei geöffnetem Browser, sonst jede Minute), gerade geöffnete Unterhaltungen
 * zusätzlich per Long-Polling – damit kommen Nachrichten dort praktisch sofort an.
 */
import crypto from 'node:crypto';
import type { ChatCapabilities, ChatConversation, ChatMember, ChatMessage, ChatMessagePage, ChatUser } from '@kuvert/shared';
import { AppError, AuthError, BadRequestError, HttpError, NotFoundError } from '../../../core/errors.js';
import { withQuery } from '../../../core/http.js';
import { nextcloudUserInfo } from '../../dav/storage.js';
import { BridgeBase, msToIso, type BinaryFile, type BridgeHost, type ChatBridge, type ConnectionRecord } from './common.js';

/* ───────────────────────────── Typen der API ───────────────────────────── */

interface TalkParam {
  type: string;
  id?: string;
  name?: string;
  path?: string;
  size?: string | number;
  mimetype?: string;
}

interface TalkMessage {
  id: number;
  token: string;
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  timestamp: number;
  message: string;
  messageParameters: Record<string, TalkParam> | [];
  systemMessage: string;
  messageType: string;
  reactions?: Record<string, number> | [];
  reactionsSelf?: string[];
  parent?: TalkMessage;
  lastEditTimestamp?: number;
}

interface TalkRoom {
  token: string;
  type: number;
  name: string;
  displayName: string;
  description?: string;
  lastActivity: number;
  lastMessage?: TalkMessage | [];
  unreadMessages: number;
  lastReadMessage: number;
  lastCommonReadMessage?: number;
  participantType: number;
  status?: string;
}

interface TalkParticipant {
  actorType: string;
  actorId: string;
  displayName: string;
  participantType: number;
  status?: string;
}

/** Systemnachrichten, die nur einen anderen Beitrag ändern (werden nicht angezeigt) */
const UPDATE_SYSTEM = new Set(['message_deleted', 'message_edited', 'reaction', 'reaction_revoked', 'reaction_deleted', 'poll_voted']);

interface RawInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  query?: Record<string, string | number | boolean | undefined>;
}

const FAST_POLL = 10_000;
const SLOW_POLL = 60_000;
const HOT_MS = 5 * 60_000;

export function normalizeNextcloudUrl(v: string): string {
  let s = v.trim();
  if (!s) throw new BadRequestError('Nextcloud-Adresse fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.replace(/\/(index\.php|remote\.php|apps|ocs|login|call)(\/.*)?$/i, '').replace(/\/+$/, '');
  } catch {
    throw new BadRequestError('Nextcloud-Adresse ist ungültig');
  }
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** OCS-Aufruf ohne Brücke (Einrichtung) */
async function ocsGet<T>(baseUrl: string, path: string, auth: string): Promise<T> {
  const res = await fetch(withQuery(`${baseUrl}/ocs/v2.php${path}`, { format: 'json' }), {
    headers: { Authorization: auth, 'OCS-APIRequest': 'true', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(res.status, `Nextcloud meldet ${res.status}`);
  return ((await res.json()) as { ocs: { data: T } }).ocs.data;
}

interface TalkFeatures {
  features: string[];
  attachmentsFolder: string;
}

async function loadFeatures(baseUrl: string, auth: string): Promise<TalkFeatures> {
  const caps = await ocsGet<{ capabilities?: { spreed?: { features?: string[]; config?: { attachments?: { folder?: string } } } } }>(baseUrl, '/cloud/capabilities', auth);
  const spreed = caps.capabilities?.spreed;
  if (!spreed) throw new BadRequestError('Nextcloud Talk ist auf diesem Server nicht installiert oder nicht freigegeben');
  return { features: spreed.features ?? [], attachmentsFolder: spreed.config?.attachments?.folder || '/Talk' };
}

export async function setupTalk(input: { baseUrl: string; username: string; password: string }) {
  const baseUrl = normalizeNextcloudUrl(input.baseUrl);
  const username = input.username.trim();
  if (!username || !input.password) throw new BadRequestError('Bitte Benutzername und App-Passwort angeben');
  let info: { id: string; displayName?: string };
  try {
    info = await nextcloudUserInfo(baseUrl, username, input.password);
  } catch (err) {
    if (err instanceof AppError && err.status === 401) throw new BadRequestError('Nextcloud-Anmeldung fehlgeschlagen – bitte Benutzername und App-Passwort prüfen');
    throw err;
  }
  const features = await loadFeatures(baseUrl, basic(username, input.password));
  return {
    baseUrl,
    username,
    displayName: info.displayName ?? username,
    remoteUserId: info.id,
    secrets: { password: input.password },
    config: { ...features },
  };
}

/* ───────────────────────────── Brücke ───────────────────────────── */

export class TalkBridge extends BridgeBase implements ChatBridge {
  capabilities: ChatCapabilities;
  private features: TalkFeatures;
  private rooms = new Map<string, TalkRoom>();
  /** Höchste verarbeitete Nachrichten-ID je Raum */
  private known = new Map<string, number>();
  private unread = new Map<string, number>();
  private hot = new Map<string, number>();
  private longPolls = new Set<string>();
  private cache = new Map<string, TalkMessage>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private initialized = false;
  private polling = false;

  constructor(conn: ConnectionRecord, host: BridgeHost) {
    super(conn, host);
    this.features = {
      features: Array.isArray(conn.config.features) ? (conn.config.features as string[]) : [],
      attachmentsFolder: typeof conn.config.attachmentsFolder === 'string' ? conn.config.attachmentsFolder : '/Talk',
    };
    this.capabilities = this.caps(false);
  }

  private caps(direct: boolean): ChatCapabilities {
    const f = new Set(this.features.features);
    return {
      edit: f.has('edit-messages'),
      delete: f.has('delete-messages') || f.has('rich-object-delete'),
      react: f.has('reactions'),
      reply: true,
      files: true,
      typing: false,
      readReceipts: direct && f.has('chat-read-status'),
      manage: false,
    };
  }

  private get base() {
    return this.conn.baseUrl;
  }

  private get auth() {
    return basic(this.conn.username, this.conn.secrets.password ?? '');
  }

  /* ─────────── HTTP ─────────── */

  private async raw(url: string, init: RawInit = {}) {
    const headers: Record<string, string> = { Authorization: this.auth, 'OCS-APIRequest': 'true', Accept: 'application/json', ...(init.headers ?? {}) };
    let body: RequestInit['body'] | undefined;
    if (init.body !== undefined) {
      if (typeof init.body === 'string' || init.body instanceof Uint8Array) body = init.body as RequestInit['body'];
      else {
        body = JSON.stringify(init.body);
        headers['Content-Type'] = 'application/json';
      }
    }
    let res: Response;
    try {
      res = await fetch(withQuery(url, init.query), { method: init.method ?? 'GET', headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
    } catch (err) {
      throw new HttpError(502, `Nextcloud nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      this.host.setStatus('error', 'Anmeldung bei Nextcloud fehlgeschlagen – App-Passwort prüfen');
      throw new AuthError('Anmeldung bei Nextcloud fehlgeschlagen – bitte die Talk-Verbindung neu einrichten');
    }
    return res;
  }

  private async ocs<T>(path: string, init: RawInit = {}): Promise<T> {
    const res = await this.raw(`${this.base}/ocs/v2.php${path}`, { ...init, query: { format: 'json', ...(init.query ?? {}) } });
    const json = (await res.json().catch(() => null)) as { ocs?: { meta?: { message?: string }; data?: T } } | null;
    if (!res.ok) throw new HttpError(res.status, json?.ocs?.meta?.message || `Nextcloud Talk meldet ${res.status}`);
    return json?.ocs?.data as T;
  }

  private dav(path: string): string {
    const segs = path.split('/').filter(Boolean).map(encodeURIComponent);
    return `${this.base}/remote.php/dav/files/${encodeURIComponent(this.conn.remoteUserId)}/${segs.join('/')}`;
  }

  /* ─────────── Abbildung ─────────── */

  private actorUid(m: { actorType: string; actorId: string }): string | null {
    if (!m.actorId) return null;
    return this.uid(m.actorType === 'users' ? m.actorId : `${m.actorType}/${m.actorId}`);
  }

  private params(m: TalkMessage): Record<string, TalkParam> {
    return Array.isArray(m.messageParameters) ? {} : (m.messageParameters ?? {});
  }

  /** Platzhalter {mention-user1}, {file} … durch Text ersetzen */
  private renderText(m: TalkMessage, system: boolean): string {
    const params = this.params(m);
    return m.message
      .replace(/\{([\w-]+)\}/g, (all, key: string) => {
        const p = params[key];
        if (!p) return all;
        if (!system && key === 'file' && p.type === 'file') return '';
        const name = p.name ?? p.id ?? '';
        if (system) return name;
        return key.startsWith('mention-') ? `@${name}` : name;
      })
      .trim();
  }

  private toMessage(m: TalkMessage): ChatMessage | null {
    if (UPDATE_SYSTEM.has(m.systemMessage)) return null;
    this.remember(m);
    const system = !!m.systemMessage;
    const deleted = m.messageType === 'comment_deleted';
    const file = this.params(m).file;
    const reactions = Array.isArray(m.reactions) || !m.reactions ? {} : m.reactions;
    const parent = m.parent && !Array.isArray(m.parent) ? m.parent : null;
    const mention = Object.values(this.params(m)).some(
      (p) => (p.type === 'user' && p.id === this.conn.remoteUserId) || p.type === 'call' || p.type === 'user-group',
    );
    return {
      id: this.msgId(m.token, String(m.id)),
      seq: m.id,
      conversationId: this.convId(m.token),
      senderId: system ? null : this.actorUid(m),
      kind: system ? 'system' : 'text',
      body: system ? JSON.stringify({ action: 'text', actorId: this.actorUid(m) ?? '', text: this.renderText(m, true) }) : deleted ? '' : this.renderText(m, false),
      createdAt: msToIso(m.timestamp * 1000),
      editedAt: m.lastEditTimestamp ? msToIso(m.lastEditTimestamp * 1000) : null,
      deleted,
      replyTo: parent
        ? {
            id: this.msgId(m.token, String(parent.id)),
            senderId: this.actorUid(parent),
            body: parent.messageType === 'comment_deleted' ? '' : this.renderText(parent, false).slice(0, 280),
            deleted: parent.messageType === 'comment_deleted',
            hasAttachments: !!this.params(parent).file,
          }
        : null,
      attachments:
        !deleted && file?.type === 'file'
          ? [
              {
                id: this.fileId(JSON.stringify({ p: file.path ?? file.name ?? '', i: file.id ?? '', n: file.name ?? 'Datei', m: file.mimetype ?? '' })),
                filename: file.name ?? 'Datei',
                contentType: file.mimetype || 'application/octet-stream',
                size: Number(file.size) || 0,
              },
            ]
          : [],
      reactions: deleted
        ? []
        : Object.entries(reactions).map(([emoji, count]) => ({ emoji, userIds: m.reactionsSelf?.includes(emoji) ? [this.me] : [], count })),
      senderName: m.actorDisplayName || null,
      mention: (!system && mention) || undefined,
    };
  }

  private remember(m: TalkMessage) {
    const key = `${m.token}/${m.id}`;
    this.cache.delete(key);
    this.cache.set(key, m);
    if (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value!);
  }

  private toConversation(r: TalkRoom): ChatConversation {
    const direct = r.type === 1 || r.type === 5;
    const last = r.lastMessage && !Array.isArray(r.lastMessage) ? this.toMessage(r.lastMessage) : null;
    const members: ChatMember[] = [
      { userId: this.me, role: r.participantType === 1 || r.participantType === 2 ? 'owner' : 'member', lastReadSeq: r.lastReadMessage ?? 0, joinedAt: msToIso(0) },
    ];
    const participants: ChatUser[] = [];
    if (direct && r.name && r.name !== this.conn.remoteUserId) {
      const id = this.uid(r.name)!;
      members.push({ userId: id, role: 'member', lastReadSeq: r.lastCommonReadMessage ?? 0, joinedAt: msToIso(0) });
      participants.push({ id, name: r.displayName, email: '', avatarUrl: this.avatarUrl(r.name), online: r.status === 'online' });
    }
    return {
      id: this.convId(r.token),
      kind: direct ? 'direct' : 'group',
      name: r.displayName || r.name,
      description: r.description || null,
      createdAt: msToIso(0),
      lastMessageAt: msToIso((r.lastActivity || 0) * 1000),
      members,
      lastMessage: last,
      unread: r.unreadMessages ?? 0,
      muted: false,
      pinned: false,
      myRole: members[0]!.role,
      source: this.source(null, `${this.base}/index.php/call/${r.token}`),
      // Anrufe laufen in Talk selbst; Änderungsprotokoll (4) und Notizen an mich (6) kennen keine Anrufe
      capabilities: { ...this.caps(direct), calls: r.type !== 4 && r.type !== 6 },
      memberCount: direct ? 2 : null,
      participants,
    };
  }

  /* ─────────── Unterhaltungen ─────────── */

  private async fetchRooms(): Promise<TalkRoom[]> {
    return this.ocs<TalkRoom[]>('/apps/spreed/api/v4/room', { query: { includeStatus: true } });
  }

  async listConversations(): Promise<ChatConversation[]> {
    const rooms = await this.fetchRooms();
    for (const r of rooms) this.rooms.set(r.token, r);
    return rooms.map((r) => this.toConversation(r));
  }

  async getConversation(token: string): Promise<ChatConversation> {
    const r = await this.ocs<TalkRoom>(`/apps/spreed/api/v4/room/${encodeURIComponent(token)}`).catch((err) => {
      if (err instanceof AppError && err.status === 404) throw new NotFoundError('Unterhaltung');
      throw err;
    });
    this.rooms.set(r.token, r);
    if (!this.known.has(r.token)) this.known.set(r.token, r.lastMessage && !Array.isArray(r.lastMessage) ? r.lastMessage.id : 0);
    return this.toConversation(r);
  }

  async members(token: string): Promise<ChatUser[]> {
    const list = await this.ocs<TalkParticipant[]>(`/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants`, { query: { includeStatus: true } });
    return list
      .filter((p) => p.actorType === 'users' || p.actorType === 'guests' || p.actorType === 'emails')
      .map((p) => ({
        id: this.actorUid(p)!,
        name: p.displayName || p.actorId,
        email: '',
        avatarUrl: p.actorType === 'users' ? this.avatarUrl(p.actorId) : null,
        online: p.status === 'online',
        // Talk: @id, bei Sonderzeichen @"id"
        mention: p.actorType === 'users' ? (/^[\w.-]+$/.test(p.actorId) ? p.actorId : `"${p.actorId}"`) : undefined,
      }));
  }

  /* ─────────── Nachrichten ─────────── */

  /** Chat-Abruf; 304 = keine (neuen) Nachrichten */
  private async chat(token: string, query: Record<string, string | number | boolean | undefined>, timeoutMs = 30_000): Promise<TalkMessage[]> {
    const res = await this.raw(`${this.base}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`, {
      query: { format: 'json', setReadMarker: 0, includeLastKnown: 0, ...query },
      timeoutMs,
    });
    if (res.status === 304) return [];
    const json = (await res.json().catch(() => null)) as { ocs?: { data?: TalkMessage[]; meta?: { message?: string } } } | null;
    if (!res.ok) throw new HttpError(res.status, json?.ocs?.meta?.message || `Nextcloud Talk meldet ${res.status}`);
    return json?.ocs?.data ?? [];
  }

  async messages(token: string, opts: { beforeId?: string; limit: number }): Promise<ChatMessagePage> {
    const items: ChatMessage[] = [];
    let before = opts.beforeId ? Number(opts.beforeId) : undefined;
    let hasMore = true;
    // Seiten mit lauter unsichtbaren Systemnachrichten (Reaktionen …) überspringen
    for (let round = 0; round < 4 && hasMore && items.length < Math.ceil(opts.limit / 2); round++) {
      const raw = await this.chat(token, { lookIntoFuture: 0, limit: opts.limit, lastKnownMessageId: before });
      hasMore = raw.length >= opts.limit;
      if (!raw.length) break;
      const sorted = raw.sort((a, b) => a.id - b.id);
      before = sorted[0]!.id;
      if (!opts.beforeId && round === 0) this.known.set(token, Math.max(this.known.get(token) ?? 0, sorted[sorted.length - 1]!.id));
      items.unshift(...sorted.map((m) => this.toMessage(m)).filter((m): m is ChatMessage => !!m));
    }
    if (!this.known.has(token)) this.known.set(token, items[items.length - 1]?.seq ?? 0);
    this.markHot(token);
    return { items, hasMore };
  }

  private async uploadFile(token: string, f: BinaryFile) {
    const folder = this.features.attachmentsFolder.replace(/\/+$/, '') || '/Talk';
    const dot = f.filename.lastIndexOf('.');
    const stem = dot > 0 ? f.filename.slice(0, dot) : f.filename;
    const ext = dot > 0 ? f.filename.slice(dot) : '';
    let name = f.filename.replace(/[/\\]/g, '_');
    for (let i = 2; i < 50; i++) {
      const res = await this.raw(this.dav(`${folder}/${name}`), {
        method: 'PUT',
        body: new Uint8Array(f.data),
        headers: { 'Content-Type': f.contentType || 'application/octet-stream', 'If-None-Match': '*' },
        timeoutMs: 120_000,
      });
      if (res.ok) break;
      if (res.status === 412) {
        name = `${stem} (${i})${ext}`.replace(/[/\\]/g, '_');
        continue;
      }
      if ((res.status === 404 || res.status === 409) && i === 2) {
        await this.raw(this.dav(folder), { method: 'MKCOL' });
        i--;
        continue;
      }
      throw new HttpError(res.status, `Datei konnte nicht in Nextcloud gespeichert werden (${res.status})`);
    }
    await this.ocs('/apps/files_sharing/api/v1/shares', {
      method: 'POST',
      body: { shareType: 10, shareWith: token, path: `${folder}/${name}`, talkMetaData: JSON.stringify({ messageType: 'comment' }) },
    });
  }

  async send(token: string, input: { body: string; replyTo?: string | null; files: BinaryFile[] }): Promise<ChatMessage> {
    this.markHot(token);
    for (const f of input.files) await this.uploadFile(token, f);
    if (input.body.trim()) {
      const m = await this.ocs<TalkMessage>(`/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: { message: input.body, replyTo: input.replyTo ? Number(input.replyTo) : undefined, referenceId: crypto.randomBytes(32).toString('hex') },
      });
      const msg = this.toMessage(m);
      if (msg) return msg;
    }
    // Nur Dateien: die von Talk erzeugte Nachricht holen
    const recent = await this.chat(token, { lookIntoFuture: 0, limit: 10 });
    const mine = recent
      .filter((m) => m.actorType === 'users' && m.actorId === this.conn.remoteUserId && !m.systemMessage)
      .sort((a, b) => b.id - a.id)[0];
    const msg = mine ? this.toMessage(mine) : null;
    if (!msg) throw new AppError(502, 'talk_send', 'Die Datei wurde geteilt, die Nachricht aber nicht gefunden');
    return msg;
  }

  private async getMessage(token: string, id: string): Promise<TalkMessage> {
    const cached = this.cache.get(`${token}/${id}`);
    if (cached) return cached;
    const list = await this.ocs<TalkMessage[]>(`/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/${encodeURIComponent(id)}/context`, { query: { limit: 1 } });
    const m = list.find((x) => String(x.id) === id);
    if (!m) throw new NotFoundError('Nachricht');
    return m;
  }

  private updated(sys: TalkMessage): ChatMessage {
    const target = sys.parent && !Array.isArray(sys.parent) ? sys.parent : sys;
    const msg = this.toMessage(target);
    if (!msg) throw new AppError(502, 'talk_update', 'Unerwartete Antwort von Nextcloud Talk');
    return msg;
  }

  async edit(token: string, messageId: string, body: string): Promise<ChatMessage> {
    if (!this.capabilities.edit) throw new BadRequestError('Diese Nextcloud-Version unterstützt kein Bearbeiten');
    return this.updated(await this.ocs<TalkMessage>(`/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/${encodeURIComponent(messageId)}`, { method: 'PUT', body: { message: body } }));
  }

  async delete(token: string, messageId: string): Promise<ChatMessage> {
    return this.updated(await this.ocs<TalkMessage>(`/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/${encodeURIComponent(messageId)}`, { method: 'DELETE' }));
  }

  async react(token: string, messageId: string, emoji: string): Promise<ChatMessage> {
    const path = `/apps/spreed/api/v1/reaction/${encodeURIComponent(token)}/${encodeURIComponent(messageId)}`;
    const current = await this.ocs<Record<string, { actorType: string; actorId: string }[]> | []>(path, { query: { reaction: emoji } }).catch(() => []);
    const list = Array.isArray(current) ? [] : (current[emoji] ?? []);
    const mine = list.some((a) => a.actorType === 'users' && a.actorId === this.conn.remoteUserId);
    const result = mine
      ? await this.ocs<Record<string, { actorType: string; actorId: string }[]> | []>(path, { method: 'DELETE', query: { reaction: emoji } })
      : await this.ocs<Record<string, { actorType: string; actorId: string }[]> | []>(path, { method: 'POST', body: { reaction: emoji } });
    const base = await this.getMessage(token, messageId);
    const map = Array.isArray(result) ? {} : result;
    const next: TalkMessage = {
      ...base,
      reactions: Object.fromEntries(Object.entries(map).map(([e, actors]) => [e, actors.length])),
      reactionsSelf: Object.entries(map)
        .filter(([, actors]) => actors.some((a) => a.actorType === 'users' && a.actorId === this.conn.remoteUserId))
        .map(([e]) => e),
    };
    return this.toMessage(next)!;
  }

  async markRead(token: string): Promise<void> {
    const last = this.known.get(token);
    await this.ocs(`/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/read`, { method: 'POST', body: last ? { lastReadMessage: last } : {} });
    this.unread.set(token, 0);
  }

  async typing(): Promise<void> {
    /* Talk meldet Tippen nur über das Signaling – nicht unterstützt */
  }

  async search(q: string): Promise<ChatMessage[]> {
    const data = await this.ocs<{ entries?: { title: string; subline: string; attributes?: { conversation?: string; messageId?: string } }[] }>(
      '/search/providers/talk-message/search',
      { query: { term: q, limit: 20 } },
    ).catch(() => ({ entries: [] }));
    const hits = (data.entries ?? []).filter((e) => e.attributes?.conversation && e.attributes.messageId).slice(0, 15);
    const out = await Promise.all(
      hits.map(async (e): Promise<ChatMessage | null> => {
        const token = e.attributes!.conversation!;
        const id = e.attributes!.messageId!;
        const m = await this.getMessage(token, id).catch(() => null);
        if (m) return this.toMessage(m);
        return {
          id: this.msgId(token, id),
          seq: Number(id) || 0,
          conversationId: this.convId(token),
          senderId: null,
          senderName: e.title,
          kind: 'text',
          body: e.subline,
          createdAt: new Date().toISOString(),
          deleted: false,
          attachments: [],
          reactions: [],
        };
      }),
    );
    return out.filter((m): m is ChatMessage => !!m);
  }

  async file(ref: string, inline: boolean): Promise<BinaryFile> {
    let f: { p: string; i: string; n: string; m: string };
    try {
      f = JSON.parse(ref);
    } catch {
      throw new NotFoundError('Datei');
    }
    // Nextcloud-Vorschauen sind Standbilder → GIFs im Original laden, damit sie animiert bleiben
    if (inline && f.i && /^image\//.test(f.m) && !f.m.includes('svg') && f.m !== 'image/gif') {
      const res = await this.raw(`${this.base}/index.php/core/preview`, { query: { fileId: f.i, x: 1600, y: 1600, a: 1 } });
      if (res.ok) return { filename: f.n, contentType: res.headers.get('content-type') || 'image/jpeg', data: Buffer.from(await res.arrayBuffer()) };
    }
    const res = await this.raw(this.dav(f.p), { timeoutMs: 120_000 });
    if (!res.ok) throw new HttpError(res.status, res.status === 404 ? 'Datei nicht mehr vorhanden' : `Download fehlgeschlagen (${res.status})`);
    return { filename: f.n, contentType: f.m || res.headers.get('content-type') || 'application/octet-stream', data: Buffer.from(await res.arrayBuffer()) };
  }

  async avatar(remoteUserId: string): Promise<BinaryFile> {
    if (remoteUserId.includes('/')) throw new NotFoundError('Avatar');
    const res = await this.raw(`${this.base}/index.php/avatar/${encodeURIComponent(remoteUserId)}/64`, { headers: { Accept: 'image/*' } });
    if (!res.ok) throw new NotFoundError('Avatar');
    return { filename: 'avatar', contentType: res.headers.get('content-type') || 'image/png', data: Buffer.from(await res.arrayBuffer()) };
  }

  async searchUsers(q: string): Promise<ChatUser[]> {
    const list = await this.ocs<{ id: string; label: string; source: string; status?: { status?: string } | [] }[]>('/core/autocomplete/get', {
      query: { search: q, itemType: 'call', itemId: 'new', 'shareTypes[]': 0, limit: 20 },
    });
    return list
      .filter((u) => u.source === 'users' && u.id !== this.conn.remoteUserId)
      .map((u) => ({
        id: this.uid(u.id)!,
        name: u.label || u.id,
        email: '',
        avatarUrl: this.avatarUrl(u.id),
        online: !Array.isArray(u.status) && u.status?.status === 'online',
      }));
  }

  async openDirect(remoteUserId: string): Promise<ChatConversation> {
    const r = await this.ocs<TalkRoom>('/apps/spreed/api/v4/room', { method: 'POST', body: { roomType: 1, invite: remoteUserId } });
    return this.getConversation(r.token);
  }

  async createGroup(name: string, remoteUserIds: string[]): Promise<ChatConversation> {
    const r = await this.ocs<TalkRoom>('/apps/spreed/api/v4/room', { method: 'POST', body: { roomType: 2, roomName: name } });
    for (const id of remoteUserIds) {
      await this.ocs(`/apps/spreed/api/v4/room/${encodeURIComponent(r.token)}/participants`, { method: 'POST', body: { newParticipant: id, source: 'users' } }).catch((err) =>
        this.host.log.warn({ err }, 'Talk: Teilnehmer konnte nicht hinzugefügt werden'),
      );
    }
    return this.getConversation(r.token);
  }

  /* ─────────── Abfrage / Echtzeit ─────────── */

  start() {
    this.stopped = false;
    this.host.setStatus('connecting');
    // Fähigkeiten auffrischen (Talk-Update auf dem Server)
    void loadFeatures(this.base, this.auth)
      .then((f) => {
        this.features = f;
        this.capabilities = this.caps(false);
      })
      .catch(() => undefined);
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hot.clear();
  }

  presence(online: boolean) {
    if (online && !this.stopped) this.schedule(500);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pollRooms(), ms);
    this.timer.unref();
  }

  private markHot(token: string) {
    this.hot.set(token, Date.now());
    if (!this.longPolls.has(token) && this.host.online() && !this.stopped && this.known.has(token)) void this.longPoll(token);
  }

  /** Long-Polling für eine gerade genutzte Unterhaltung */
  private async longPoll(token: string) {
    this.longPolls.add(token);
    let errors = 0;
    try {
      while (!this.stopped && this.host.online() && Date.now() - (this.hot.get(token) ?? 0) < HOT_MS) {
        try {
          const list = await this.chat(token, { lookIntoFuture: 1, timeout: 30, limit: 100, lastKnownMessageId: this.known.get(token) ?? 0 }, 45_000);
          this.process(token, list);
          errors = 0;
        } catch (err) {
          if (err instanceof AuthError || ++errors > 5) break;
          await new Promise((r) => setTimeout(r, 2000 * errors));
        }
      }
    } finally {
      this.longPolls.delete(token);
    }
  }

  private async pollRooms() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const rooms = await this.fetchRooms();
      const seen = new Set<string>();
      for (const r of rooms) {
        seen.add(r.token);
        this.rooms.set(r.token, r);
        const lastId = r.lastMessage && !Array.isArray(r.lastMessage) ? r.lastMessage.id : 0;
        const prev = this.known.get(r.token);
        const prevUnread = this.unread.get(r.token);
        this.unread.set(r.token, r.unreadMessages);
        if (prev === undefined) {
          this.known.set(r.token, lastId);
          if (this.initialized) this.host.publish({ type: 'chat.conversation', conversationId: this.convId(r.token) });
          continue;
        }
        if (lastId > prev && !this.longPolls.has(r.token)) {
          const list = await this.chat(r.token, { lookIntoFuture: 1, timeout: 0, limit: 100, lastKnownMessageId: prev }).catch(() => []);
          this.process(r.token, list);
        }
        // Auf einem anderen Gerät gelesen
        if (prevUnread && !r.unreadMessages) this.host.publish({ type: 'chat.read', conversationId: this.convId(r.token), userId: this.me, seq: r.lastReadMessage });
      }
      if (this.initialized) {
        for (const token of [...this.known.keys()]) {
          if (seen.has(token)) continue;
          this.known.delete(token);
          this.rooms.delete(token);
          this.host.publish({ type: 'chat.conversation', conversationId: this.convId(token), removed: true });
        }
      }
      this.initialized = true;
      this.host.setStatus('ok');
    } catch (err) {
      this.host.setStatus('error', (err as Error).message);
    } finally {
      this.polling = false;
      this.schedule(this.host.online() ? FAST_POLL : SLOW_POLL);
    }
  }

  /** Neue Nachrichten verteilen (doppelte über die bekannte ID aussortiert) */
  private process(token: string, list: TalkMessage[]) {
    for (const m of list.sort((a, b) => a.id - b.id)) {
      if (m.id <= (this.known.get(token) ?? 0)) continue;
      this.known.set(token, m.id);
      if (UPDATE_SYSTEM.has(m.systemMessage)) {
        const parent = m.parent && !Array.isArray(m.parent) ? m.parent : null;
        const msg = parent ? this.toMessage(parent) : null;
        if (msg) this.host.publish({ type: 'chat.message.updated', conversationId: msg.conversationId, message: msg });
        continue;
      }
      const msg = this.toMessage(m);
      if (!msg) continue;
      this.host.publish({ type: 'chat.message', conversationId: msg.conversationId, message: msg });
      const own = m.actorType === 'users' && m.actorId === this.conn.remoteUserId;
      if (msg.kind === 'text' && !own) {
        const room = this.rooms.get(token);
        const direct = room?.type === 1 || room?.type === 5;
        this.host.incoming(msg, { kind: direct ? 'direct' : 'group', title: room?.displayName ?? 'Nextcloud Talk', sender: m.actorDisplayName || 'Jemand' });
      }
    }
  }
}
