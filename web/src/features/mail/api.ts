/**
 * Datenzugriff des Mail-Bereichs: Query-Keys, Abrufe und Aktionen
 * (inkl. optimistischer Aktualisierung der Listen-Caches).
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type {
  FolderListResult,
  FolderRole,
  MailFolder,
  MailIdentity,
  MessageDetail,
  MessageSummary,
  Paged,
  ScheduledSend,
  ThreadQuery,
  ThreadResult,
} from '@kuvert/shared';
import { api } from '@/lib/api';
import { notifyOtherWindows } from '@/lib/events';

/* ───────────────────────────── Ansichten ───────────────────────────── */

export type ListView =
  | { kind: 'unified'; role: FolderRole; flaggedOnly?: boolean; unreadOnly?: boolean }
  | { kind: 'folder'; accountId: string; folderId: string; unreadOnly?: boolean; flaggedOnly?: boolean; search?: string }
  | { kind: 'search'; q: string; accountId?: string };

export interface MessageRef {
  accountId: string;
  folderId: string;
  id: string;
}

export const refKey = (r: MessageRef) => `${r.accountId}|${r.folderId}|${r.id}`;
export const toRef = (m: Pick<MessageSummary, 'accountId' | 'folderId' | 'id'>): MessageRef => ({ accountId: m.accountId, folderId: m.folderId, id: m.id });

export type ListPage = Paged<MessageSummary> & {
  errors?: { accountId: string; account: string; message: string }[];
  /** Nur bei Suchen: Trefferzahl, Dauer, Herkunft (Index/Live) */
  meta?: { total: number; processingTimeMs: number; indexed: boolean; liveAccounts: string[] };
};

export const mailKeys = {
  all: ['mail'] as const,
  folders: (accountId: string) => ['mail', 'folders', accountId] as const,
  lists: ['mail', 'list'] as const,
  list: (view: ListView) => ['mail', 'list', view] as const,
  message: (accountId: string, folderId: string, id: string) => ['mail', 'message', accountId, folderId, id] as const,
  identities: (accountId: string) => ['mail', 'identities', accountId] as const,
  scheduled: ['mail', 'scheduled'] as const,
  threads: ['mail', 'thread'] as const,
  thread: (accountId: string, key: string) => ['mail', 'thread', accountId, key] as const,
};

const PAGE = 50;

export async function fetchListPage(view: ListView, cursor?: string): Promise<ListPage> {
  if (view.kind === 'unified') {
    return api<ListPage>('/mail/unified', {
      query: { role: view.role, cursor, limit: PAGE, flaggedOnly: view.flaggedOnly || undefined, unreadOnly: view.unreadOnly || undefined },
    });
  }
  if (view.kind === 'search') {
    const r = await api<{
      items: MessageSummary[];
      errors: ListPage['errors'];
      total?: number;
      processingTimeMs?: number;
      indexed?: boolean;
      liveAccounts?: string[];
      nextCursor?: string | null;
    }>('/mail/search', {
      query: { q: view.q, accountId: view.accountId, limit: PAGE, offset: cursor ? Number(cursor) : undefined },
    });
    return {
      items: r.items,
      nextCursor: r.nextCursor ?? null,
      errors: r.errors,
      meta: { total: r.total ?? r.items.length, processingTimeMs: r.processingTimeMs ?? 0, indexed: !!r.indexed, liveAccounts: r.liveAccounts ?? [] },
    };
  }
  const page = await api<Paged<MessageSummary>>(`/mail/accounts/${view.accountId}/messages`, {
    query: {
      folderId: view.folderId,
      cursor,
      limit: PAGE,
      search: view.search,
      unreadOnly: view.unreadOnly || undefined,
      flaggedOnly: view.flaggedOnly || undefined,
    },
  });
  // Provider liefern accountId/folderId nicht zwingend – hier ergänzen
  return {
    ...page,
    items: page.items.map((m) => ({ ...m, accountId: m.accountId || view.accountId, folderId: m.folderId || view.folderId })),
  };
}

export const fetchFolders = (accountId: string) => api<FolderListResult>(`/mail/accounts/${accountId}/folders`);
export const fetchMessage = (r: MessageRef) =>
  api<MessageDetail>(`/mail/accounts/${r.accountId}/message`, { query: { folderId: r.folderId, id: r.id } }).then((m) => ({
    ...m,
    accountId: m.accountId || r.accountId,
    folderId: m.folderId || r.folderId,
    id: m.id || r.id,
  }));
