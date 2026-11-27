/**
 * Datenzugriff des Team-Chats: React-Query-Hooks, Cache-Aktualisierung aus
 * Echtzeit-Ereignissen und kleine Zustandsspeicher (Tippen, aktive Unterhaltung).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatCapabilities,
  type ChatCategory,
  type ChatConnection,
  type ChatConnectionInput,
  type ChatConversation,
  type ChatMessage,
  type ChatMessagePage,
  type ChatSettings,
  type ChatUser,
} from '@kuvert/shared';
import { api, apiUrl } from '@/lib/api';
import { useAppInfo, useSettings, useUpdateSettings } from '@/lib/queries';

export const chatKeys = {
  all: ['chat'] as const,
  users: ['chat', 'users'] as const,
  conversations: ['chat', 'conversations'] as const,
  messages: (id: string) => ['chat', 'messages', id] as const,
  search: (q: string) => ['chat', 'search', q] as const,
  connections: ['chat', 'connections'] as const,
  categories: ['chat', 'categories'] as const,
  participants: (id: string) => ['chat', 'participants', id] as const,
  remoteUsers: (connectionId: string, q: string) => ['chat', 'remote-users', connectionId, q] as const,
};

/** Seitenanker: älteste geladene Nachricht (seq für den Kuvert-Chat, id für verbundene Dienste) */
export type PageCursor = { seq: number; id: string } | undefined;
export type MessagesData = InfiniteData<ChatMessagePage, PageCursor>;

/** Brauchbare Nachricht (schützt die Ansicht vor Lücken oder fremden Objekten im Cache) */
export const isMessage = (m: unknown): m is ChatMessage =>
  !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'string' && typeof (m as ChatMessage).conversationId === 'string';

/** Kurzbeschreibung einer unerwarteten Antwort für Fehlermeldungen */
function describe(v: unknown): string {
  if (v === undefined || v === null) return 'leer';
  if (typeof v === 'string') return `Text „${v.slice(0, 60)}“`;
  if (Array.isArray(v)) return `Liste mit ${v.length} Einträgen`;
  return `Objekt mit ${Object.keys(v).slice(0, 5).join(', ') || 'keinen Feldern'}`;
}

/** Kuvert-Chat: alles erlaubt; verbundene Dienste melden ihre Möglichkeiten selbst */
export const FULL_CAPS: ChatCapabilities = { edit: true, delete: true, react: true, reply: true, files: true, typing: true, readReceipts: true, manage: true };
export const capsOf = (c: ChatConversation): ChatCapabilities => c.capabilities ?? FULL_CAPS;
export const isExternal = (id: string | null | undefined) => !!id && id.startsWith('x~');

/* ───────────────────────────── Abfragen ───────────────────────────── */

export function useMe(): string | undefined {
  return useAppInfo().data?.user?.id;
}

export function useChatUsers() {
  return useQuery({ queryKey: chatKeys.users, queryFn: () => api<ChatUser[]>('/chat/users'), staleTime: 5 * 60_000 });
}

/** Kuvert-Benutzer plus bekannte Personen aus verbundenen Diensten (Mattermost, Talk) */
export function useUserMap(): Map<string, ChatUser> {
  const { data } = useChatUsers();
  const { data: convs } = useConversations();
  return useMemo(() => {
    const map = new Map<string, ChatUser>();
    for (const c of convs ?? []) for (const p of c.participants ?? []) if (!map.has(p.id)) map.set(p.id, p);
    for (const u of data ?? []) map.set(u.id, u);
    return map;
  }, [data, convs]);
}

export function useConnections(enabled = true) {
  return useQuery({ queryKey: chatKeys.connections, queryFn: () => api<ChatConnection[]>('/chat/connections'), staleTime: 60_000, enabled });
}

/** Abschnitte der Seitenleiste verbundener Dienste (Mattermost) */
export function useCategories(enabled = true) {
  return useQuery({ queryKey: chatKeys.categories, queryFn: () => api<ChatCategory[]>('/chat/categories'), staleTime: 5 * 60_000, enabled });
}

