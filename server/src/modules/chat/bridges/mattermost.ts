/**
 * Mattermost-Brücke (REST API v4 + WebSocket).
 * Anmeldung per persönlichem Zugriffstoken oder Benutzername/Passwort (Sitzungstoken
 * wird bei Ablauf automatisch erneuert). Echtzeit über den WebSocket des Servers.
 */
import {
  replaceShortcodes,
  type ChatCall,
  type ChatCallInfo,
  type ChatCapabilities,
  type ChatCategory,
  type ChatConversation,
  type ChatMember,
  type ChatMessage,
  type ChatMessagePage,
  type ChatReaction,
  type ChatUser,
} from '@kuvert/shared';
import { randomId } from '../../../core/crypto.js';
import { AppError, AuthError, BadRequestError, HttpError, NotFoundError } from '../../../core/errors.js';
import { apiFetch, type RequestOptions } from '../../../core/http.js';
import {
  BridgeBase,
  backoffMs,
  emojiFromName,
  extId,
  msToIso,
  nameFromEmoji,
  type BinaryFile,
  type BridgeHost,
  type ChatBridge,
  type ConnectionRecord,
} from './common.js';

/* ───────────────────────────── Typen der API ───────────────────────────── */

interface MmUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  email?: string;
  position?: string;
  delete_at?: number;
  is_bot?: boolean;
}

interface MmTeam {
  id: string;
  name: string;
  display_name: string;
}

interface MmChannel {
  id: string;
  team_id: string;
  type: 'O' | 'P' | 'D' | 'G';
  display_name: string;
  name: string;
  header?: string;
  purpose?: string;
  last_post_at: number;
  total_msg_count: number;
  create_at: number;
  delete_at: number;
}

interface MmMember {
  channel_id: string;
  user_id: string;
  roles: string;
  last_viewed_at: number;
  msg_count: number;
}

interface MmFile {
  id: string;
  name: string;
  size: number;
  mime_type?: string;
}

interface MmReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
}

interface MmPost {
  id: string;
  create_at: number;
  edit_at: number;
  delete_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  props?: Record<string, unknown>;
  file_ids?: string[];
  metadata?: { files?: MmFile[]; reactions?: MmReaction[] };
}

interface MmPostList {
  order: string[];
  posts: Record<string, MmPost>;
}

interface MmPreference {
  user_id: string;
  category: string;
  name: string;
  value: string;
}

interface MmCategory {
  id: string;
  team_id: string;
  type: 'favorites' | 'channels' | 'direct_messages' | 'custom';
  display_name: string;
  sorting: string;
  collapsed?: boolean;
  channel_ids: string[] | null;
}

interface MmCategoryList {
  categories: MmCategory[];
  order: string[];
}

/** Zustand eines Anrufs (Calls-Plugin; je nach Version users oder sessions) */
interface MmCallState {
  start_at?: number;
  owner_id?: string;
  users?: string[];
  sessions?: { user_id?: string }[];
}

interface MmCallChannel {
  channel_id: string;
  enabled?: boolean;
  call?: MmCallState | null;
}

interface CallEntry {
  startAt: number;
  ownerId: string | null;
  users: string[];
}

const CALLS_PLUGIN = '/plugins/com.mattermost.calls';
const CALLS_EVENT = 'custom_com.mattermost.calls_';

const CAPS: ChatCapabilities = { edit: true, delete: true, react: true, reply: true, files: true, typing: true, readReceipts: false, manage: false };
const POST_CACHE = 3000;
const PREVIEW_CHANNELS = 40;

export function normalizeMattermostUrl(v: string): string {
  let s = v.trim();
  if (!s) throw new BadRequestError('Mattermost-Adresse fehlt');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname.replace(/\/(api\/v4|login|[\w-]+\/channels)(\/.*)?$/i, '').replace(/\/+$/, '')}`;
  } catch {
    throw new BadRequestError('Mattermost-Adresse ist ungültig');
  }
}

/** Sitzungstoken per Benutzername/Passwort holen */
async function login(baseUrl: string, loginId: string, password: string): Promise<{ token: string; user: MmUser }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ login_id: loginId, password }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AppError(502, 'mattermost_unreachable', `Mattermost nicht erreichbar: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as MmUser & { message?: string; id?: string };
  if (!res.ok) {
    if (body?.id === 'mfa.validate_token.authenticate.app_error' || /mfa/i.test(body?.message ?? ''))
      throw new BadRequestError('Für dieses Konto ist Zwei-Faktor-Anmeldung aktiv – bitte ein persönliches Zugriffstoken verwenden');
    throw new BadRequestError(`Mattermost-Anmeldung fehlgeschlagen: ${body?.message ?? res.status}`);
  }
  const token = res.headers.get('token');
  if (!token) throw new BadRequestError('Mattermost hat kein Sitzungstoken geliefert');
  return { token, user: body };
}

export function mmDisplayName(u: MmUser | undefined): string {
  if (!u) return 'Unbekannt';
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.nickname || u.username;
}

