import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, BellOff, ChevronDown, MessageSquarePlus, MessagesSquare, Phone, Search, Star, Users, UserRound } from 'lucide-react';
import type { ChatCategory, ChatConversation, ChatUser } from '@kuvert/shared';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button, Dropdown, EmptyState, IconButton, Input, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn, formatListDate } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import {
  conversationTitle,
  replaceConversation,
  sourceShort,
  useCategories,
  useChatSearch,
  useChatSettings,
  useConnections,
  useConversations,
  useMe,
  useTyping,
  useUserMap,
} from './api';
import { ConversationAvatar } from './components';
import { ConversationView } from './ConversationView';
import { bodyOf, previewOf, systemText } from './format';
import { NewChatDialog, type NewChatMode } from './NewChatDialog';

export default function ChatPage() {
  const params = useParams();
  const id = (params['*'] ?? '').split('/')[0] || null;
  const [searchParams, setSearchParams] = useSearchParams();
  const jumpSeq = Number(searchParams.get('m')) || null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [newChat, setNewChat] = useState<NewChatMode | null>(null);
  const { data: list, isLoading, error } = useConversations();

  // Unterhaltung nicht in der Liste (z. B. leere Direktnachricht eines anderen) → einzeln laden
  const fromList = list?.find((c) => c.id === id);
  const single = useQuery({
    queryKey: ['chat', 'conversation', id],
    queryFn: () => api<ChatConversation>(`/chat/conversations/${id}`),
    enabled: !!id && !!list && !fromList,
    retry: false,
  });
  useEffect(() => {
    if (single.data && !fromList) replaceConversation(qc, single.data);
  }, [single.data, fromList, qc]);
  const conversation = fromList ?? single.data ?? null;

  const listPane = (
    <ConversationList
      list={list}
      loading={isLoading}
      error={error}
      activeId={id}
      onNew={setNewChat}
      onOpen={(cid, seq) => navigate(seq ? `/chat/${cid}?m=${seq}` : `/chat/${cid}`)}
    />
  );

  const detail = conversation ? (
    <ErrorBoundary key={conversation.id} label="Unterhaltung">
      <ConversationView
        conversation={conversation}
        onBack={isMobile ? () => navigate('/chat') : undefined}
        jumpSeq={jumpSeq}
        onJumpDone={() => setSearchParams({}, { replace: true })}
      />
    </ErrorBoundary>
  ) :id && (single.isLoading || isLoading) ? (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  ) : id ? (
    <EmptyState icon={<MessagesSquare />} title="Unterhaltung nicht gefunden">
      Die Unterhaltung existiert nicht oder du bist kein Mitglied mehr.
    </EmptyState>
  ) : (
    <EmptyState icon={<MessagesSquare />} title="Team-Chat">
      <p>Wähle links eine Unterhaltung aus oder starte eine neue – mit einzelnen Kolleginnen und Kollegen oder als Gruppe.</p>
      <p className="mt-2 text-xs">Mattermost und Nextcloud Talk lassen sich unter Einstellungen → Chat zusätzlich anbinden.</p>
      <div className="mt-4 flex justify-center gap-2">
        <Button icon={<UserRound className="h-4 w-4" />} onClick={() => setNewChat('direct')}>
          Direktnachricht
        </Button>
        <Button variant="primary" icon={<Users className="h-4 w-4" />} onClick={() => setNewChat('group')}>
          Gruppe erstellen
        </Button>
      </div>
    </EmptyState>
  );

  return (
    <>
      {isMobile ? (
        <div className="h-full min-h-0">{id ? detail : listPane}</div>
      ) : (
        <div className="flex h-full min-h-0">
          <aside className="flex w-[clamp(280px,30%,360px)] shrink-0 flex-col border-r border-border bg-surface">{listPane}</aside>
          <section className="min-h-0 min-w-0 flex-1 bg-bg">{detail}</section>
        </div>
      )}
      {newChat && <NewChatDialog mode={newChat} onClose={() => setNewChat(null)} />}
    </>
  );
}

/* ═════════════════════════════ Liste ═════════════════════════════ */