/** Mitglieder einer Unterhaltung mit Namen (Detailansicht) */
export function useParticipants(conversationId: string, enabled = true) {
  return useQuery({
    queryKey: chatKeys.participants(conversationId),
    queryFn: () => api<ChatUser[]>(`/chat/conversations/${conversationId}/participants`),
    enabled,
    staleTime: 60_000,
  });
}

/** Personen eines verbundenen Dienstes suchen */
export function useRemoteUsers(connectionId: string | null, q: string) {
  return useQuery({
    queryKey: chatKeys.remoteUsers(connectionId ?? '', q),
    queryFn: ({ signal }) => api<ChatUser[]>(`/chat/connections/${connectionId}/users`, { query: { q }, signal }),
    enabled: !!connectionId && q.length >= 1,
    staleTime: 60_000,
  });
}

export function useConversations() {
  return useQuery({ queryKey: chatKeys.conversations, queryFn: () => api<ChatConversation[]>('/chat/conversations'), staleTime: 5 * 60_000 });
}

/** Ungelesene Nachrichten aller nicht stummgeschalteten Unterhaltungen (Badge in der Navigation) */
export function useUnreadTotal(): number {
  const { data } = useConversations();
  return useMemo(() => (data ?? []).reduce((n, c) => n + (c.muted ? 0 : c.unread), 0), [data]);
}

export function useMessages(conversationId: string) {
  return useInfiniteQuery({
    queryKey: chatKeys.messages(conversationId),
    queryFn: async ({ pageParam, signal }) => {
      const page = await api<ChatMessagePage>(`/chat/conversations/${conversationId}/messages`, {
        query: { before: pageParam?.seq, beforeId: isExternal(conversationId) ? pageParam?.id : undefined },
        signal,
      });
      // Unerwartete Antwort (kein { items: [...] }) als Fehler anzeigen statt die Ansicht abstürzen zu lassen
      if (!page || !Array.isArray(page.items)) {
        console.error('[Kuvert] Ungültige Antwort beim Laden der Nachrichten', conversationId, page);
        throw new Error(`Nachrichten konnten nicht geladen werden (ungültige Antwort vom Server: ${describe(page)})`);
      }
      return { ...page, items: page.items.filter(isMessage) };
    },
    initialPageParam: undefined as PageCursor,
    // Seiten: [neueste, ältere, noch ältere …]; jede Seite aufsteigend sortiert
    getNextPageParam: (last): PageCursor => {
      const first = last?.items?.[0];
      return last?.hasMore && first ? { seq: first.seq, id: first.id } : undefined;
    },
    staleTime: 5 * 60_000,
  });
}