/** Unterhaltung ordnerübergreifend (Gesendet, Archiv, Papierkorb …) */
export const fetchThread = (accountId: string, q: ThreadQuery) => api<ThreadResult>(`/mail/accounts/${accountId}/thread`, { method: 'POST', body: q });

export const fetchIdentities = (accountId: string) => api<MailIdentity[]>(`/mail/accounts/${accountId}/identities`);
export const fetchScheduled = () => api<ScheduledSend[]>('/mail/scheduled');

export function attachmentUrl(r: MessageRef, attachmentId: string, inline = false) {
  const q = new URLSearchParams({ folderId: r.folderId, id: r.id, attachmentId });
  if (inline) q.set('inline', '1');
  return `/api/mail/accounts/${r.accountId}/attachment?${q.toString()}`;
}

export function rawUrl(r: MessageRef) {
  const q = new URLSearchParams({ folderId: r.folderId, id: r.id });
  return `/api/mail/accounts/${r.accountId}/raw?${q.toString()}`;
}

/* ───────────────────────────── Gruppierung ───────────────────────────── */

/** Gruppiert Referenzen nach Konto+Ordner (Server-Aktionen arbeiten je Ordner) */
export function groupRefs(refs: MessageRef[]): { accountId: string; folderId: string; ids: string[] }[] {
  const map = new Map<string, { accountId: string; folderId: string; ids: string[] }>();
  for (const r of refs) {
    const k = `${r.accountId}|${r.folderId}`;
    let g = map.get(k);
    if (!g) map.set(k, (g = { accountId: r.accountId, folderId: r.folderId, ids: [] }));
    g.ids.push(r.id);
  }
  return [...map.values()];
}

/* ───────────────────────────── Cache-Helfer ───────────────────────────── */

type ListData = InfiniteData<ListPage, string | undefined>;

function matches(set: Set<string>, m: MessageSummary) {
  return set.has(refKey(toRef(m)));
}

/** Patcht Nachrichten in allen Listen- und Detail-Caches */
export function patchMessages(qc: QueryClient, refs: MessageRef[], patch: Partial<MessageSummary>) {
  const set = new Set(refs.map(refKey));
  qc.setQueriesData<ListData>({ queryKey: mailKeys.lists }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((m) => (matches(set, m) ? { ...m, ...patch } : m)) })) }
      : data,
  );
  qc.setQueriesData<ThreadResult>({ queryKey: mailKeys.threads }, (data) =>
    data ? { ...data, items: data.items.map((m) => (matches(set, m) ? { ...m, ...patch } : m)) } : data,
  );
  for (const r of refs) {
    qc.setQueryData<MessageDetail>(mailKeys.message(r.accountId, r.folderId, r.id), (d) => (d ? { ...d, ...patch } : d));
  }
}

/** Zuletzt verschobene/gelöschte Nachrichten (z. B. damit sie beim Verlassen nicht mehr als gelesen markiert werden) */
const removedRefs = new Set<string>();
export const wasRemoved = (ref: MessageRef) => removedRefs.has(refKey(ref));

/** Entfernt Nachrichten aus allen Listen-Caches (nach Verschieben/Löschen) */
export function removeMessages(qc: QueryClient, refs: MessageRef[]) {
  const set = new Set(refs.map(refKey));
  for (const k of set) removedRefs.add(k);
  qc.setQueriesData<ListData>({ queryKey: mailKeys.lists }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((m) => !matches(set, m)) })) } : data,
  );
  // Aus Unterhaltungen ebenfalls entfernen – nach dem Neuladen erscheinen sie ggf. im neuen Ordner (Archiv, Papierkorb)
  qc.setQueriesData<ThreadResult>({ queryKey: mailKeys.threads }, (data) => (data ? { ...data, items: data.items.filter((m) => !matches(set, m)) } : data));
}

/** Ungelesen-Zähler eines Ordners lokal anpassen */
export function adjustUnread(qc: QueryClient, accountId: string, folderId: string, delta: number) {
  if (!delta) return;
  qc.setQueryData<FolderListResult>(mailKeys.folders(accountId), (d) =>
    d
      ? {
          ...d,
          folders: d.folders.map((f) => (f.id === folderId && f.unread !== undefined ? { ...f, unread: Math.max(0, f.unread + delta) } : f)),
        }
      : d,
  );
}

/* ───────────────────────────── Aktionen ───────────────────────────── */