/** Verbindung prüfen und Daten für den Verbindungsdatensatz liefern */
export async function setupMattermost(input: { baseUrl: string; username?: string; password?: string; token?: string }) {
  const baseUrl = normalizeMattermostUrl(input.baseUrl);
  const secrets: Record<string, string> = {};
  let user: MmUser;
  if (input.token?.trim()) {
    secrets.token = input.token.trim();
    try {
      const res = await apiFetch(`${baseUrl}/api/v4/users/me`, { token: secrets.token, retries: 1, timeoutMs: 20_000, noAuthError: true });
      user = (await res.json()) as MmUser;
    } catch (err) {
      if (err instanceof AppError && err.status === 401) throw new BadRequestError('Zugriffstoken wird von Mattermost nicht akzeptiert');
      throw err;
    }
  } else {
    if (!input.username?.trim() || !input.password) throw new BadRequestError('Bitte Zugriffstoken oder Benutzername und Passwort angeben');
    const r = await login(baseUrl, input.username.trim(), input.password);
    user = r.user;
    secrets.loginId = input.username.trim();
    secrets.password = input.password;
    secrets.session = r.token;
  }
  return { baseUrl, username: user.username, displayName: mmDisplayName(user), remoteUserId: user.id, secrets };
}

/* ───────────────────────────── Brücke ───────────────────────────── */

export class MattermostBridge extends BridgeBase implements ChatBridge {
  readonly capabilities = CAPS;
  private users = new Map<string, MmUser>();
  private statuses = new Map<string, string>();
  private teams: MmTeam[] | null = null;
  private channels = new Map<string, MmChannel>();
  private posts = new Map<string, MmPost>();
  private lastPosts = new Map<string, { at: number; post: MmPost | null }>();
  private ws: WebSocket | null = null;
  private wsSeq = 1;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastFrame = 0;
  private relogin: Promise<string> | null = null;
  /** Favorisierte Kanäle (null = noch nicht geladen) */
  private favorites: Set<string> | null = null;
  /** Laufende Anrufe je Kanal */
  private calls = new Map<string, CallEntry>();
  /** Calls-Plugin vorhanden (null = unbekannt) */
  private callsAvailable: boolean | null = null;
  private callTimers = new Map<string, NodeJS.Timeout>();

  constructor(conn: ConnectionRecord, host: BridgeHost) {
    super(conn, host);
  }

  private get base() {
    return this.conn.baseUrl;
  }

  /* ─────────── HTTP ─────────── */

  private token(): string {
    return this.conn.secrets.token || this.conn.secrets.session || '';
  }

  private async renewSession(): Promise<string> {
    const { loginId, password } = this.conn.secrets;
    if (!loginId || !password) throw new AuthError('Mattermost-Zugriffstoken ungültig – bitte Verbindung neu einrichten');
    this.relogin ??= login(this.base, loginId, password)
      .then((r) => {
        this.conn.secrets = { ...this.conn.secrets, session: r.token };
        this.host.saveSecrets(this.conn.secrets);
        return r.token;
      })
      .finally(() => {
        this.relogin = null;
      });
    return this.relogin;
  }