export function useChatSearch(q: string) {
  return useQuery({
    queryKey: chatKeys.search(q),
    queryFn: ({ signal }) => api<ChatMessage[]>('/chat/search', { query: { q }, signal }),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

export function useChatSettings(): { settings: ChatSettings; update: (patch: Partial<ChatSettings>) => Promise<unknown> } {
  const { settings } = useSettings();
  const mutation = useUpdateSettings();
  const current: ChatSettings = { ...DEFAULT_CHAT_SETTINGS, ...((settings.modules?.chat as Partial<ChatSettings> | undefined) ?? {}) };
  return {
    settings: current,
    update: (patch) => mutation.mutateAsync({ modules: { ...(settings.modules ?? {}), chat: { ...current, ...patch } } }),
  };
}

export const fileUrl = (id: string, inline = false) => apiUrl(`/chat/files/${id}`, inline ? { inline: 1 } : undefined);

/* ───────────────────────────── Aktionen ───────────────────────────── */

export const chatApi = {
  openDirect: (userId: string, connectionId?: string | null) => api<ChatConversation>('/chat/conversations', { body: { kind: 'direct', userId, connectionId } }),
  createGroup: (name: string, memberIds: string[], description?: string, connectionId?: string | null) =>
    api<ChatConversation>('/chat/conversations', { body: { kind: 'group', name, memberIds, description, connectionId } }),
  update: (id: string, patch: { name?: string; description?: string | null }) => api<ChatConversation>(`/chat/conversations/${id}`, { method: 'PATCH', body: patch }),
  prefs: (id: string, prefs: { muted?: boolean; pinned?: boolean }) => api<ChatConversation>(`/chat/conversations/${id}/prefs`, { method: 'PUT', body: prefs }),
  addMembers: (id: string, userIds: string[]) => api<ChatConversation>(`/chat/conversations/${id}/members`, { body: { userIds } }),
  setRole: (id: string, userId: string, role: 'owner' | 'member') =>
    api<ChatConversation>(`/chat/conversations/${id}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (id: string, userId: string) => api(`/chat/conversations/${id}/members/${userId}`, { method: 'DELETE' }),
  send: (id: string, body: string, opts: { replyToId?: string | null; uploadIds?: string[] } = {}) =>
    api<ChatMessage>(`/chat/conversations/${id}/messages`, { body: { body, ...opts } }),
  edit: (messageId: string, body: string) => api<ChatMessage>(`/chat/messages/${messageId}`, { method: 'PATCH', body: { body } }),
  remove: (messageId: string) => api<ChatMessage>(`/chat/messages/${messageId}`, { method: 'DELETE' }),
  react: (messageId: string, emoji: string) => api<ChatMessage>(`/chat/messages/${messageId}/reactions`, { body: { emoji } }),
  read: (id: string, seq?: number) => api<{ ok: boolean; seq: number | null }>(`/chat/conversations/${id}/read`, { body: seq ? { seq } : {} }),
  typing: (id: string) => api(`/chat/conversations/${id}/typing`, { method: 'POST', body: {} }),
  /* Verbundene Dienste */
  addConnection: (input: ChatConnectionInput) => api<ChatConnection>('/chat/connections', { body: input }),
  renameConnection: (id: string, label: string) => api<ChatConnection>(`/chat/connections/${id}`, { method: 'PATCH', body: { label } }),
  restartConnection: (id: string) => api<ChatConnection>(`/chat/connections/${id}/restart`, { method: 'POST', body: {} }),
  removeConnection: (id: string) => api(`/chat/connections/${id}`, { method: 'DELETE' }),
};

/* ───────────────────────────── Cache-Pflege ───────────────────────────── */

/** Nachricht einfügen oder ersetzen (dedupliziert über die ID – Antwort und SSE kommen beide an) */
export function upsertMessage(qc: QueryClient, m: ChatMessage | null | undefined) {
  if (!isMessage(m)) return;
  qc.setQueryData<MessagesData>(chatKeys.messages(m.conversationId), (data) => {
    if (!data?.pages?.length) return data;
    let found = false;
    const pages = data.pages.map((p) => {
      const list = p?.items ?? [];
      const idx = list.findIndex((x) => x?.id === m.id);
      if (idx === -1) return p;
      found = true;
      const items = list.slice();
      items[idx] = m;
      return { ...p, items };
    });
    if (found) return { ...data, pages };
    const newest = pages[0]!;
    const items = [...(newest?.items ?? []), m].sort((a, b) => a.seq - b.seq);
    return { ...data, pages: [{ ...newest, items }, ...pages.slice(1)] };
  });
}

export function patchConversations(qc: QueryClient, fn: (list: ChatConversation[]) => ChatConversation[]) {
  qc.setQueryData<ChatConversation[]>(chatKeys.conversations, (list) => (list ? fn(list) : list));
}

export function replaceConversation(qc: QueryClient, conv: ChatConversation) {
  patchConversations(qc, (list) => (list.some((c) => c.id === conv.id) ? list.map((c) => (c.id === conv.id ? conv : c)) : [conv, ...list]));
}

/** Neue Nachricht in der Unterhaltungsliste vermerken. false = Unterhaltung unbekannt (Liste neu laden). */
export function applyNewMessage(qc: QueryClient, m: ChatMessage, me: string | undefined, countUnread: boolean): boolean {
  const list = qc.getQueryData<ChatConversation[]>(chatKeys.conversations);
  if (!list?.some((c) => c.id === m.conversationId)) return false;
  patchConversations(qc, (l) =>
    l.map((c) => {
      if (c.id !== m.conversationId) return c;
      if (c.lastMessage && c.lastMessage.seq > m.seq) return c;
      const fromOther = m.kind === 'text' && m.senderId !== me;
      return {
        ...c,
        lastMessage: m,
        lastMessageAt: m.createdAt,
        unread: countUnread && fromOther ? c.unread + 1 : c.unread,
      };
    }),
  );
  return true;
}

/** Lesestand eines Mitglieds übernehmen; für mich selbst zusätzlich den Zähler zurücksetzen */
export function applyRead(qc: QueryClient, conversationId: string, userId: string, seq: number, me: string | undefined) {
  patchConversations(qc, (l) =>
    l.map((c) => {
      if (c.id !== conversationId) return c;
      const members = c.members.map((m) => (m.userId === userId && m.lastReadSeq < seq ? { ...m, lastReadSeq: seq } : m));
      const unread = userId === me && (!c.lastMessage || seq >= c.lastMessage.seq) ? 0 : c.unread;
      return { ...c, members, unread };
    }),
  );
}

/* ───────────────────────────── Anzeige-Helfer ───────────────────────────── */

export function otherMember(c: ChatConversation, me: string | undefined): string | undefined {
  return c.members.find((m) => m.userId !== me)?.userId;
}

export function conversationTitle(c: ChatConversation, me: string | undefined, users: Map<string, ChatUser>): string {
  if (c.kind === 'group') return c.name || 'Gruppe';
  const other = otherMember(c, me);
  return (other && users.get(other)?.name) || c.name || 'Ehemaliger Benutzer';
}

export function userName(id: string | null | undefined, users: Map<string, ChatUser>, me?: string): string {
  if (!id) return 'Ehemaliger Benutzer';
  if (id === me) return 'Du';
  return users.get(id)?.name ?? (isExternal(id) ? 'Unbekannt' : 'Ehemaliger Benutzer');
}

/** Personen aus geladenen Nachrichten verbundener Dienste ergänzen (Absender, die nicht unter participants stehen) */
export function withSenders(users: Map<string, ChatUser>, messages: ChatMessage[]): Map<string, ChatUser> {
  let map: Map<string, ChatUser> | null = null;
  for (const m of messages) {
    if (!m?.senderId || !m.senderName || users.has(m.senderId) || map?.has(m.senderId)) continue;
    map ??= new Map(users);
    map.set(m.senderId, { id: m.senderId, name: m.senderName, email: '', avatarUrl: `/api/chat/ext/avatar/${m.senderId}`, online: false });
  }
  return map ?? users;
}

/** Kurzbezeichnung eines Dienstes für Listen */
export const sourceShort = (type: string) => (type === 'mattermost' ? 'Mattermost' : type === 'teams' ? 'Teams' : 'Talk');

/* ───────────────────────────── Tippen ───────────────────────────── */

const TYPING_MS = 5_000;
const typing = new Map<string, Map<string, number>>();
const typingSnapshots = new Map<string, string[]>();
const typingListeners = new Set<() => void>();
const EMPTY: string[] = [];

function emitTyping(conversationId: string) {
  const users = typing.get(conversationId);
  typingSnapshots.set(conversationId, users ? [...users.keys()] : EMPTY);
  typingListeners.forEach((l) => l());
}

export const typingStore = {
  start(conversationId: string, userId: string) {
    let users = typing.get(conversationId);
    if (!users) typing.set(conversationId, (users = new Map()));
    const prev = users.get(userId);
    if (prev) clearTimeout(prev);
    users.set(
      userId,
      window.setTimeout(() => this.stop(conversationId, userId), TYPING_MS),
    );
    emitTyping(conversationId);
  },
  stop(conversationId: string, userId: string) {
    const users = typing.get(conversationId);
    const t = users?.get(userId);
    if (!users || t === undefined) return;
    clearTimeout(t);
    users.delete(userId);
    if (!users.size) typing.delete(conversationId);
    emitTyping(conversationId);
  },
};

export function useTyping(conversationId: string): string[] {
  return useSyncExternalStore(
    (cb) => {
      typingListeners.add(cb);
      return () => typingListeners.delete(cb);
    },
    () => typingSnapshots.get(conversationId) ?? EMPTY,
  );
}

/* ───────────────────────────── Aktive Unterhaltung ───────────────────────────── */

/** Welche Unterhaltung gerade angezeigt wird (für Benachrichtigungen) */
export const activeChat = { id: null as string | null };

/* ───────────────────────────── Entwürfe ───────────────────────────── */

/** Entwürfe pro Unterhaltung bleiben beim Wechseln erhalten (nur im Speicher des Tabs) */
export const drafts = new Map<string, string>();