export async function setFlags(qc: QueryClient, refs: MessageRef[], flags: { seen?: boolean; flagged?: boolean }, prev?: MessageSummary[]) {
  if (!refs.length) return;
  patchMessages(qc, refs, flags);
  if (flags.seen !== undefined && prev) {
    for (const m of prev) if (m.seen !== flags.seen) adjustUnread(qc, m.accountId, m.folderId, flags.seen ? -1 : 1);
  }
  try {
    await Promise.all(groupRefs(refs).map((g) => api(`/mail/accounts/${g.accountId}/flags`, { method: 'POST', body: { folderId: g.folderId, ids: g.ids, ...flags } })));
  } finally {
    void qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    notifyOtherWindows(mailKeys.all);
  }
}

export async function moveMessages(qc: QueryClient, refs: MessageRef[], targetFolderId: string) {
  removeMessages(qc, refs);
  try {
    await Promise.all(
      groupRefs(refs).map((g) => api(`/mail/accounts/${g.accountId}/move`, { method: 'POST', body: { folderId: g.folderId, ids: g.ids, targetFolderId } })),
    );
  } finally {
    void qc.invalidateQueries({ queryKey: mailKeys.all });
    notifyOtherWindows(mailKeys.all);
  }
}

export async function moveToRole(qc: QueryClient, refs: MessageRef[], role: 'inbox' | 'archive' | 'junk' | 'trash') {
  removeMessages(qc, refs);
  try {
    await Promise.all(
      groupRefs(refs).map((g) => api(`/mail/accounts/${g.accountId}/move-to-role`, { method: 'POST', body: { folderId: g.folderId, ids: g.ids, role } })),
    );
  } finally {
    void qc.invalidateQueries({ queryKey: mailKeys.all });
    notifyOtherWindows(mailKeys.all);
  }
}

export async function deleteMessages(qc: QueryClient, refs: MessageRef[], permanent?: boolean) {
  removeMessages(qc, refs);
  try {
    await Promise.all(
      groupRefs(refs).map((g) => api(`/mail/accounts/${g.accountId}/delete`, { method: 'POST', body: { folderId: g.folderId, ids: g.ids, permanent } })),
    );
  } finally {
    void qc.invalidateQueries({ queryKey: mailKeys.all });
    notifyOtherWindows(mailKeys.all);
  }
}

/* ───────────────────────────── Ordner ───────────────────────────── */

export const ROLE_LABELS: Record<FolderRole, string> = {
  inbox: 'Posteingang',
  sent: 'Gesendet',
  drafts: 'Entwürfe',
  trash: 'Papierkorb',
  junk: 'Spam',
  archive: 'Archiv',
  outbox: 'Postausgang',
  other: '',
};

const ROLE_ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'outbox', 'archive', 'junk', 'trash', 'other'];

export function folderLabel(f: MailFolder): string {
  return f.role !== 'other' && ROLE_LABELS[f.role] ? ROLE_LABELS[f.role] : f.name;
}

export interface FolderNode {
  folder: MailFolder;
  children: FolderNode[];
  depth: number;
}

/** Baut einen sortierten Ordnerbaum (Rollen-Ordner zuerst) */
export function buildFolderTree(folders: MailFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.id, { folder: f, children: [], depth: 0 });
  const roots: FolderNode[] = [];
  for (const n of byId.values()) {
    const parent = n.folder.parentId ? byId.get(n.folder.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (nodes: FolderNode[], depth: number) => {
    nodes.sort((a, b) => {
      const ra = ROLE_ORDER.indexOf(a.folder.role);
      const rb = ROLE_ORDER.indexOf(b.folder.role);
      if (depth === 0 && ra !== rb) return ra - rb;
      return folderLabel(a.folder).localeCompare(folderLabel(b.folder), 'de');
    });
    for (const n of nodes) {
      n.depth = depth;
      sort(n.children, depth + 1);
    }
  };
  sort(roots, 0);
  return roots;
}

export function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/* ───────────────────────────── Route-Kodierung ───────────────────────────── */

/** URL-sichere Kodierung beliebiger IDs (Ordner-IDs können "/" enthalten) */
export function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): string {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

export function folderPath(accountId: string, folderId: string) {
  return `/mail/f/${accountId}/${b64url(folderId)}`;
}

/** Einladung aus der Mail beantworten (zusagen, mit Vorbehalt, absagen) */
export const respondToInvite = (r: MessageRef, response: 'accept' | 'tentative' | 'decline', comment?: string) =>
  api<{ ok: true }>(`/mail/accounts/${r.accountId}/invite/respond`, { method: 'POST', body: { folderId: r.folderId, id: r.id, response, comment } });
