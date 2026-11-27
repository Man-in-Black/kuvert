/**
 * Verwaltet die Verbindungen der Benutzer zu Mattermost, Nextcloud Talk und Microsoft Teams:
 * einrichten, starten/stoppen, Status melden und Brücken für Anfragen bereitstellen.
 */
import type { ChatCategory, ChatConnection, ChatConnectionInput, ChatConversation, ChatMessage, ChatRing, ServerEvent } from '@kuvert/shared';
import { CHAT_BRIDGE_LABELS } from '@kuvert/shared';
import { randomId } from '../../../core/crypto.js';
import { BadRequestError, NotFoundError } from '../../../core/errors.js';
import type { ModuleContext } from '../../../core/module.js';
import { connectionOf, connectionStore, extPrefs, type BridgeHost, type ChatBridge, type ConnectionRecord } from './common.js';
import { MattermostBridge, setupMattermost } from './mattermost.js';
import { TalkBridge, setupTalk } from './talk.js';
import { TeamsBridge, setupTeams, teamsGraph } from './teams.js';

export type IncomingHandler = (userId: string, message: ChatMessage, info: { kind: 'direct' | 'group'; title: string; sender: string }) => void;
export type RingHandler = (userId: string, conversationId: string, info: ChatRing) => void;

const LIST_TIMEOUT = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: Zeitüberschreitung`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class BridgeManager {
  private bridges = new Map<string, ChatBridge>();
  private status = new Map<string, { status: ChatConnection['status']; error: string | null }>();

  constructor(
    private ctx: ModuleContext,
    private onIncoming: IncomingHandler,
    private onRing?: RingHandler,
  ) {}

  /* ─────────── Lebenszyklus ─────────── */

  startAll() {
    for (const rec of connectionStore.all()) this.start(rec);
  }

  stopAll() {
    for (const b of this.bridges.values()) b.stop();
    this.bridges.clear();
  }

  /** Browser des Benutzers verbunden/getrennt → Abfrageintervalle anpassen */
  presence(userId: string, online: boolean) {
    for (const b of this.bridges.values()) if (b.conn.userId === userId) b.presence?.(online);
  }

  private host(rec: ConnectionRecord): BridgeHost {
    const publish = (event: ServerEvent) => this.ctx.bus.publish(rec.userId, event);
    return {
      log: this.ctx.log,
      publish,
      incoming: (message, info) => this.onIncoming(rec.userId, message, info),
      online: () => this.ctx.bus.hasListeners(rec.userId),
      setStatus: (status, error) => {
        const prev = this.status.get(rec.id);
        const next = { status, error: status === 'error' ? (error ?? 'Unbekannter Fehler') : null };
        this.status.set(rec.id, next);
        if (prev?.status !== next.status || prev?.error !== next.error) {
          if (status === 'error') this.ctx.log.warn({ connection: rec.id, type: rec.type, error }, 'Chat-Verbindung gestört');
          publish({ type: 'chat.connection', connectionId: rec.id, status, error: next.error });
        }
      },
      saveSecrets: (secrets) => connectionStore.setSecrets(rec.id, secrets),
      ringing: (conversationId, info) => this.onRing?.(rec.userId, conversationId, info),
    };
  }

  private start(rec: ConnectionRecord): ChatBridge {
    this.bridges.get(rec.id)?.stop();
    const host = this.host(rec);
    const bridge =
      rec.type === 'mattermost'
        ? new MattermostBridge(rec, host)
        : rec.type === 'teams'
          ? new TeamsBridge(rec, host, () => teamsGraph(this.ctx.accounts, String(rec.config.accountId ?? '')))
          : new TalkBridge(rec, host);
    this.bridges.set(rec.id, bridge);
    try {
      bridge.start();
    } catch (err) {
      host.setStatus('error', (err as Error).message);
    }
    return bridge;
  }

  /* ─────────── Zugriff ─────────── */

  /** Brücke zu einer Verbindung des Benutzers (404, wenn fremd oder unbekannt) */
  get(userId: string, connectionId: string): ChatBridge {
    const b = this.bridges.get(connectionId);
    if (b && b.conn.userId === userId) return b;
    const rec = connectionStore.get(connectionId);
    if (!rec || rec.userId !== userId) throw new NotFoundError('Verbindung');
    return this.start(rec);
  }

  /** Brücke zu einer externen ID (Unterhaltung, Nachricht, Datei, Person) */
  forId(userId: string, id: string): ChatBridge {
    return this.get(userId, connectionOf(id));
  }

  private info(rec: ConnectionRecord): ChatConnection {
    const st = this.status.get(rec.id);
    return {
      id: rec.id,
      type: rec.type,
      label: rec.label,
      baseUrl: rec.baseUrl,
      username: rec.username,
      displayName: rec.displayName,
      status: st?.status ?? 'connecting',
      error: st?.error ?? null,
      createdAt: rec.createdAt,
    };
  }

  list(userId: string): ChatConnection[] {
    return connectionStore.list(userId).map((r) => this.info(r));
  }

  hasAny(userId: string): boolean {
    return [...this.bridges.values()].some((b) => b.conn.userId === userId);
  }

  /** Speichert der Dienst Favoriten selbst (Mattermost)? Dann gilt dessen "angeheftet" */
  hasFavorites(conversationId: string): boolean {
    return !!this.bridges.get(connectionOf(conversationId))?.setFavorite;
  }

  /** Persönliche Einstellungen (stumm/angeheftet, Lesestand in Kuvert) übernehmen */
  withPrefs(userId: string, c: ChatConversation, prefs = extPrefs.all(userId)): ChatConversation {
    const p = prefs.get(c.id);
    if (!p) return c;
    // Nur in Kuvert als gelesen markiert: ungelesen erst wieder bei einer neueren Nachricht
    const readLocally = !!p.readUntil && c.unread > 0 && (Date.parse(c.lastMessageAt) || 0) <= (Date.parse(p.readUntil) || 0);
    return { ...c, muted: p.muted, pinned: this.hasFavorites(c.id) ? c.pinned : p.pinned, unread: readLocally ? 0 : c.unread };
  }

  /** Abschnitte der Seitenleiste aller Verbindungen, die welche haben (Mattermost) */
  async categories(userId: string): Promise<ChatCategory[]> {
    const mine = [...this.bridges.values()].filter((b) => b.conn.userId === userId && b.categories);
    const lists = await Promise.all(
      mine.map((b) =>
        withTimeout(b.categories!(), LIST_TIMEOUT, b.conn.label).catch((err) => {
          this.ctx.log.warn({ err, connection: b.conn.id }, 'Chat-Abschnitte eines Dienstes nicht abrufbar');
          return [] as ChatCategory[];
        }),
      ),
    );
    return lists.flat();
  }

  /** Unterhaltungen aller Verbindungen; gestörte Verbindungen werden übersprungen */
  async conversations(userId: string): Promise<ChatConversation[]> {
    const mine = [...this.bridges.values()].filter((b) => b.conn.userId === userId);
    if (!mine.length) return [];
    const prefs = extPrefs.all(userId);
    const lists = await Promise.all(
      mine.map((b) =>
        withTimeout(b.listConversations(), LIST_TIMEOUT, b.conn.label).catch((err) => {
          this.ctx.log.warn({ err, connection: b.conn.id }, 'Chat-Unterhaltungen eines Dienstes nicht abrufbar');
          return [] as ChatConversation[];
        }),
      ),
    );
    return lists.flat().map((c) => this.withPrefs(userId, c, prefs));
  }

  async search(userId: string, q: string): Promise<ChatMessage[]> {
    const mine = [...this.bridges.values()].filter((b) => b.conn.userId === userId);
    const lists = await Promise.all(mine.map((b) => withTimeout(b.search(q), LIST_TIMEOUT, b.conn.label).catch(() => [] as ChatMessage[])));
    return lists.flat();
  }

  /* ─────────── Einrichten / Entfernen ─────────── */

  async add(userId: string, input: ChatConnectionInput): Promise<ChatConnection> {
    let setup: { baseUrl: string; username: string; displayName: string; remoteUserId: string; secrets: Record<string, string>; config?: Record<string, unknown> };
    if (input.type === 'mattermost') {
      setup = await setupMattermost({ baseUrl: input.baseUrl ?? '', username: input.username, password: input.password, token: input.token });
    } else if (input.type === 'teams') {
      if (!input.fromAccountId) throw new BadRequestError('Bitte ein Microsoft-365-Konto wählen');
      setup = await setupTeams(this.ctx.accounts, userId, input.fromAccountId);
    } else {
      let baseUrl = input.baseUrl ?? '';
      let username = input.username ?? '';
      let password = input.password ?? '';
      if (input.fromAccountId) {
        const acc = this.ctx.accounts.get(userId, input.fromAccountId);
        if (acc.type !== 'nextcloud') throw new BadRequestError('Das gewählte Konto ist kein Nextcloud-Konto');
        baseUrl = String(acc.config.serverUrl ?? '');
        username = String(acc.config.username ?? '');
        password = String(acc.secrets.appPassword ?? '');
      }
      setup = await setupTalk({ baseUrl, username, password });
    }
    const duplicate = connectionStore
      .list(userId)
      .find((c) => c.type === input.type && c.baseUrl === setup.baseUrl && c.remoteUserId === setup.remoteUserId);
    if (duplicate) throw new BadRequestError('Diese Verbindung ist bereits eingerichtet');
    let host = setup.baseUrl;
    try {
      host = new URL(setup.baseUrl).host;
    } catch {
      /* egal */
    }
    const rec: Omit<ConnectionRecord, 'createdAt'> = {
      id: randomId(6),
      userId,
      type: input.type,
      label: input.label?.trim() || `${CHAT_BRIDGE_LABELS[input.type]} (${input.type === 'teams' ? setup.username : host})`,
      baseUrl: setup.baseUrl,
      username: setup.username,
      displayName: setup.displayName,
      remoteUserId: setup.remoteUserId,
      config: setup.config ?? {},
      secrets: setup.secrets,
    };
    connectionStore.insert(rec);
    const stored = connectionStore.get(rec.id)!;
    this.start(stored);
    return this.info(stored);
  }

  rename(userId: string, connectionId: string, label: string): ChatConnection {
    const b = this.get(userId, connectionId);
    connectionStore.setLabel(connectionId, label);
    b.conn.label = label;
    return this.info(b.conn);
  }

  restart(userId: string, connectionId: string): ChatConnection {
    const rec = connectionStore.get(connectionId);
    if (!rec || rec.userId !== userId) throw new NotFoundError('Verbindung');
    this.start(rec);
    return this.info(rec);
  }

  remove(userId: string, connectionId: string) {
    const rec = connectionStore.get(connectionId);
    if (!rec || rec.userId !== userId) throw new NotFoundError('Verbindung');
    this.bridges.get(connectionId)?.stop();
    this.bridges.delete(connectionId);
    this.status.delete(connectionId);
    connectionStore.delete(connectionId);
  }
}