export function ConversationList({
  list,
  loading,
  error,
  activeId,
  onNew,
  onOpen,
  headerExtra,
}: {
  list?: ChatConversation[];
  loading: boolean;
  error: unknown;
  activeId: string | null;
  onNew(mode: NewChatMode): void;
  onOpen(id: string, seq?: number): void;
  /** Zusätzliche Knöpfe im Kopf (z. B. im Panel der Seitenleiste „Im Chat öffnen“) */
  headerExtra?: ReactNode;
}) {
  const me = useMe();
  const users = useUserMap();
  const { data: connections } = useConnections();
  /** 'all' | 'kuvert' | Verbindungs-ID */
  const [source, setSource] = useState('all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useChatSearch(debounced);

  const { settings, update: updateSettings } = useChatSettings();
  const sortMode = settings.listSort;
  const { data: allCategories } = useCategories(!!connections?.some((c) => c.type === 'mattermost'));
  // Abschnitte wie im Dienst nur, wenn genau eine Mattermost-Verbindung gefiltert ist
  const categories = useMemo(() => (allCategories ?? []).filter((c) => c.connectionId === source), [allCategories, source]);
  const [collapsed, setCollapsed] = useCollapsedSections();

  const filtered = useMemo(() => {
    const term = q.trim().toLocaleLowerCase('de');
    return (list ?? [])
      .filter((c) => source === 'all' || (source === 'kuvert' ? !c.source : c.source?.connectionId === source))
      .filter((c) => {
        if (!term) return true;
        const names = c.members.map((m) => users.get(m.userId)?.name ?? '').join(' ');
        return `${conversationTitle(c, me, users)} ${names}`.toLocaleLowerCase('de').includes(term);
      });
  }, [list, q, users, me, source]);

  /** Ungelesene je Filter (ohne stummgeschaltete), für die Zähler an den Dienst-Filtern */
  const unreadBySource = useMemo(() => {
    const counts = new Map<string, number>();
    const add = (key: string, n: number) => counts.set(key, (counts.get(key) ?? 0) + n);
    for (const c of list ?? []) {
      if (c.muted || c.unread <= 0) continue;
      add('all', c.unread);
      add(c.source ? c.source.connectionId : 'kuvert', c.unread);
    }
    return counts;
  }, [list]);

  const sections = useMemo((): Section[] => {
    const sortBy = (items: ChatConversation[], mode: ChatCategory['sorting']) => {
      if (mode === 'manual') return items;
      const copy = [...items];
      if (mode === 'alpha') return copy.sort((a, b) => conversationTitle(a, me, users).localeCompare(conversationTitle(b, me, users), 'de'));
      return copy.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    };
    // Suche: eine flache Liste
    if (q.trim()) return [{ key: 'search', title: null, items: sortBy(filtered, sortMode) }];
    // Mattermost: Abschnitte, Reihenfolge und Sortierung wie im echten Client
    if (categories.length) {
      const byId = new Map(filtered.map((c) => [c.id, c]));
      const used = new Set<string>();
      const out: Section[] = [];
      for (const cat of categories) {
        const items = cat.conversationIds.map((id) => byId.get(id)).filter((c): c is ChatConversation => !!c && !used.has(c.id));
        items.forEach((c) => used.add(c.id));
        if (!items.length) continue;
        out.push({ key: cat.id, title: cat.name, context: cat.context, items: sortBy(items, cat.sorting), defaultCollapsed: cat.collapsed });
      }
      const rest = filtered.filter((c) => !used.has(c.id));
      if (rest.length) out.push({ key: `${source}:rest`, title: 'Weitere', items: sortBy(rest, 'recent') });
      return out;
    }
    // Sonst: Favoriten oben, darunter alle übrigen
    const favorites = filtered.filter((c) => c.pinned);
    const others = filtered.filter((c) => !c.pinned);
    if (!favorites.length) return [{ key: 'all', title: null, items: sortBy(others, sortMode) }];
    return [
      { key: 'favorites', title: 'Favoriten', items: sortBy(favorites, sortMode) },
      ...(others.length ? [{ key: 'others', title: 'Unterhaltungen', items: sortBy(others, sortMode) }] : []),
    ];
  }, [filtered, categories, q, sortMode, me, users, source]);

  const convMap = useMemo(() => new Map((list ?? []).map((c) => [c.id, c])), [list]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="flex-1 text-[15px] font-semibold tracking-tight">Chat</h1>
        <Dropdown
          align="right"
          trigger={
            <IconButton label="Sortierung">
              <ArrowDownUp className="h-[18px] w-[18px]" />
            </IconButton>
          }
          items={[
            { label: 'Neueste zuerst', checked: sortMode === 'recent', onClick: () => void updateSettings({ listSort: 'recent' }) },
            { label: 'Alphabetisch', checked: sortMode === 'alpha', onClick: () => void updateSettings({ listSort: 'alpha' }) },
            ...(categories.length
              ? [{ divider: true, label: '' }, { label: <span className="block whitespace-normal text-xs text-muted">Die Abschnitte folgen der Sortierung aus Mattermost</span>, disabled: true }]
              : []),
          ]}
        />
        <Dropdown
          align="right"
          trigger={
            <IconButton label="Neue Unterhaltung" variant="soft" className="text-primary hover:text-primary">
              <MessageSquarePlus className="h-[18px] w-[18px]" />
            </IconButton>
          }
          items={[
            { label: 'Neue Direktnachricht', icon: <UserRound />, onClick: () => onNew('direct') },
            { label: 'Neue Gruppe', icon: <Users />, onClick: () => onNew('group') },
          ]}
        />
        {headerExtra}
      </div>
      <div className="shrink-0 p-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Unterhaltungen & Nachrichten suchen" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!!connections?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[{ id: 'all', label: 'Alle' }, { id: 'kuvert', label: 'Kuvert' }, ...connections.map((c) => ({ id: c.id, label: c.label }))].map((f) => {
              const unread = unreadBySource.get(f.id) ?? 0;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSource(f.id)}
                  title={unread ? `${f.label} · ${unread} ungelesen` : f.label}
                  className={cn(
                    'flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                    source === f.id ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border text-muted hover:bg-hover',
                  )}
                >
                  <span className="truncate">{f.label}</span>
                  {unread > 0 && (
                    <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-primary-fg">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-danger">{errorMessage(error)}</div>
        ) : !list?.length ? (
          <EmptyState icon={<MessagesSquare />} title="Noch keine Unterhaltungen">
            <Button variant="primary" size="sm" className="mt-2" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => onNew('direct')}>
              Unterhaltung starten
            </Button>
          </EmptyState>
        ) : (
          <>
            {sections.map((sec) => {
              const isCollapsed = sec.title ? (collapsed[sec.key] ?? !!sec.defaultCollapsed) : false;
              // Eingeklappt: wie in Mattermost bleiben ungelesene und die geöffnete Unterhaltung sichtbar
              const visible = isCollapsed ? sec.items.filter((c) => (c.unread > 0 && !c.muted) || c.id === activeId) : sec.items;
              const unread = sec.items.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
              return (
                <div key={sec.key} className={cn(sec.title && 'mt-1.5 first:mt-0')}>
                  {sec.title && (
                    <button
                      type="button"
                      onClick={() => setCollapsed(sec.key, !isCollapsed)}
                      className="group flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-fg"
                    >
                      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')} />
                      <span className="min-w-0 truncate">{sec.title}</span>
                      {sec.context && <span className="min-w-0 truncate font-normal normal-case text-subtle">· {sec.context}</span>}
                      <span className="ml-auto pl-2 font-normal tabular-nums text-subtle">{isCollapsed && unread ? unread : sec.items.length}</span>
                    </button>
                  )}
                  {visible.map((c) => (
                    <ConversationRow key={c.id} c={c} me={me} users={users} active={c.id === activeId} onClick={() => onOpen(c.id)} />
                  ))}
                </div>
              );
            })}
            {q.trim() && !filtered.length && <div className="px-3 py-4 text-center text-sm text-muted">Keine passende Unterhaltung</div>}
          </>
        )}

        {debounced.length >= 2 && (
          <div className="mt-3">
            <div className="flex items-center gap-2 px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Nachrichten {hits.isFetching && <Spinner className="h-3 w-3" />}
            </div>
            {hits.data?.length === 0 && <div className="px-2 py-2 text-sm text-muted">Keine Treffer</div>}
            {hits.data?.map((m) => {
              const c = convMap.get(m.conversationId);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onOpen(m.conversationId, m.seq)}
                  className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-hover"
                >
                  <span className="flex items-baseline gap-2 text-xs text-muted">
                    <span className="min-w-0 flex-1 truncate font-medium text-fg">
                      {users.get(m.senderId ?? '')?.name ?? m.senderName ?? 'Unbekannt'}
                      {c && c.kind === 'group' && <span className="font-normal text-muted"> in {c.name}</span>}
                      {c?.source && <span className="font-normal text-subtle"> · {sourceShort(c.source.type)}</span>}
                    </span>
                    {formatListDate(m.createdAt)}
                  </span>
                  <span className="line-clamp-2 text-sm">
                    <Highlight text={previewOf(bodyOf(m), m.attachments.length)} term={debounced} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface Section {
  key: string;
  /** null = ohne Überschrift (eine einzige Liste) */
  title: string | null;
  context?: string | null;
  items: ChatConversation[];
  defaultCollapsed?: boolean;
}

const COLLAPSED_KEY = 'kuvert.chat.collapsed';

/** Eingeklappte Abschnitte merken (nur in diesem Browser) */
function useCollapsedSections(): [Record<string, boolean>, (key: string, value: boolean) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const set = (key: string, value: boolean) =>
    setState((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* egal */
      }
      return next;
    });
  return [state, set];
}

function Highlight({ text, term }: { text: string; term: string }) {
  const idx = text.toLocaleLowerCase('de').indexOf(term.toLocaleLowerCase('de'));
  if (idx < 0) return <>{text}</>;
  const start = Math.max(0, idx - 40);
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, idx)}
      <mark className="rounded bg-warning/25 px-0.5 text-fg">{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  );
}

function ConversationRow({ c, me, users, active, onClick }: { c: ChatConversation; me?: string; users: Map<string, ChatUser>; active: boolean; onClick: () => void }) {
  const typing = useTyping(c.id).filter((id) => id !== me);
  const last = c.lastMessage;
  let preview = '';
  if (last) {
    if (last.kind === 'system') preview = systemText(last.body, users, me);
    else if (last.deleted) preview = 'Nachricht gelöscht';
    else {
      const text = previewOf(bodyOf(last), last.attachments.length);
      const senderName = users.get(last.senderId ?? '')?.name ?? last.senderName;
      const prefix = last.senderId === me ? 'Du: ' : c.kind === 'group' ? `${senderName?.split(' ')[0] ?? 'Jemand'}: ` : '';
      preview = prefix + text;
    }
  }
  const unread = c.unread > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
        active ? 'bg-primary-soft' : 'hover:bg-hover',
      )}
    >
      <ConversationAvatar conversation={c} users={users} me={me} size={42} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium', active && 'text-primary')}>{conversationTitle(c, me, users)}</span>
          {c.source && (
            <span className="shrink-0 rounded px-1 text-[10px] font-medium leading-4 text-muted ring-1 ring-border" title={c.source.label}>
              {sourceShort(c.source.type)}
            </span>
          )}
          <span className={cn('shrink-0 text-[11px]', unread && !c.muted ? 'font-semibold text-primary' : 'text-subtle')}>{formatListDate(c.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', typing.length ? 'text-primary' : unread ? 'text-fg' : 'text-muted')}>
            {typing.length ? (c.kind === 'group' ? `${users.get(typing[0]!)?.name.split(' ')[0] ?? 'Jemand'} schreibt …` : 'schreibt …') : preview || ' '}
          </span>
          {c.call && <Phone className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Anruf läuft" />}
          {c.pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-warning" aria-label="Favorit" />}
          {c.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-subtle" />}
          {unread && (
            <span
              className={cn(
                'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                c.muted ? 'bg-border-strong text-fg' : 'bg-primary text-primary-fg',
              )}
            >
              {c.unread > 99 ? '99+' : c.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
