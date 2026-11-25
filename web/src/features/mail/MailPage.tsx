/**
 * Mail-Hauptansicht: Seitenleiste | Liste | Lesebereich (rechts/unten/aus).
 * URL-Schema:
 *   /mail/unified            gemeinsamer Posteingang
 *   /mail/flagged            markierte Nachrichten (alle Posteingänge)
 *   /mail/scheduled          geplanter Versand
 *   /mail/search?q=…         kontoübergreifende Suche
 *     &account=<id>          … nur in einem Konto (alle Ordner inkl. Unterordnern)
 *     &from=<id>/<b64>       Ordner, aus dem gesucht wurde (Rückweg beim Leeren, Bereich „Ordner“)
 *   /mail/f/:accountId/:folder(b64)   Ordner eines Kontos
 *   ?m=<ref>                 geöffnete Nachricht, ?focus=<ref> darin angeklickte Einzelnachricht, ?q= Ordnersuche, ?filter=unread|flagged|important
 *   ?sort=priority, ?prio=high|normal|low|done|none   KI-Triage: sortieren/filtern (clientseitig)
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Menu } from 'lucide-react';
import { toast } from 'sonner';
import type { FolderRole, MessageDetail, MessageSummary } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { useAccountMap, useFeature, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { EmptyState } from '@/components/ui';
import { b64url, fetchListPage, folderLabel, fromB64url, mailKeys, refKey, toRef, type ListView, type MessageRef } from './api';
import { useFolders, useOwnAddresses } from './hooks';
import { MailSidebar } from './Sidebar';
import { MessageList, type ListFilter, type SearchScope } from './MessageList';
import {
  conversationTriage,
  isImportant,
  matchesPriorityFilter,
  triageSortKey,
  PRIORITY_FILTER_LABELS,
  type PriorityFilter,
} from './components/TriageBadge';
import { MessageView } from './MessageView';
import { ConversationView } from './ConversationView';
import {
  findConversation,
  groupConversations,
  selectedConversations,
  single,
  toggleConversationFlag,
  toggleConversationSeen,
  type Conversation,
} from './threads';
import { ScheduledView } from './ScheduledView';
import { useMailActions } from './actions';
import { decodeMessageRef, encodeMessageRef } from './links';
import { openComposer } from './compose/store';
import { openMessageWindow } from './message-window';

/** Filter „Wichtig“: höchstens so viele Seiten (à 50) nachladen */
const IMPORTANT_MAX_PAGES = 6;

const encodeRef = (r: MessageRef) => encodeMessageRef(r);
const decodeRef = (s: string | null): MessageRef | null => decodeMessageRef(s);