  private async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    // Plugin-Routen (Calls) liegen außerhalb von /api/v4
    const url = path.startsWith('/plugins/') ? `${this.base}${path}` : `${this.base}/api/v4${path}`;
    const run = () => apiFetch(url, { retries: 2, timeoutMs: 30_000, ...opts, token: this.token(), noAuthError: true });
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 401) throw err;
      try {
        await this.renewSession();
      } catch (e) {
        this.host.setStatus('error', (e as Error).message);
        throw e instanceof AppError ? e : new AuthError('Mattermost-Anmeldung abgelaufen');
      }
      return run();
    }
  }

  private async api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /* ─────────── Caches ─────────── */

  private rememberPost(p: MmPost) {
    this.posts.delete(p.id);
    this.posts.set(p.id, p);
    if (this.posts.size > POST_CACHE) this.posts.delete(this.posts.keys().next().value!);
  }

  private async ensureUsers(ids: Iterable<string>) {
    const missing = [...new Set(ids)].filter((id) => id && !this.users.has(id));
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i += 100) {
      const list = await this.api<MmUser[]>('/users/ids', { method: 'POST', body: missing.slice(i, i + 100) }).catch(() => [] as MmUser[]);
      for (const u of list) this.users.set(u.id, u);
    }
  }

  private async loadStatuses(ids: string[]) {
    if (!ids.length) return;
    const list = await this.api<{ user_id: string; status: string }[]>('/users/status/ids', { method: 'POST', body: ids }).catch(() => []);
    for (const s of list) this.statuses.set(s.user_id, s.status);
  }

  private async getTeams(): Promise<MmTeam[]> {
    this.teams ??= await this.api<MmTeam[]>('/users/me/teams');
    return this.teams;
  }

  private async getPost(id: string): Promise<MmPost> {
    const p = await this.api<MmPost>(`/posts/${encodeURIComponent(id)}`);
    this.rememberPost(p);
    return p;
  }

  /** Favoriten aus den Mattermost-Einstellungen (404 = keine vorhanden; andere Fehler behalten den letzten Stand) */
  private async loadFavorites(): Promise<Set<string>> {
    const list = await this.api<MmPreference[]>('/users/me/preferences/favorite_channel').catch((err) =>
      err instanceof AppError && err.status === 404 ? ([] as MmPreference[]) : null,
    );
    if (list) this.favorites = new Set(list.filter((p) => p.value === 'true').map((p) => p.name));
    return this.favorites ?? new Set();
  }

  /* ─────────── Anrufe (Calls-Plugin) ─────────── */

  private parseCall(c: MmCallState | null | undefined): CallEntry | null {
    if (!c) return null;
    const users = c.users ?? (c.sessions ?? []).map((x) => x.user_id).filter((x): x is string => !!x);
    return { startAt: c.start_at || Date.now(), ownerId: c.owner_id || null, users: [...new Set(users)] };
  }

  /** Alle laufenden Anrufe laden; fehlt das Plugin (404), gibt es keine Anrufe */
  private async loadCalls() {
    try {
      const list = await this.api<MmCallChannel[]>(`${CALLS_PLUGIN}/channels`, { retries: 0 });
      this.callsAvailable = true;
      this.calls.clear();
      for (const ch of list ?? []) {
        const call = this.parseCall(ch.call);
        if (call) this.calls.set(ch.channel_id, call);
      }
      await this.ensureUsers([...this.calls.values()].flatMap((c) => c.users));
    } catch (err) {
      if (err instanceof AppError && (err.status === 404 || err.status === 501)) {
        this.callsAvailable = false;
        this.calls.clear();
      }
    }
  }

  private callOf(channelId: string): ChatCall | null {
    const c = this.calls.get(channelId);
    if (!c) return null;
    const ch = this.channels.get(channelId);
    return {
      startedAt: msToIso(c.startAt),
      ownerId: this.uid(c.ownerId),
      participantIds: c.users.map((u) => this.uid(u)!),
      joinUrl: ch ? this.webUrl(ch, this.teams ?? []) : null,
    };
  }

  private publishCall(channelId: string, ring?: { caller: string; title: string; direct: boolean }) {
    this.host.publish({ type: 'chat.call', conversationId: this.convId(channelId), call: this.callOf(channelId), ring });
  }

  /** Zustand eines Anrufs neu abfragen (gebündelt, da beim Beitreten mehrere Ereignisse kommen) */
  private refreshCallSoon(channelId: string) {
    const prev = this.callTimers.get(channelId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.callTimers.delete(channelId);
      this.api<MmCallChannel>(`${CALLS_PLUGIN}/${encodeURIComponent(channelId)}`, { retries: 0 })
        .then(async (state) => {
          const call = this.parseCall(state?.call);
          if (call) {
            await this.ensureUsers(call.users);
            this.calls.set(channelId, call);
          } else this.calls.delete(channelId);
          this.publishCall(channelId);
        })
        .catch((err) => this.host.log.debug({ err }, 'Mattermost: Anrufstatus nicht abrufbar'));
    }, 500);
    t.unref();
    this.callTimers.set(channelId, t);
  }

  private async onCallEvent(name: string, data: Record<string, any>, channelId: string | undefined) {
    if (!channelId) return;
    this.callsAvailable = true;
    if (name === 'call_end') {
      this.calls.delete(channelId);
      this.publishCall(channelId);
      return;
    }
    if (name !== 'call_start') {
      this.refreshCallSoon(channelId);
      return;
    }
    const ownerId: string | null = data.owner_id || data.ownerID || data.host_id || data.hostID || null;
    this.calls.set(channelId, { startAt: Number(data.start_at) || Date.now(), ownerId, users: ownerId ? [ownerId] : [] });
    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = await this.api<MmChannel>(`/channels/${encodeURIComponent(channelId)}`).catch(() => undefined);
      if (ch) this.channels.set(ch.id, ch);
    }
    let ring: { caller: string; title: string; direct: boolean } | undefined;
    if (ch && (ch.type === 'D' || ch.type === 'G') && ownerId && ownerId !== this.conn.remoteUserId) {
      await this.ensureUsers([ownerId]);
      ring = { caller: mmDisplayName(this.users.get(ownerId)), title: ch.type === 'G' ? ch.display_name : '', direct: ch.type === 'D' };
      this.host.ringing(this.convId(channelId), ring);
    }
    this.publishCall(channelId, ring);
    this.refreshCallSoon(channelId);
  }

  /* ─────────── Abbildung ─────────── */

  private chatUser(u: MmUser): ChatUser {
    return {
      id: this.uid(u.id)!,
      name: mmDisplayName(u),
      email: u.email ?? '',
      avatarUrl: this.avatarUrl(u.id),
      online: this.statuses.get(u.id) === 'online',
      jobTitle: u.position || undefined,
      disabled: (u.delete_at ?? 0) > 0 || undefined,
    };
  }

  private otherOf(ch: MmChannel): string | null {
    if (ch.type !== 'D') return null;
    const [a, b] = ch.name.split('__');
    return (a === this.conn.remoteUserId ? b : a) || null;
  }

  private webUrl(ch: MmChannel, teams: MmTeam[]): string | null {
    const team = teams.find((t) => t.id === ch.team_id) ?? teams[0];
    if (!team) return null;
    if (ch.type === 'D') {
      const other = this.users.get(this.otherOf(ch) ?? '');
      return other ? `${this.base}/${team.name}/messages/@${other.username}` : null;
    }
    if (ch.type === 'G') return `${this.base}/${team.name}/messages/${ch.name}`;
    return `${this.base}/${team.name}/channels/${ch.name}`;
  }

  /** Anruf-Beitrag (Typ custom_calls): Beginn, Ende, Teilnehmende */
  private callInfo(p: MmPost): ChatCallInfo | null {
    if (p.type !== 'custom_calls') return null;
    const props = p.props ?? {};
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
    const ids = [props.participants, props.attendees].find(Array.isArray) as unknown[] | undefined;
    const end = num(props.end_at);
    return {
      startedAt: msToIso(num(props.start_at) || p.create_at),
      endedAt: end ? msToIso(end) : null,
      participantIds: (ids ?? []).filter((x): x is string => typeof x === 'string').map((x) => this.uid(x)!),
      title: typeof props.title === 'string' && props.title.trim() ? props.title.trim() : null,
    };
  }

  toMessage(p: MmPost): ChatMessage {
    const system = p.type.startsWith('system_');
    const deleted = p.delete_at > 0;
    const call = deleted ? null : this.callInfo(p);
    const reactions: ChatReaction[] = [];
    for (const r of p.metadata?.reactions ?? []) {
      const emoji = emojiFromName(r.emoji_name);
      const uid = this.uid(r.user_id)!;
      const existing = reactions.find((x) => x.emoji === emoji);
      if (existing) existing.userIds.push(uid);
      else reactions.push({ emoji, userIds: [uid] });
    }
    let replyTo: ChatMessage['replyTo'] = null;
    if (p.root_id) {
      const root = this.posts.get(p.root_id);
      replyTo = root
        ? {
            id: this.msgId(root.channel_id, root.id),
            senderId: this.uid(root.user_id),
            body: root.delete_at ? '' : root.type === 'custom_calls' ? '📞 Anruf' : replaceShortcodes(root.message).slice(0, 280),
            deleted: root.delete_at > 0,
            hasAttachments: !!root.file_ids?.length,
          }
        : { id: this.msgId(p.channel_id, p.root_id), senderId: null, body: '', deleted: false, hasAttachments: false };
    }
    const override = typeof p.props?.override_username === 'string' ? p.props.override_username : null;
    const username = this.conn.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = !system && !call && new RegExp(`@(${username}|all|channel|here)(?![\\w.-])`, 'i').test(p.message);
    return {
      id: this.msgId(p.channel_id, p.id),
      seq: p.create_at,
      conversationId: this.convId(p.channel_id),
      senderId: system ? null : this.uid(p.user_id),
      kind: system ? 'system' : 'text',
      body: system
        ? JSON.stringify({ action: 'text', actorId: this.uid(p.user_id) ?? '', text: replaceShortcodes(p.message) })
        : deleted
          ? ''
          : call
            ? call.endedAt
              ? '📞 Anruf beendet'
              : '📞 Anruf läuft'
            : replaceShortcodes(p.message),
      createdAt: msToIso(p.create_at),
      editedAt: p.edit_at ? msToIso(p.edit_at) : null,
      deleted,
      replyTo,
      attachments: deleted
        ? []
        : (p.metadata?.files ?? []).map((f) => ({ id: this.fileId(f.id), filename: f.name, contentType: f.mime_type || 'application/octet-stream', size: f.size })),
      reactions: deleted ? [] : reactions,
      senderName: override ?? (this.users.has(p.user_id) ? mmDisplayName(this.users.get(p.user_id)) : null),
      mention: mention || undefined,
      call: call ?? undefined,
    };
  }

  private toConversation(ch: MmChannel, member: MmMember | undefined, teams: MmTeam[], memberCount?: number): ChatConversation {
    const other = this.otherOf(ch);
    const otherUser = other ? this.users.get(other) : undefined;
    const team = ch.type === 'O' || ch.type === 'P' ? teams.find((t) => t.id === ch.team_id) : undefined;
    const last = this.lastPosts.get(ch.id)?.post ?? null;
    const members: ChatMember[] = [
      { userId: this.me, role: member?.roles.includes('channel_admin') ? 'owner' : 'member', lastReadSeq: member?.last_viewed_at ?? 0, joinedAt: msToIso(ch.create_at) },
    ];
    if (other && other !== this.conn.remoteUserId) members.push({ userId: this.uid(other)!, role: 'member', lastReadSeq: 0, joinedAt: msToIso(ch.create_at) });
    // Personen im laufenden Anruf mitliefern, damit ihre Namen bekannt sind
    const participants = otherUser ? [this.chatUser(otherUser)] : [];
    for (const u of this.calls.get(ch.id)?.users ?? []) {
      const mu = this.users.get(u);
      if (mu && u !== this.conn.remoteUserId && u !== other) participants.push(this.chatUser(mu));
    }
    return {
      id: this.convId(ch.id),
      kind: ch.type === 'D' ? 'direct' : 'group',
      name: ch.type === 'D' ? (otherUser ? mmDisplayName(otherUser) : ch.display_name || null) : ch.display_name || ch.name,
      description: ch.purpose || ch.header || null,
      createdAt: msToIso(ch.create_at),
      lastMessageAt: msToIso(Math.max(ch.last_post_at, ch.create_at)),
      members,
      lastMessage: last ? this.toMessage(last) : null,
      unread: member ? Math.max(0, ch.total_msg_count - member.msg_count) : 0,
      muted: false,
      // Angeheftet = Favorit in Mattermost
      pinned: !!this.favorites?.has(ch.id),
      myRole: members[0]!.role,
      source: this.source(team?.display_name ?? null, this.webUrl(ch, teams)),
      capabilities: this.callsAvailable ? { ...CAPS, calls: true } : CAPS,
      memberCount: ch.type === 'D' ? 2 : (memberCount ?? null),
      participants,
      call: this.callOf(ch.id),
    };
  }

  /** Letzte Nachricht für die Vorschau (zwischengespeichert, solange sich last_post_at nicht ändert) */
  private async loadLastPost(ch: MmChannel) {
    const cached = this.lastPosts.get(ch.id);
    if (cached && cached.at === ch.last_post_at) return;
    const list = await this.api<MmPostList>(`/channels/${ch.id}/posts`, { query: { per_page: 1 } }).catch(() => null);
    const post = list?.order[0] ? list.posts[list.order[0]] : undefined;
    if (post) {
      for (const p of Object.values(list!.posts)) this.rememberPost(p);
      await this.ensureUsers([post.user_id]);
    }
    this.lastPosts.set(ch.id, { at: ch.last_post_at, post: post ?? null });
  }

  /* ─────────── Unterhaltungen ─────────── */

  async listConversations(): Promise<ChatConversation[]> {
    this.teams = null;
    const [teams] = await Promise.all([this.getTeams(), this.loadFavorites(), this.loadCalls()]);
    const channels = new Map<string, MmChannel>();
    const members = new Map<string, MmMember>();
    await Promise.all(
      teams.map(async (t) => {
        const [chs, mems] = await Promise.all([
          this.api<MmChannel[]>(`/users/me/teams/${t.id}/channels`),
          this.api<MmMember[]>(`/users/me/teams/${t.id}/channels/members`),
        ]);
        for (const c of chs) if (!c.delete_at) channels.set(c.id, c);
        for (const m of mems) members.set(m.channel_id, m);
      }),
    );
    for (const c of channels.values()) this.channels.set(c.id, c);
    const others = [...channels.values()].map((c) => this.otherOf(c)).filter((x): x is string => !!x);
    await this.ensureUsers(others);
    await this.loadStatuses(others);
    const recent = [...channels.values()].sort((a, b) => b.last_post_at - a.last_post_at).slice(0, PREVIEW_CHANNELS);
    await Promise.all(recent.map((c) => this.loadLastPost(c)));
    return [...channels.values()].map((c) => this.toConversation(c, members.get(c.id), teams));
  }

  async getConversation(remoteId: string): Promise<ChatConversation> {
    const [ch, member, stats, teams] = await Promise.all([
      this.api<MmChannel>(`/channels/${encodeURIComponent(remoteId)}`),
      this.api<MmMember>(`/channels/${encodeURIComponent(remoteId)}/members/me`).catch(() => undefined),
      this.api<{ member_count: number }>(`/channels/${encodeURIComponent(remoteId)}/stats`).catch(() => undefined),
      this.getTeams(),
    ]);
    if (!member) throw new NotFoundError('Unterhaltung');
    this.channels.set(ch.id, ch);
    if (!this.favorites) await this.loadFavorites();
    const other = this.otherOf(ch);
    if (other) {
      await this.ensureUsers([other]);
      await this.loadStatuses([other]);
    }
    await this.loadLastPost(ch);
    return this.toConversation(ch, member, teams, stats?.member_count);
  }

  async members(remoteId: string): Promise<ChatUser[]> {
    const list = await this.api<MmMember[]>(`/channels/${encodeURIComponent(remoteId)}/members`, { query: { per_page: 200 } });
    const ids = list.map((m) => m.user_id);
    await this.ensureUsers(ids);
    await this.loadStatuses(ids);
    return ids.map((id) => this.users.get(id)).filter((u): u is MmUser => !!u).map((u) => this.chatUser(u));
  }

  /* ─────────── Favoriten & Abschnitte ─────────── */

  async setFavorite(remoteId: string, favorite: boolean): Promise<void> {
    // Mattermost gleicht die Einstellung selbst mit dem Abschnitt "Favoriten" ab
    await this.api(`/users/${this.conn.remoteUserId}/preferences`, {
      method: 'PUT',
      body: [{ user_id: this.conn.remoteUserId, category: 'favorite_channel', name: remoteId, value: favorite ? 'true' : 'false' }],
    });
    this.favorites ??= new Set();
    if (favorite) this.favorites.add(remoteId);
    else this.favorites.delete(remoteId);
  }

  /**
   * Abschnitte der Seitenleiste (je Team). Bei mehreren Teams werden Favoriten und
   * Direktnachrichten zusammengefasst, Kanal-Abschnitte tragen den Team-Namen.
   */
  async categories(): Promise<ChatCategory[]> {
    const teams = await this.getTeams();
    const lists = await Promise.all(
      teams.map((team) =>
        this.api<MmCategoryList>(`/users/me/teams/${team.id}/channels/categories`)
          .then((list) => ({ team, list }))
          .catch((err) => {
            this.host.log.debug({ err }, 'Mattermost: Abschnitte nicht abrufbar');
            return null;
          }),
      ),
    );
    const multi = teams.length > 1;
    const out: ChatCategory[] = [];
    const shared = new Map<string, ChatCategory>();
    for (const entry of lists) {
      if (!entry?.list?.categories) continue;
      const byId = new Map(entry.list.categories.map((c) => [c.id, c]));
      const ordered = (entry.list.order ?? []).map((id) => byId.get(id)).filter((c): c is MmCategory => !!c);
      for (const c of entry.list.categories) if (!ordered.includes(c)) ordered.push(c);
      for (const c of ordered) {
        const kind: ChatCategory['kind'] =
          c.type === 'favorites' ? 'favorites' : c.type === 'direct_messages' ? 'direct' : c.type === 'channels' ? 'channels' : 'custom';
        const ids = (c.channel_ids ?? []).map((id) => this.convId(id));
        const merge = kind === 'favorites' || kind === 'direct';
        const existing = merge ? shared.get(kind) : undefined;
        if (existing) {
          for (const id of ids) if (!existing.conversationIds.includes(id)) existing.conversationIds.push(id);
          continue;
        }
        const sorting: ChatCategory['sorting'] =
          c.sorting === 'alpha' || c.sorting === 'recent' || c.sorting === 'manual' ? c.sorting : kind === 'direct' ? 'recent' : 'alpha';
        const cat: ChatCategory = {
          id: extId(this.conn.id, merge ? kind : c.id),
          connectionId: this.conn.id,
          kind,
          name: kind === 'favorites' ? 'Favoriten' : kind === 'direct' ? 'Direktnachrichten' : kind === 'channels' ? 'Kanäle' : c.display_name,
          context: multi && !merge ? entry.team.display_name : null,
          sorting,
          collapsed: !!c.collapsed,
          conversationIds: ids,
        };
        if (merge) shared.set(kind, cat);
        out.push(cat);
      }
    }
    return out;
  }

  /* ─────────── Nachrichten ─────────── */

  async messages(remoteId: string, opts: { beforeId?: string; limit: number }): Promise<ChatMessagePage> {
    const list = await this.api<MmPostList>(`/channels/${encodeURIComponent(remoteId)}/posts`, {
      query: { per_page: opts.limit, before: opts.beforeId },
    });
    for (const p of Object.values(list.posts)) this.rememberPost(p);
    const posts = list.order.map((id) => list.posts[id]).filter((p): p is MmPost => !!p);
    await this.ensureUsers(Object.values(list.posts).map((p) => p.user_id));
    return { items: posts.reverse().map((p) => this.toMessage(p)), hasMore: list.order.length >= opts.limit };
  }

  private async uploadFiles(channelId: string, files: BinaryFile[]): Promise<string[]> {
    if (!files.length) return [];
    const form = new FormData();
    form.append('channel_id', channelId);
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.filename);
    const doFetch = () =>
      fetch(`${this.base}/api/v4/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token()}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    let res = await doFetch();
    if (res.status === 401) {
      await this.renewSession();
      res = await doFetch();
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new HttpError(res.status, `Datei-Upload zu Mattermost fehlgeschlagen: ${err.message ?? res.status}`);
    }
    const body = (await res.json()) as { file_infos: { id: string }[] };
    return body.file_infos.map((f) => f.id);
  }

  async send(remoteId: string, input: { body: string; replyTo?: string | null; files: BinaryFile[] }): Promise<ChatMessage> {
    let rootId = '';
    if (input.replyTo) {
      const target = this.posts.get(input.replyTo) ?? (await this.getPost(input.replyTo));
      rootId = target.root_id || target.id;
      this.rememberPost(target);
    }
    const fileIds = await this.uploadFiles(remoteId, input.files);
    const post = await this.api<MmPost>('/posts', {
      method: 'POST',
      body: { channel_id: remoteId, message: input.body, root_id: rootId, file_ids: fileIds },
      retries: 0,
    });
    this.rememberPost(post);
    this.lastPosts.set(remoteId, { at: post.create_at, post });
    return this.toMessage(post);
  }

  async edit(_remoteId: string, messageId: string, body: string): Promise<ChatMessage> {
    const post = await this.api<MmPost>(`/posts/${encodeURIComponent(messageId)}/patch`, { method: 'PUT', body: { message: body } });
    this.rememberPost(post);
    return this.toMessage(post);
  }

  async delete(_remoteId: string, messageId: string): Promise<ChatMessage> {
    const before = this.posts.get(messageId) ?? (await this.getPost(messageId));
    await this.api(`/posts/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    const post = { ...before, delete_at: Date.now(), message: '', metadata: {} };
    this.rememberPost(post);
    return this.toMessage(post);
  }

  async react(_remoteId: string, messageId: string, emoji: string): Promise<ChatMessage> {
    const name = nameFromEmoji(emoji);
    if (!name) throw new BadRequestError('Diese Reaktion wird von Mattermost nicht unterstützt');
    const post = await this.getPost(messageId);
    const mine = (post.metadata?.reactions ?? []).some((r) => r.user_id === this.conn.remoteUserId && r.emoji_name === name);
    if (mine) {
      await this.api(`/users/${this.conn.remoteUserId}/posts/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } else {
      await this.api('/reactions', { method: 'POST', body: { user_id: this.conn.remoteUserId, post_id: messageId, emoji_name: name } });
    }
    return this.toMessage(await this.getPost(messageId));
  }

  async markRead(remoteId: string): Promise<void> {
    await this.api('/channels/members/me/view', { method: 'POST', body: { channel_id: remoteId } });
  }

  async typing(remoteId: string): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: 'user_typing', seq: this.wsSeq++, data: { channel_id: remoteId, parent_id: '' } }));
  }

  async search(q: string): Promise<ChatMessage[]> {
    const teams = await this.getTeams();
    const results = await Promise.all(
      teams.map((t) =>
        this.api<MmPostList>(`/teams/${t.id}/posts/search`, {
          method: 'POST',
          body: { terms: q, is_or_search: false, include_deleted_channels: false, time_zone_offset: 0, page: 0, per_page: 20 },
        }).catch(() => ({ order: [], posts: {} }) as MmPostList),
      ),
    );
    const seen = new Set<string>();
    const posts: MmPost[] = [];
    for (const r of results)
      for (const id of r.order) {
        const p = r.posts[id];
        if (p && !seen.has(id)) {
          seen.add(id);
          posts.push(p);
          this.rememberPost(p);
        }
      }
    await this.ensureUsers(posts.map((p) => p.user_id));
    return posts
      .sort((a, b) => b.create_at - a.create_at)
      .slice(0, 30)
      .map((p) => this.toMessage(p));
  }

  async file(ref: string, inline: boolean): Promise<BinaryFile> {
    const info = await this.api<MmFile>(`/files/${encodeURIComponent(ref)}/info`);
    const res = await this.request(`/files/${encodeURIComponent(ref)}`, { query: inline ? undefined : { download: 1 } });
    return { filename: info.name, contentType: info.mime_type || res.headers.get('content-type') || 'application/octet-stream', data: Buffer.from(await res.arrayBuffer()) };
  }

  async avatar(remoteUserId: string): Promise<BinaryFile> {
    const res = await this.request(`/users/${encodeURIComponent(remoteUserId)}/image`, { retries: 0 });
    return { filename: 'avatar', contentType: res.headers.get('content-type') || 'image/png', data: Buffer.from(await res.arrayBuffer()) };
  }

  async searchUsers(q: string): Promise<ChatUser[]> {
    const list = await this.api<MmUser[]>('/users/search', { method: 'POST', body: { term: q, allow_inactive: false, limit: 25 } });
    for (const u of list) this.users.set(u.id, u);
    await this.loadStatuses(list.map((u) => u.id));
    return list.filter((u) => u.id !== this.conn.remoteUserId).map((u) => this.chatUser(u));
  }

  async openDirect(remoteUserId: string): Promise<ChatConversation> {
    const ch = await this.api<MmChannel>('/channels/direct', { method: 'POST', body: [this.conn.remoteUserId, remoteUserId] });
    return this.getConversation(ch.id);
  }

  async createGroup(name: string, remoteUserIds: string[]): Promise<ChatConversation> {
    const team = (await this.getTeams())[0];
    if (!team) throw new BadRequestError('Du bist in Mattermost keinem Team zugeordnet');
    const slug =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'gruppe';
    const ch = await this.api<MmChannel>('/channels', {
      method: 'POST',
      body: { team_id: team.id, name: `${slug}-${randomId(3)}`, display_name: name, type: 'P' },
      retries: 0,
    });
    for (const id of remoteUserIds) {
      await this.api(`/channels/${ch.id}/members`, { method: 'POST', body: { user_id: id } }).catch((err) =>
        this.host.log.warn({ err }, 'Mattermost: Mitglied konnte nicht hinzugefügt werden'),
      );
    }
    return this.getConversation(ch.id);
  }

  /* ─────────── Echtzeit (WebSocket) ─────────── */

  start() {
    this.stopped = false;
    this.host.setStatus('connecting');
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    for (const t of this.callTimers.values()) clearTimeout(t);
    this.callTimers.clear();
    try {
      this.ws?.close();
    } catch {
      /* egal */
    }
    this.ws = null;
  }

  private scheduleReconnect(reason?: string) {
    if (this.stopped || this.reconnectTimer) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const delay = backoffMs(this.attempt++);
    if (reason && this.attempt > 2) this.host.setStatus('error', reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Token prüfen (erneuert ggf. die Sitzung), dann neu verbinden
      this.api('/users/me')
        .then(() => this.connect())
        .catch((err) => {
          this.host.setStatus('error', (err as Error).message);
          this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${this.base.replace(/^http/i, 'ws')}/api/v4/websocket`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.lastFrame = Date.now();
      ws.send(JSON.stringify({ seq: this.wsSeq++, action: 'authentication_challenge', data: { token: this.token() } }));
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastFrame > 90_000) {
          ws.close();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ seq: this.wsSeq++, action: 'ping' }));
      }, 30_000);
      this.pingTimer.unref();
    });
    ws.addEventListener('message', (ev) => {
      this.lastFrame = Date.now();
      let msg: { event?: string; data?: Record<string, any>; broadcast?: Record<string, any> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.event) void this.onEvent(msg.event, msg.data ?? {}, msg.broadcast ?? {}).catch((err) => this.host.log.debug({ err }, 'Mattermost-Ereignis'));
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect('Echtzeitverbindung zu Mattermost unterbrochen');
    });
    ws.addEventListener('error', () => {
      /* close folgt */
    });
  }

  private async onEvent(event: string, data: Record<string, any>, broadcast: Record<string, any>) {
    const channelId: string | undefined = broadcast.channel_id || data.channel_id;
    switch (event) {
      case 'hello': {
        const reconnect = this.attempt > 0;
        this.attempt = 0;
        this.host.setStatus('ok');
        // Nach einer Unterbrechung: Client lädt Listen neu (verpasste Nachrichten)
        if (reconnect) this.host.publish({ type: 'chat.connection', connectionId: this.conn.id, status: 'ok' });
        return;
      }
      case 'posted': {
        const post = JSON.parse(data.post as string) as MmPost;
        this.rememberPost(post);
        if (post.root_id && !this.posts.has(post.root_id)) await this.getPost(post.root_id).catch(() => undefined);
        await this.ensureUsers([post.user_id]);
        this.lastPosts.set(post.channel_id, { at: post.create_at, post });
        const message = this.toMessage(post);
        if (!this.channels.has(post.channel_id)) this.host.publish({ type: 'chat.conversation', conversationId: message.conversationId });
        this.host.publish({ type: 'chat.message', conversationId: message.conversationId, message });
        if (message.kind === 'text' && !message.call && post.user_id !== this.conn.remoteUserId) {
          const ch = this.channels.get(post.channel_id);
          const direct = data.channel_type === 'D';
          this.host.incoming(message, {
            kind: direct ? 'direct' : 'group',
            title: direct ? '' : (ch?.display_name ?? String(data.channel_display_name ?? 'Mattermost')),
            sender: message.senderName ?? String(data.sender_name ?? 'Mattermost').replace(/^@/, ''),
          });
        }
        return;
      }
      case 'post_edited':
      case 'post_deleted': {
        const post = JSON.parse(data.post as string) as MmPost;
        if (event === 'post_deleted') post.delete_at ||= Date.now();
        this.rememberPost(post);
        const message = this.toMessage(post);
        this.host.publish({ type: 'chat.message.updated', conversationId: message.conversationId, message });
        return;
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const reaction = JSON.parse(data.reaction as string) as MmReaction;
        const post = await this.getPost(reaction.post_id);
        await this.ensureUsers([reaction.user_id]);
        const message = this.toMessage(post);
        this.host.publish({ type: 'chat.message.updated', conversationId: message.conversationId, message });
        return;
      }
      case 'typing': {
        if (!channelId || data.user_id === this.conn.remoteUserId || data.parent_id) return;
        this.host.publish({ type: 'chat.typing', conversationId: this.convId(channelId), userId: this.uid(data.user_id)! });
        return;
      }
      case 'channel_viewed': {
        if (!data.channel_id) return;
        this.host.publish({ type: 'chat.read', conversationId: this.convId(data.channel_id), userId: this.me, seq: Date.now() });
        return;
      }
      case 'status_change': {
        if (!data.user_id) return;
        this.statuses.set(data.user_id, data.status);
        this.host.publish({ type: 'chat.presence', userId: this.uid(data.user_id)!, online: data.status === 'online' });
        return;
      }
      case 'user_removed': {
        const removedMe = (data.user_id ?? broadcast.user_id) === this.conn.remoteUserId;
        const id = channelId ?? data.channel_id;
        if (!id) return;
        if (removedMe) this.channels.delete(id);
        this.host.publish({ type: 'chat.conversation', conversationId: this.convId(id), removed: removedMe || undefined });
        return;
      }
      case 'channel_deleted': {
        if (!channelId) return;
        this.channels.delete(channelId);
        this.host.publish({ type: 'chat.conversation', conversationId: this.convId(channelId), removed: true });
        return;
      }
      case 'channel_created':
      case 'direct_added':
      case 'group_added':
      case 'user_added':
      case 'channel_updated':
      case 'channel_converted':
      case 'added_to_team':
      case 'leave_team': {
        if (event === 'added_to_team' || event === 'leave_team') this.teams = null;
        const id = channelId ?? data.channel_id ?? (data.channel ? (JSON.parse(data.channel as string) as MmChannel).id : undefined);
        this.host.publish({ type: 'chat.conversation', conversationId: id ? this.convId(id) : this.convId('*') });
        return;
      }
      case 'sidebar_category_created':
      case 'sidebar_category_updated':
      case 'sidebar_category_deleted':
      case 'sidebar_category_order_updated': {
        this.host.publish({ type: 'chat.categories', connectionId: this.conn.id });
        return;
      }
      case 'preferences_changed':
      case 'preferences_deleted': {
        let prefs: MmPreference[] = [];
        try {
          prefs = JSON.parse(String(data.preferences ?? '[]')) as MmPreference[];
        } catch {
          return;
        }
        const favs = prefs.filter((p) => p.category === 'favorite_channel');
        if (!favs.length) return;
        this.favorites ??= new Set();
        for (const p of favs) {
          if (event === 'preferences_changed' && p.value === 'true') this.favorites.add(p.name);
          else this.favorites.delete(p.name);
        }
        this.host.publish({ type: 'chat.conversation', conversationId: this.convId(favs[0]!.name) });
        this.host.publish({ type: 'chat.categories', connectionId: this.conn.id });
        return;
      }
      default: {
        if (event.startsWith(CALLS_EVENT)) {
          const id: string | undefined = channelId || data.channelID || data.channelId;
          await this.onCallEvent(event.slice(CALLS_EVENT.length), data, id);
        }
      }
    }
  }
}