export function MailPage() {
  const loc = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { settings } = useSettings();
  const searchIndex = useFeature('search');
  const accountMap = useAccountMap();
  const actions = useMailActions();
  const searchRef = useRef<HTMLInputElement>(null);

  const triageFeature = useFeature('triage');
  const rawFilter = (params.get('filter') as ListFilter) || 'all';
  // „Wichtig“ filtert clientseitig nach KI-Triage – ohne Modul auf „Alle“ zurückfallen
  const filter: ListFilter = rawFilter === 'important' && !triageFeature ? 'all' : rawFilter;
  const sortByPriority = triageFeature && params.get('sort') === 'priority';
  const rawPrio = params.get('prio') as PriorityFilter | null;
  const prioFilter = triageFeature && rawPrio && rawPrio in PRIORITY_FILTER_LABELS ? rawPrio : null;
  const q = params.get('q') ?? '';

  /* ───────────── Ansicht aus URL ───────────── */
  const seg = loc.pathname.replace(/^\/mail\/?/, '').split('/');
  const view: ListView | 'scheduled' = useMemo(() => {
    if (seg[0] === 'f' && seg[1] && seg[2]) {
      return {
        kind: 'folder',
        accountId: seg[1],
        folderId: fromB64url(seg[2]),
        unreadOnly: filter === 'unread' || undefined,
        flaggedOnly: filter === 'flagged' || undefined,
        search: q || undefined,
      };
    }
    if (seg[0] === 'scheduled') return 'scheduled';
    if (seg[0] === 'search') return { kind: 'search', q, accountId: params.get('account') || undefined };
    if (seg[0] === 'flagged') return { kind: 'unified', role: 'inbox', flaggedOnly: true };
    return { kind: 'unified', role: 'inbox', unreadOnly: filter === 'unread' || undefined, flaggedOnly: filter === 'flagged' || undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname, filter, q, params.get('account')]);

  // Ordner, von dem aus gesucht wird – in der Suche über ?from= gemerkt
  const origin: { accountId: string; folderId: string } | undefined = useMemo(() => {
    if (typeof view === 'object' && view.kind === 'folder') return { accountId: view.accountId, folderId: view.folderId };
    const [acc, folder] = (params.get('from') ?? '').split('/');
    const folderId = folder ? fromB64url(folder) : '';
    return acc && folderId ? { accountId: acc, folderId } : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, params.get('from')]);
  const inSearchView = typeof view === 'object' && view.kind === 'search';
  const searchAccount = typeof view === 'object' && view.kind === 'search' ? view.accountId : undefined;
  const searchScope: SearchScope = inSearchView ? (searchAccount ? 'account' : 'all') : origin ? 'folder' : 'all';
  const searchScopes: SearchScope[] = [...(origin ? (['folder'] as const) : []), ...(origin || searchAccount ? (['account'] as const) : []), 'all'];

  const folderAccount = typeof view === 'object' && view.kind === 'folder' ? view.accountId : undefined;
  const { data: folderData } = useFolders(folderAccount);
  const currentFolder = typeof view === 'object' && view.kind === 'folder' ? folderData?.folders.find((f) => f.id === view.folderId) : undefined;

  /* ───────────── Liste ───────────── */
  const listEnabled = view !== 'scheduled' && !(view.kind === 'search' && !view.q);
  const list = useInfiniteQuery({
    queryKey: mailKeys.list(view === 'scheduled' ? { kind: 'unified', role: 'inbox' } : view),
    queryFn: ({ pageParam }) => fetchListPage(view as ListView, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: listEnabled,
    refetchInterval: 120_000,
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: MessageSummary[] = [];
    for (const p of list.data?.pages ?? [])
      for (const m of p.items) {
        const k = refKey(toRef(m));
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    return out;
  }, [list.data]);
  const errors = list.data?.pages[list.data.pages.length - 1]?.errors;

  /* ───────────── Konversationsansicht ───────────── */
  // Nicht in Suche, Entwürfen und Postausgang – dort bleibt die Liste flach.
  const role = currentFolder?.role;
  const threaded =
    settings.threading && typeof view === 'object' && view.kind !== 'search' && role !== 'drafts' && role !== 'outbox';
  const allRows = useMemo(() => (threaded ? groupConversations(items) : items.map(single)), [items, threaded]);
  const own = useOwnAddresses();
  const listView = typeof view === 'object' && view.kind !== 'search';
  // Clientseitige Triage-Filter („Wichtig“ bzw. Priorität) – laden bei Bedarf weitere Seiten
  const importantOnly = listView && (filter === 'important' || !!prioFilter);
  const rows = useMemo(() => {
    let r = allRows;
    if (listView && filter === 'important') r = r.filter((c) => isImportant(c.messages, own));
    if (listView && prioFilter) r = r.filter((c) => matchesPriorityFilter(conversationTriage(c.messages, own), prioFilter));
    if (sortByPriority) {
      // Stabil: innerhalb gleicher Priorität bleibt die Datumsreihenfolge
      const keyed = r.map((c, i) => ({ c, i, k: triageSortKey(conversationTriage(c.messages, own)) }));
      keyed.sort((a, b) => b.k - a.k || a.i - b.i);
      r = keyed.map((x) => x.c);
    }
    return r;
  }, [allRows, listView, filter, prioFilter, sortByPriority, own]);
  // Der Filter „Wichtig“ lädt beim Scrollen nur begrenzt nach (die Triage betrifft ohnehin neue Mails)
  const importantCapped = importantOnly && (list.data?.pages.length ?? 0) >= IMPORTANT_MAX_PAGES;
  // Wenige Treffer: weitere Seiten von selbst nachladen (auch wenn noch gar nichts sichtbar ist)
  useEffect(() => {
    if (importantOnly && rows.length < 20 && list.hasNextPage && !importantCapped && !list.isFetching) void list.fetchNextPage();
  }, [importantOnly, rows.length, list.hasNextPage, importantCapped, list.isFetching, list]);

  /* ───────────── Auswahl & geöffnete Nachricht ───────────── */
  const current = decodeRef(params.get('m'));
  const currentKey = current ? refKey(current) : undefined;
  // Einzelnachricht aus einer aufgeklappten Unterhaltung der Liste
  const focusRef = current ? decodeRef(params.get('focus')) : null;
  const focusKey = focusRef ? refKey(focusRef) : undefined;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const viewKey = JSON.stringify(view);
  useEffect(() => setSelected(new Set()), [viewKey]);

  const openMessage = useCallback(
    (m: MessageSummary | MessageRef | null, focus?: MessageSummary) => {
      const next = new URLSearchParams(params);
      if (m) next.set('m', encodeRef('accountId' in m ? toRef(m as MessageSummary) : m));
      else next.delete('m');
      if (m && focus) next.set('focus', encodeRef(toRef(focus)));
      else next.delete('focus');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // Unterhaltung der geöffneten Nachricht. Wird genau diese Nachricht aus der
  // Unterhaltung entfernt (z. B. einzeln archiviert), bleibt der Rest offen.
  const lastConvKeys = useRef<string[]>([]);
  let currentConv: Conversation | undefined = findConversation(rows, currentKey);
  if (!currentConv && currentKey && lastConvKeys.current.includes(currentKey)) {
    const keys = new Set(lastConvKeys.current);
    currentConv = rows.find((c) => c.messages.some((m) => keys.has(refKey(toRef(m)))));
  }
  useEffect(() => {
    lastConvKeys.current = currentConv ? currentConv.messages.map((m) => refKey(toRef(m))) : [];
  });

  const indexOfCurrent = currentConv ? rows.indexOf(currentConv) : -1;
  const goRelative = useCallback(
    (delta: number) => {
      const idx = indexOfCurrent < 0 ? (delta > 0 ? 0 : -1) : indexOfCurrent + delta;
      const c = rows[idx];
      if (c) {
        // Gemeinsam mit dem (per Transition laufenden) URL-Wechsel committen,
        // sonst erscheint kurz die Massenbearbeitungs-Leiste.
        startTransition(() => {
          openMessage(c.latest);
          setSelected(new Set([c.key]));
        });
      }
    },
    [indexOfCurrent, rows, openMessage],
  );
  /** Nach Entfernen der offenen Nachricht/Unterhaltung: nächste öffnen */
  const afterRemove = useCallback(() => {
    const next = rows[indexOfCurrent + 1] ?? rows[indexOfCurrent - 1];
    if (next && next !== currentConv) openMessage(next.latest);
    else openMessage(null);
  }, [rows, indexOfCurrent, currentConv, openMessage]);

  /* ───────────── Titel ───────────── */
  let title = 'Alle Posteingänge';
  let subtitle: string | undefined;
  if (typeof view === 'object') {
    if (view.kind === 'unified' && view.flaggedOnly) title = 'Markiert';
    if (view.kind === 'search') {
      title = 'Suche';
      const meta = list.data?.pages[0]?.meta;
      const accName = view.accountId ? (accountMap.get(view.accountId)?.name ?? 'Konto') : undefined;
      if (!view.q) subtitle = 'Suchbegriff eingeben';
      else if (meta) {
        const n = meta.total.toLocaleString('de-DE');
        subtitle = `${accName ? `${accName} · ` : ''}${n} Treffer · ${meta.processingTimeMs} ms${meta.indexed ? (meta.liveAccounts.length ? ' · teilweise live beim Anbieter' : ' · Suchindex') : ' · live beim Anbieter'}`;
      } else subtitle = `„${view.q}“ ${accName ? `in allen Ordnern von ${accName}` : 'in allen Konten'}`;
    }
    if (view.kind === 'folder') {
      title = currentFolder ? folderLabel(currentFolder) : 'Ordner';
      const acc = accountMap.get(view.accountId);
      const mb = folderData && folderData.mailboxes.length > 1 ? folderData.mailboxes.find((m) => m.id === currentFolder?.mailboxId) : undefined;
      subtitle = [acc?.name, mb?.name].filter(Boolean).join(' · ');
    }
  }

  /* ───────────── Suche & Filter ───────────── */
  const onSearch = (text: string, scope: SearchScope) => {
    const originPath = origin ? `/mail/f/${origin.accountId}/${b64url(origin.folderId)}` : undefined;
    if (scope === 'folder' && originPath && inSearchView) {
      // Aus der Suche zurück in den Ordner – mit dem Suchbegriff als Ordnersuche
      navigate(text ? `${originPath}?q=${encodeURIComponent(text)}` : originPath);
      return;
    }
    if (scope !== 'folder' || !originPath) {
      if (text) {
        const sp = new URLSearchParams({ q: text });
        const accountId = scope === 'account' ? (origin?.accountId ?? searchAccount) : undefined;
        if (accountId) sp.set('account', accountId);
        if (origin) sp.set('from', `${origin.accountId}/${b64url(origin.folderId)}`);
        // Innerhalb der Suche History nicht mit jedem Tastendruck füllen
        navigate(`/mail/search?${sp.toString()}`, { replace: inSearchView });
      } else if (inSearchView) navigate(originPath ?? '/mail/unified');
      return;
    }
    const next = new URLSearchParams(params);
    if (text) next.set('q', text);
    else next.delete('q');
    next.delete('m');
    next.delete('focus');
    setParams(next);
  };
  const setTriageParam = (name: 'sort' | 'prio', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  const onFilter = (f: ListFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('filter');
    else next.set('filter', f);
    next.delete('m');
    next.delete('focus');
    setParams(next);
  };

  /* ───────────── Tastenkürzel ───────────── */
  const stateRef = useRef({ rows, current, currentConv, selected, folderRole: currentFolder?.role });
  stateRef.current = { rows, current, currentConv, selected, folderRole: currentFolder?.role };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const st = stateRef.current;
      const cur = st.current;
      const detail = cur ? qc.getQueryData<MessageDetail>(mailKeys.message(cur.accountId, cur.folderId, cur.id)) : undefined;
      // Ziele: mehrere ausgewählte Zeilen, sonst die geöffnete (ganze Unterhaltung)
      const selRows = selectedConversations(st.rows, st.selected);
      const targetRows = selRows.length > 1 ? selRows : st.currentConv ? [st.currentConv] : [];
      const targets: MessageRef[] = targetRows.length ? targetRows.flatMap((c) => c.messages.map(toRef)) : cur ? [cur] : [];
      const guard = (p: Promise<unknown>) => void p.catch((err) => toast.error(errorMessage(err)));

      switch (e.key) {
        case 'c':
          openComposer({ mode: 'new', accountId: cur?.accountId });
          break;
        case 'r':
          if (detail && cur) actions.reply(detail, cur, 'reply');
          break;
        case 'a':
          if (detail && cur) actions.reply(detail, cur, 'replyAll');
          break;
        case 'f':
          if (detail && cur) actions.reply(detail, cur, 'forward');
          break;
        case 'e':
          if (targets.length) {
            void actions.archive(targets);
            afterRemoveRef.current();
          }
          break;
        case '#':
        case 'Delete':
          if (targets.length) {
            void actions.remove(targets, st.folderRole === 'trash');
            afterRemoveRef.current();
          }
          break;
        case 's':
          if (targetRows.length) guard(toggleConversationFlag(qc, targetRows));
          break;
        case 'u':
          if (targetRows.length) guard(toggleConversationSeen(qc, targetRows));
          break;
        case 'j':
        case 'ArrowDown':
          goRelRef.current(1);
          break;
        case 'k':
        case 'ArrowUp':
          goRelRef.current(-1);
          break;
        case '/':
          searchRef.current?.focus();
          break;
        case 'Escape':
          if (cur) openMessageRef.current(null);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, qc]);
  const afterRemoveRef = useRef(afterRemove);
  afterRemoveRef.current = afterRemove;
  const goRelRef = useRef(goRelative);
  goRelRef.current = goRelative;
  const openMessageRef = useRef(openMessage);
  openMessageRef.current = openMessage;

  /* ───────────── Layout ───────────── */
  // Mobil: immer nur eine Ansicht (Liste oder Nachricht), Ordner als Schublade
  const isMobile = useIsMobile();
  const [foldersOpen, setFoldersOpen] = useState(false);
  const drawerKey = JSON.stringify(view);
  useEffect(() => setFoldersOpen(false), [drawerKey]);
  const pane = isMobile ? 'off' : settings.readingPane;
  // Farbmarkierung des Kontos nur, wenn mehrere Konten in der Liste stehen können
  const showAccount = typeof view === 'object' && view.kind !== 'folder' && !(view.kind === 'search' && view.accountId);
  const readerRole = role ?? (typeof view === 'object' && view.kind === 'unified' ? 'inbox' : undefined);

  /* ───────────── Eigenes Fenster (nur Desktop) ───────────── */
  const openInWindow = (m: MessageSummary | MessageRef, conversation?: MessageSummary[], folderRole?: FolderRole) => {
    if (!openMessageWindow(toRef(m), { conversation, folderRole }))
      toast.warning('Fenster wurde vom Browser blockiert', { description: 'Bitte Popups für Kuvert erlauben.' });
  };
  /** Listenzeile: ganze Unterhaltung (bzw. Nachricht); mit `m` nur diese Einzelnachricht */
  const openRowWindow = (c: Conversation, m?: MessageSummary) => {
    if (m) openInWindow(m, undefined, m.folderId === c.latest.folderId ? readerRole : undefined);
    else openInWindow(c.latest, threaded ? c.messages : undefined, readerRole);
  };

  const listEl =
    view === 'scheduled' ? (
      <ScheduledView />
    ) : (
      <MessageList
        title={title}
        subtitle={subtitle}
        rows={rows}
        errors={errors}
        loading={listEnabled && list.isLoading}
        error={list.error}
        hasMore={!!list.hasNextPage && !importantCapped}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        onRefresh={() => {
          void list.refetch();
          void qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
        }}
        refreshing={list.isRefetching}
        selected={selected}
        setSelected={setSelected}
        currentKey={currentConv?.key ?? currentKey}
        focusKey={focusKey}
        onOpen={(m, focus) => openMessage(m, focus)}
        onOpenWindow={isMobile ? undefined : openRowWindow}
        accountMap={accountMap}
        showAccount={showAccount}
        permanentDelete={role === 'trash'}
        showRecipients={role === 'sent' || role === 'drafts' || role === 'outbox'}
        compact={settings.density === 'compact'}
        filter={filter}
        onFilter={onFilter}
        search={view.kind === 'search' ? view.q : q}
        onSearch={onSearch}
        instantSearch={searchIndex}
        searchRef={searchRef}
        searchScope={searchScope}
        searchScopes={searchScopes}
        isSearchView={view.kind === 'search'}
        showImportantFilter={triageFeature}
        triage={
          triageFeature
            ? {
                sortByPriority,
                prioFilter,
                onSort: (byPriority) => setTriageParam('sort', byPriority ? 'priority' : null),
                onPrioFilter: (f) => setTriageParam('prio', f),
              }
            : undefined
        }
        footerHint={importantOnly ? (importantCapped ? `Nur die neuesten ${items.length} Nachrichten wurden durchsucht.` : undefined) : undefined}
      />
    );

  const readerRef = threaded && currentConv ? toRef(currentConv.latest) : current;
  const reader = current && readerRef ? (
    // Auch bei nur einer Nachricht im Ordner: Antworten u. a. liegen ggf. in „Gesendet“/„Archiv“.
    // Bleibt es bei einer Nachricht, zeigt ConversationView die normale Leseansicht.
    threaded && currentConv ? (
      <ConversationView
        key={currentKey}
        conv={currentConv}
        account={accountMap.get(current.accountId)}
        folderRole={readerRole}
        onBack={pane === 'off' ? () => openMessage(null) : undefined}
        onAfterRemove={afterRemove}
        focusKey={focusKey}
        onOpenWindow={isMobile ? undefined : () => openInWindow(currentConv.latest, currentConv.messages, readerRole)}
        onOpenMessageWindow={isMobile ? undefined : (m) => openInWindow(m)}
      />
    ) : (
      <MessageView
        key={refKey(readerRef)}
        msgRef={readerRef}
        account={accountMap.get(readerRef.accountId)}
        folderRole={readerRole}
        onBack={pane === 'off' ? () => openMessage(null) : undefined}
        onAfterRemove={afterRemove}
        onOpenWindow={isMobile ? undefined : () => openInWindow(readerRef, undefined, readerRole)}
      />
    )
  ) : (
    <EmptyState icon={<Mail />} title="Keine Nachricht ausgewählt">
      Wähle links eine Nachricht aus. Tipp: <kbd className="rounded border border-border px-1">j</kbd>/<kbd className="rounded border border-border px-1">k</kbd> zum Blättern,{' '}
      <kbd className="rounded border border-border px-1">c</kbd> zum Verfassen.
    </EmptyState>
  );

  const content =
    view === 'scheduled' ? (
      <div className="min-h-0 min-w-0 flex-1">{listEl}</div>
    ) : pane === 'off' ? (
      <div className="min-h-0 min-w-0 flex-1">{current ? reader : listEl}</div>
    ) : (
      <div className={cn('flex min-h-0 min-w-0 flex-1', pane === 'bottom' ? 'flex-col' : 'flex-row')}>
        <div className={cn('min-h-0 min-w-0 border-border', pane === 'bottom' ? 'h-[42%] border-b' : 'w-[clamp(320px,34%,460px)] shrink-0 border-r')}>
          {listEl}
        </div>
        <div className="min-h-0 min-w-0 flex-1 bg-surface">{reader}</div>
      </div>
    );

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {!current && (
          <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface px-2">
            <button
              type="button"
              onClick={() => setFoldersOpen(true)}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-hover hover:text-fg"
            >
              <Menu className="h-4 w-4" /> Ordner &amp; Konten
            </button>
          </div>
        )}
        {content}
        {foldersOpen && (
          <div className="fixed inset-0 z-40 flex animate-fade-in bg-slate-950/40 backdrop-blur-sm" onClick={() => setFoldersOpen(false)}>
            <div className="h-full max-w-[85vw] shadow-pop" onClick={(e) => e.stopPropagation()}>
              <MailSidebar current={view} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <MailSidebar current={view} />
      {content}
    </div>
  );
}
