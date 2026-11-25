/**
 * Nachrichtenliste mit Endlos-Scroll, Mehrfachauswahl, Drag & Drop,
 * Schnellaktionen und Massenbearbeitung.
 */
import {
  Fragment,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Archive,
  ArrowDownWideNarrow,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Flag,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AccountInfo, MessageSummary } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { cn, displayAddress, formatListDate } from '@/lib/utils';
import { Avatar, Dropdown, EmptyState, IconButton, Spinner, Tabs, type MenuItem } from '@/components/ui';
import { SmimeIcon } from './SmimeIcon';
import { deleteMessages, moveMessages, moveToRole, refKey, setFlags, toRef, type ListPage, type MessageRef } from './api';
import { DRAG_MIME } from './Sidebar';
import { MoveDialog } from './components/MoveDialog';
import { Highlighted } from './Highlight';
import { PRIORITY_FILTER_LABELS, TriageBadge, TriagePendingBadge, conversationTriage, type PriorityFilter } from './components/TriageBadge';
import { runTriageWithFeedback, useTriagePending } from './triage-pending';
import { useFolders, useOwnAddresses } from './hooks';
import { FolderBadge } from './components/FolderBadge';
import {
  mayHaveThread,
  selectedConversations,
  threadCacheKey,
  toggleConversationFlag,
  toggleConversationSeen,
  useConversationThread,
  type Conversation,
} from './threads';

/** important = von der KI-Triage als „hoch“ eingeordnet (nur mit Modul "triage") */
export type ListFilter = 'all' | 'unread' | 'flagged' | 'important';

/** Suchbereich: aktueller Ordner, alle Ordner des Kontos (inkl. Unterordnern) oder alle Konten */
export type SearchScope = 'folder' | 'account' | 'all';

const SCOPE_LABELS: Record<SearchScope, string> = { folder: 'Ordner', account: 'Ganzes Konto', all: 'Alle Konten' };
const SCOPE_TITLES: Record<SearchScope, string> = {
  folder: 'Nur im aktuellen Ordner suchen',
  account: 'In allen Ordnern und Unterordnern dieses Kontos suchen',
  all: 'Kontoübergreifend in allen Ordnern suchen',
};

export interface MessageListProps {
  title: string;
  subtitle?: string;
  /** Zeilen der Liste – bei Konversationsansicht gruppiert, sonst je Nachricht eine */
  rows: Conversation[];
  errors?: ListPage['errors'];
  loading: boolean;
  error?: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  currentKey?: string;
  /** In einer aufgeklappten Unterhaltung angeklickte Einzelnachricht */
  focusKey?: string;
  /** `focus`: Einzelnachricht innerhalb der Unterhaltung, die in der Leseansicht angesteuert wird */
  onOpen: (m: MessageSummary, focus?: MessageSummary) => void;
  /** Doppelklick: Zeile (bzw. mit `m` eine Einzelnachricht der Unterhaltung) in eigenem Fenster öffnen */
  onOpenWindow?: (c: Conversation, m?: MessageSummary) => void;
  accountMap: Map<string, AccountInfo>;
  showAccount: boolean;
  /** Ansicht ist z. B. Papierkorb → endgültig löschen */
  permanentDelete?: boolean;
  /** Ansicht = Gesendet/Entwürfe → Empfänger statt Absender zeigen */
  showRecipients?: boolean;
  compact: boolean;
  filter: ListFilter;
  onFilter: (f: ListFilter) => void;
  search: string;
  onSearch: (q: string, scope: SearchScope) => void;
  /** Suche schon beim Tippen ausführen (bei aktivem Suchindex) */
  instantSearch?: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Aktueller Suchbereich der Ansicht */
  searchScope: SearchScope;
  /** Wählbare Suchbereiche (unter zwei: keine Auswahl anzeigen) */
  searchScopes: SearchScope[];
  isSearchView: boolean;
  /** Filter „Wichtig“ (KI-Triage) anbieten */
  showImportantFilter?: boolean;
  /** Hinweis unter der Liste, z. B. dass der Filter nur die neuesten Mails durchsucht */
  footerHint?: string;
  /** KI-Triage: nach Priorität sortieren und filtern (nur mit Modul "triage") */
  triage?: {
    sortByPriority: boolean;
    prioFilter: PriorityFilter | null;
    onSort: (byPriority: boolean) => void;
    onPrioFilter: (f: PriorityFilter | null) => void;
  };
}

export function MessageList(p: MessageListProps) {
  const qc = useQueryClient();
  // Eigene Adressen: eine eigene Antwort in der Unterhaltung gilt für die Triage als erledigt
  const own = useOwnAddresses();
  const triagePending = useTriagePending();
  const [anchor, setAnchor] = useState<number | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  // Aufgeklappte Unterhaltungen (stabiler Schlüssel – bleibt bei neuen Antworten offen)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const [q, setQ] = useState(p.search);
  const [scope, setScope] = useState(p.searchScope);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setQ(p.search), [p.search]);
  useEffect(() => setScope(p.searchScope), [p.searchScope]);

  // Endlos-Scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !p.hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !p.loadingMore) p.onLoadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [p.hasMore, p.loadingMore, p.onLoadMore, p.rows.length]);

  // Auswahl auf Zeilen abbilden: eine ausgewählte Nachricht wählt ihre ganze Unterhaltung
  const selectedRows = selectedConversations(p.rows, p.selected);
  const selectedRowSet = new Set(selectedRows);
  const selectedItems = selectedRows.flatMap((c) => c.messages);
  const selectedRefs: MessageRef[] = selectedItems.map(toRef);
  const currentRow = p.currentKey ? p.rows.find((c) => c.key === p.currentKey || c.messages.some((m) => refKey(toRef(m)) === p.currentKey)) : undefined;
  const bulk = selectedRows.length > 1 || (selectedRows.length === 1 && selectedRows[0] !== currentRow);
  const sameAccount = new Set(selectedRefs.map((r) => r.accountId)).size === 1;

  const onRowClick = (e: ReactMouseEvent, c: Conversation, idx: number) => {
    const key = c.key;
    const m = c.latest;
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      const next = new Set(p.selected);
      p.rows.slice(a, b + 1).forEach((x) => next.add(x.key));
      p.setSelected(next);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      toggleCheck(c, idx);
      return;
    }
    setAnchor(idx);
    // Der Router setzt die URL (= geöffnete Nachricht) per Transition. Die Auswahl
    // muss in derselben Transition landen, sonst gilt sie kurz als Mehrfachauswahl
    // und die Massenbearbeitungs-Leiste blitzt auf.
    startTransition(() => {
      p.setSelected(new Set([key]));
      p.onOpen(m);
    });
  };

  /** Klick auf eine Einzelnachricht unter einer aufgeklappten Unterhaltung */
  const onChildClick = (e: ReactMouseEvent, c: Conversation, idx: number, m: MessageSummary) => {
    // Mehrfachauswahl wirkt wie bisher auf ganze Unterhaltungen
    if (e.shiftKey || e.ctrlKey || e.metaKey) return onRowClick(e, c, idx);
    setAnchor(idx);
    startTransition(() => {
      p.setSelected(new Set([c.key]));
      p.onOpen(c.latest, m);
    });
  };

  const toggleCheck = (c: Conversation, idx: number) => {
    const next = new Set(p.selected);
    const keys = c.messages.map((m) => refKey(toRef(m)));
    if (keys.some((k) => next.has(k))) keys.forEach((k) => next.delete(k));
    else next.add(c.key);
    p.setSelected(next);
    setAnchor(idx);
  };

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const clearSel = () => p.setSelected(new Set());
  // KI-Triage: eingehende Nachrichten (keine eigenen), die nicht gerade schon eingeordnet werden
  const triageable = (msgs: MessageSummary[]) => msgs.filter((m) => !own.has(m.from?.address?.toLowerCase() ?? '') && !triagePending.isPending(m));
  const untriaged = p.triage ? triageable(p.rows.flatMap((c) => c.messages)).filter((m) => !m.triage) : [];
  const triageNow = (msgs: MessageSummary[]) =>
    void run(async () => {
      const r = await runTriageWithFeedback(msgs);
      toast.success(r.queued === 1 ? 'Eine Nachricht wird eingeordnet …' : `${r.queued} Nachrichten werden eingeordnet …`);
    });
  const n = selectedRefs.length;
  const plural = (s: string) => `${n} ${n === 1 ? 'Nachricht' : 'Nachrichten'} ${s}`;

  const allSelected = p.rows.length > 0 && selectedRows.length === p.rows.length;

  const submitSearch = () => p.onSearch(q.trim(), scope);
  // Bereich gewechselt: eine eingegebene Suche gleich im neuen Bereich ausführen
  const changeScope = (s: SearchScope) => {
    setScope(s);
    if (q.trim()) p.onSearch(q.trim(), s);
  };

  // Mit Suchindex: konto- bzw. kontenweit schon beim Tippen suchen
  const instant = !!p.instantSearch && scope !== 'folder';
  useEffect(() => {
    if (!instant) return;
    const t = q.trim();
    if (t === (p.search ?? '').trim() || (t.length > 0 && t.length < 2)) return;
    const timer = setTimeout(() => p.onSearch(t, scope), 180);
    return () => clearTimeout(timer);
    // Ansicht gewechselt (z. B. per Bereichsauswahl): ausstehende Suche verwerfen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, instant, scope, p.search, p.searchScope]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Kopf */}
      <div className="border-b border-border px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{p.title}</h1>
            {p.subtitle && <div className="truncate text-xs text-muted">{p.subtitle}</div>}
          </div>
          <IconButton label="Aktualisieren" size="icon-sm" onClick={p.onRefresh}>
            <RefreshCw className={cn('h-4 w-4', p.refreshing && 'animate-spin')} />
          </IconButton>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              ref={p.searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch();
                if (e.key === 'Escape') {
                  setQ('');
                  p.onSearch('', scope);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={
                scope === 'folder'
                  ? 'In diesem Ordner suchen …'
                  : `${scope === 'account' ? 'Ganzes Konto' : 'Alle Konten'} durchsuchen${p.instantSearch ? ' – z. B. from:anna has:attachment' : ' …'}`
              }
              className="h-8 w-full rounded-md border border-border bg-surface-2 pl-7 pr-7 text-sm outline-none focus:border-primary focus:bg-surface"
            />
            {q && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg"
                onClick={() => {
                  setQ('');
                  p.onSearch('', scope);
                }}
                aria-label="Suche löschen"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {p.searchScopes.length > 1 && (
            <select
              value={scope}
              onChange={(e) => changeScope(e.target.value as SearchScope)}
              title={SCOPE_TITLES[scope]}
              aria-label="Suchbereich"
              className="h-8 shrink-0 cursor-pointer rounded-md border border-border bg-surface-2 px-1.5 text-xs text-muted outline-none hover:text-fg focus:border-primary"
            >
              {p.searchScopes.map((s) => (
                <option key={s} value={s} title={SCOPE_TITLES[s]}>
                  {SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
          )}
        </div>
        {!p.isSearchView && (
          <div className="mt-2 flex items-center gap-2">
            <Tabs
              value={p.filter}
              onChange={p.onFilter}
              tabs={[
                { value: 'all', label: 'Alle' },
                { value: 'unread', label: 'Ungelesen' },
                { value: 'flagged', label: 'Markiert' },
                ...(p.showImportantFilter ? [{ value: 'important' as const, label: 'Wichtig' }] : []),
              ]}
            />
            <span className="flex-1" />
            {p.triage && <TriageListMenu {...p.triage} untriagedCount={untriaged.length} onTriageUntriaged={() => triageNow(untriaged)} />}
            <button
              type="button"
              className="text-muted hover:text-fg"
              title={allSelected ? 'Auswahl aufheben' : 'Alle auswählen'}
              onClick={() => p.setSelected(allSelected ? new Set() : new Set(p.rows.map((c) => c.key)))}
            >
              {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>

      {/* Massenbearbeitung */}
      {bulk && n > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-primary-soft px-2 py-1 text-sm">
          <span className="mr-2 px-1 font-medium text-primary">
            {selectedRows.length === n ? `${n} ausgewählt` : `${selectedRows.length} Unterhaltungen (${n} Nachrichten)`}
          </span>
          <IconButton label="Als gelesen markieren" size="icon-sm" onClick={() => void run(() => setFlags(qc, selectedRefs, { seen: true }, selectedItems))}>
            <MailOpen className="h-4 w-4" />
          </IconButton>
          <IconButton label="Als ungelesen markieren" size="icon-sm" onClick={() => void run(() => setFlags(qc, selectedRefs, { seen: false }, selectedItems))}>
            <Mail className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Markierung umschalten"
            size="icon-sm"
            onClick={() => void run(() => toggleConversationFlag(qc, selectedRows))}
          >
            <Flag className="h-4 w-4" />
          </IconButton>
          <IconButton label="Archivieren" size="icon-sm" onClick={() => void run(() => moveToRole(qc, selectedRefs, 'archive').then(clearSel), plural('archiviert'))}>
            <Archive className="h-4 w-4" />
          </IconButton>
          <IconButton label="Als Spam markieren" size="icon-sm" onClick={() => void run(() => moveToRole(qc, selectedRefs, 'junk').then(clearSel), plural('als Spam verschoben'))}>
            <ShieldAlert className="h-4 w-4" />
          </IconButton>
          <IconButton label="Verschieben" size="icon-sm" disabled={!sameAccount} onClick={() => setMoveOpen(true)}>
            <FolderInput className="h-4 w-4" />
          </IconButton>
          {p.triage && (
            <IconButton
              label="Mit KI einordnen"
              size="icon-sm"
              className="text-primary"
              disabled={!triageable(selectedItems).length}
              onClick={() => triageNow(triageable(selectedItems))}
            >
              <Sparkles className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton
            label="Löschen"
            size="icon-sm"
            onClick={() => void run(() => deleteMessages(qc, selectedRefs, p.permanentDelete).then(clearSel), plural('gelöscht'))}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
          <span className="flex-1" />
          <IconButton label="Auswahl aufheben" size="icon-sm" onClick={clearSel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {/* Fehler einzelner Konten */}
      {p.errors && p.errors.length > 0 && (
        <div className="border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning">
          {p.errors.map((e) => (
            <div key={e.accountId} className="flex items-center gap-1.5 truncate" title={e.message}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {e.account}: {e.message}
            </div>
          ))}
        </div>
      )}

      {/* Liste */}
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-multiselectable>
        {p.loading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : p.error ? (
          <EmptyState icon={<AlertTriangle />} title="Nachrichten konnten nicht geladen werden">
            {errorMessage(p.error)}
          </EmptyState>
        ) : p.rows.length === 0 ? (
          <EmptyState icon={<Inbox />} title={p.isSearchView ? 'Keine Treffer' : 'Keine Nachrichten'}>
            {p.triage?.prioFilter
              ? `Unter den neuesten Nachrichten ist keine mit der Einordnung „${PRIORITY_FILTER_LABELS[p.triage.prioFilter]}“.`
              : p.filter === 'important'
              ? 'Unter den neuesten Nachrichten hat die KI-Triage keine als wichtig eingeordnet.'
              : p.filter !== 'all'
                ? 'Mit dem aktuellen Filter wurden keine Nachrichten gefunden.'
                : undefined}
          </EmptyState>
        ) : (
          <>
            {p.rows.map((c, idx) => {
              const isSelected = selectedRowSet.has(c);
              const expandKey = threadCacheKey(c);
              const expandable = mayHaveThread(c);
              const open = expandable && expanded.has(expandKey);
              const isCurrent = currentRow === c;
              return (
                <Fragment key={c.key}>
                  <Row
                    c={c}
                    expandable={expandable}
                    expanded={open}
                    onToggleExpand={() => toggleExpand(expandKey)}
                    own={own}
                    triageWorking={triagePending.anyPending(c.messages)}
                    account={p.accountMap.get(c.latest.accountId)}
                    showAccount={p.showAccount}
                    showFolder={p.isSearchView}
                    showRecipients={!!p.showRecipients}
                    compact={p.compact}
                    selected={isSelected}
                    // Ist eine Einzelnachricht darunter geöffnet, wird diese hervorgehoben
                    current={isCurrent && !(open && p.focusKey)}
                    onClick={(e) => onRowClick(e, c, idx)}
                    onDoubleClick={p.onOpenWindow ? (e) => dblClick(e, () => p.onOpenWindow!(c)) : undefined}
                    onCheck={() => toggleCheck(c, idx)}
                    dragRefs={() => (isSelected && selectedRefs.length ? selectedRefs : c.messages.map(toRef))}
                    onQuick={(action) => {
                      const r = c.messages.map(toRef);
                      if (action === 'archive') void run(() => moveToRole(qc, r, 'archive'));
                      else if (action === 'delete') void run(() => deleteMessages(qc, r, p.permanentDelete));
                      else if (action === 'flag') void run(() => toggleConversationFlag(qc, [c]));
                      else if (action === 'seen') void run(() => toggleConversationSeen(qc, [c]));
                    }}
                  />
                  {open && (
                    <ConversationChildren
                      c={c}
                      focusKey={isCurrent ? p.focusKey : undefined}
                      compact={p.compact}
                      permanentDelete={!!p.permanentDelete}
                      onClick={(e, m) => onChildClick(e, c, idx, m)}
                      onDoubleClick={p.onOpenWindow ? (e, m) => dblClick(e, () => p.onOpenWindow!(c, m)) : undefined}
                      onError={(err) => toast.error(errorMessage(err))}
                    />
                  )}
                </Fragment>
              );
            })}
            <div ref={sentinel} className="flex h-12 items-center justify-center">
              {p.loadingMore ? <Spinner className="h-4 w-4" /> : !p.hasMore && p.footerHint && <span className="px-3 text-center text-xs text-muted">{p.footerHint}</span>}
            </div>
          </>
        )}
      </div>

      <MoveDialog
        open={moveOpen}
        accountId={selectedRefs[0]?.accountId}
        excludeFolderId={selectedRefs.every((r) => r.folderId === selectedRefs[0]?.folderId) ? selectedRefs[0]?.folderId : undefined}
        onClose={() => setMoveOpen(false)}
        onPick={(folderId) => void run(() => moveMessages(qc, selectedRefs, folderId).then(clearSel), plural('verschoben'))}
      />
    </div>
  );
}

function Row({
  c,
  expandable,
  expanded,
  onToggleExpand,
  own,
  triageWorking,
  account,
  showAccount,
  showFolder,
  showRecipients,
  compact,
  selected,
  current,
  onClick,
  onDoubleClick,
  onCheck,
  dragRefs,
  onQuick,
}: {
  c: Conversation;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  own: Set<string>;
  triageWorking: boolean;
  account?: AccountInfo;
  showAccount: boolean;
  /** Suchtreffer: Ordner der Nachricht anzeigen */
  showFolder: boolean;
  showRecipients: boolean;
  compact: boolean;
  selected: boolean;
  current: boolean;
  onClick: (e: ReactMouseEvent) => void;
  onDoubleClick?: (e: ReactMouseEvent) => void;
  onCheck: () => void;
  dragRefs: () => MessageRef[];
  onQuick: (a: 'archive' | 'delete' | 'flag' | 'seen') => void;
}) {
  const m = c.latest;
  const count = c.messages.length;
  const person = showRecipients
    ? m.to.map((a) => displayAddress(a)).join(', ') || '(kein Empfänger)'
    : count > 1
      ? conversationSenders(c)
      : displayAddress(m.from) || '(unbekannt)';
  const avatarAddr = showRecipients ? m.to[0] : m.from;
  const unread = c.unread > 0;
  const flagged = c.flagged;
  const triage = conversationTriage(c.messages, own);
  // Nur aus dem Cache lesen (enabled=false): geladen wird erst beim Aufklappen bzw. Öffnen.
  // Bis dahin ist die Gesamtzahl einer Antwort mit nur einer Nachricht im Ordner unbekannt.
  const { thread, messages: threadMessages } = useConversationThread(c, false);
  const total = thread.data ? threadMessages.length : count > 1 ? count : undefined;
  const showBadge = expandable && (total === undefined || total > 1);
  // Ordnerliste kommt aus dem Cache der Seitenleiste
  const { data: folderData } = useFolders(showFolder ? m.accountId : undefined);
  const folder = showFolder ? folderData?.folders.find((f) => f.id === m.folderId) : undefined;
  return (
    <div
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => startDrag(e, dragRefs(), m.subject)}
      onMouseDown={onDoubleClick ? noTextSelectOnDblClick : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group relative flex cursor-pointer gap-2.5 border-b border-border/60 px-3',
        compact ? 'py-1.5' : 'py-2.5',
        current ? 'bg-primary-soft' : selected ? 'bg-primary-soft/60' : 'hover:bg-hover',
      )}
    >
      {showAccount && account && <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: account.color }} title={account.name} />}
      {unread && !showAccount && <span className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary" />}
      <div
        className="relative shrink-0 pt-0.5"
        onClick={(e) => {
          e.stopPropagation();
          onCheck();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {selected ? (
          <span className={cn('flex items-center justify-center rounded-full bg-primary text-primary-fg', compact ? 'h-6 w-6' : 'h-8 w-8')}>
            <CheckSquare className="h-4 w-4" />
          </span>
        ) : (
          <span className="flex group-hover:hidden">
            <Avatar name={avatarAddr?.name} email={avatarAddr?.address} size={compact ? 24 : 32} />
          </span>
        )}
        {!selected && (
          <span className={cn('hidden items-center justify-center rounded-full border border-border bg-surface text-muted group-hover:flex', compact ? 'h-6 w-6' : 'h-8 w-8')}>
            <Square className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-semibold text-fg' : 'text-fg/80')}>{person}</span>
          {showBadge && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              aria-expanded={expanded}
              className={cn(
                'inline-flex shrink-0 items-center gap-0.5 self-center rounded-full pl-0.5 pr-1.5 text-[11px] leading-4',
                unread ? 'bg-primary text-primary-fg hover:bg-primary/85' : 'bg-surface-2 text-muted hover:bg-hover hover:text-fg',
              )}
              title={`${total ? `${total} Nachrichten` : 'Unterhaltung'}${c.unread ? `, ${c.unread} ungelesen` : ''} – ${expanded ? 'zuklappen' : 'aufklappen'}`}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {total}
            </button>
          )}
          <span className={cn('shrink-0 text-xs group-hover:hidden', unread ? 'font-semibold text-primary' : 'text-muted')}>{formatListDate(m.date)}</span>
          {/* self-center + kleine Buttons: bleibt innerhalb der Zeilenhöhe, damit der Hover nichts verschiebt */}
          <span className="hidden shrink-0 items-center gap-0.5 self-center group-hover:flex">
            <QuickBtn label={unread ? 'Als gelesen markieren' : 'Als ungelesen markieren'} onClick={() => onQuick('seen')}>
              {unread ? <MailOpen className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
            </QuickBtn>
            <QuickBtn label="Archivieren" onClick={() => onQuick('archive')}>
              <Archive className="h-3.5 w-3.5" />
            </QuickBtn>
            <QuickBtn label="Löschen" onClick={() => onQuick('delete')}>
              <Trash2 className="h-3.5 w-3.5" />
            </QuickBtn>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {m.importance === 'high' && <span className="text-xs font-bold text-danger">!</span>}
          <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-medium text-fg' : 'text-fg/75')}>
            {m.highlight?.subject ? <Highlighted text={m.highlight.subject} /> : m.subject || '(ohne Betreff)'}
          </span>
          {folder && <FolderBadge folder={folder} className="max-w-[40%] shrink-0 truncate py-0 leading-4" />}
          {triageWorking ? <TriagePendingBadge /> : triage && <TriageBadge triage={triage} />}
          <SmimeIcon kind={m.smime} />
          {c.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" />}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onQuick('flag');
            }}
            className={cn('shrink-0', flagged ? 'text-danger' : 'text-muted opacity-0 group-hover:opacity-100')}
            title={flagged ? 'Markierung entfernen' : 'Markieren'}
          >
            <Flag className={cn('h-3.5 w-3.5', flagged && 'fill-current')} />
          </button>
        </div>
        {m.highlight?.snippet ? (
          <div className="line-clamp-2 text-xs text-muted">
            <Highlighted text={m.highlight.snippet} />
          </div>
        ) : (
          !compact && m.preview && <div className="truncate text-xs text-muted">{m.preview}</div>
        )}
      </div>
    </div>
  );
}

/** Doppelklick auf eine Zeile – nicht auf deren Schaltflächen und nicht mit Umschalt/Strg (Mehrfachauswahl) */
function dblClick(e: ReactMouseEvent, open: () => void) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.target as HTMLElement).closest('button, a, input')) return;
  e.preventDefault();
  open();
}

/** Beim Doppelklick keinen Text markieren */
function noTextSelectOnDblClick(e: ReactMouseEvent) {
  if (e.detail > 1) e.preventDefault();
}

/** Drag & Drop in einen Ordner der Seitenleiste */
function startDrag(e: ReactDragEvent, refs: MessageRef[], subject: string) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(refs));
  e.dataTransfer.effectAllowed = 'move';
  const ghost = document.createElement('div');
  ghost.textContent = refs.length > 1 ? `${refs.length} Nachrichten` : subject || '(ohne Betreff)';
  ghost.style.cssText = 'position:absolute;top:-1000px;padding:4px 10px;border-radius:6px;background:#2563eb;color:#fff;font:13px sans-serif';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 10, 10);
  setTimeout(() => ghost.remove(), 0);
}

/**
 * Einzelnachrichten einer aufgeklappten Unterhaltung (neueste zuerst), wie in Outlook –
 * inklusive ordnerübergreifend nachgeladener (eigene Antworten aus „Gesendet“, Archiv …).
 */
function ConversationChildren({
  c,
  focusKey,
  compact,
  permanentDelete,
  onClick,
  onDoubleClick,
  onError,
}: {
  c: Conversation;
  focusKey?: string;
  compact: boolean;
  permanentDelete: boolean;
  onClick: (e: ReactMouseEvent, m: MessageSummary) => void;
  onDoubleClick?: (e: ReactMouseEvent, m: MessageSummary) => void;
  onError: (err: unknown) => void;
}) {
  const qc = useQueryClient();
  const { thread, messages } = useConversationThread(c);
  const { data: folderData } = useFolders(c.latest.accountId);
  const folderById = useMemo(() => new Map((folderData?.folders ?? []).map((f) => [f.id, f])), [folderData]);
  const listKeys = useMemo(() => new Set(c.messages.map((m) => refKey(toRef(m)))), [c.messages]);
  const guard = (fn: () => Promise<unknown>) => void fn().catch(onError);

  // Antwort ohne weitere Nachrichten im Postfach: Badge verschwindet, also auch die Liste darunter
  if (thread.isFetched && messages.length <= 1) return null;

  return (
    <div role="group" aria-label="Nachrichten der Unterhaltung" className="border-b border-border/60 bg-surface-2/50">
      {messages.map((m) => {
        const ref = toRef(m);
        const key = refKey(ref);
        const inList = listKeys.has(key);
        const folder = inList ? null : folderById.get(m.folderId);
        const deleted = folder?.role === 'trash';
        const unread = !m.seen && !deleted;
        const current = key === focusKey;
        return (
          <div
            key={key}
            role="option"
            aria-selected={current}
            draggable
            onDragStart={(e) => startDrag(e, [ref], m.subject)}
            onMouseDown={onDoubleClick ? noTextSelectOnDblClick : undefined}
            onClick={(e) => onClick(e, m)}
            onDoubleClick={onDoubleClick ? (e) => onDoubleClick(e, m) : undefined}
            className={cn(
              'group relative flex cursor-pointer items-start gap-2 border-t border-border/40 pr-3',
              compact ? 'py-1 pl-[46px]' : 'py-1.5 pl-[54px]',
              current ? 'bg-primary-soft' : 'hover:bg-hover',
              deleted && 'opacity-60',
            )}
          >
            {current && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
            {unread && <span className={cn('absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary', compact ? 'left-[34px]' : 'left-[40px]')} />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px]">
                <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-semibold text-fg' : 'text-fg/80')}>{displayAddress(m.from) || '(unbekannt)'}</span>
                {folder !== null && <FolderBadge folder={folder} className="py-0 leading-4" />}
                <SmimeIcon kind={m.smime} />
                {m.hasAttachments && m.smime !== 'encrypted' && <Paperclip className="h-3 w-3 shrink-0 text-muted" />}
                {m.flagged && <Flag className="h-3 w-3 shrink-0 fill-current text-danger group-hover:hidden" />}
                <span className={cn('shrink-0 text-xs group-hover:hidden', unread ? 'font-semibold text-primary' : 'text-muted')}>{formatListDate(m.date)}</span>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <QuickBtn
                    label={m.seen ? 'Als ungelesen markieren' : 'Als gelesen markieren'}
                    onClick={() => guard(() => setFlags(qc, [ref], { seen: !m.seen }, [m]))}
                  >
                    {m.seen ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}
                  </QuickBtn>
                  <QuickBtn label={m.flagged ? 'Markierung entfernen' : 'Markieren'} onClick={() => guard(() => setFlags(qc, [ref], { flagged: !m.flagged }, [m]))}>
                    <Flag className={cn('h-3.5 w-3.5', m.flagged && 'fill-current text-danger')} />
                  </QuickBtn>
                  <QuickBtn label="Löschen" onClick={() => guard(() => deleteMessages(qc, [ref], inList ? permanentDelete : deleted))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </QuickBtn>
                </span>
              </div>
              {!compact && m.preview && <div className="truncate text-xs text-muted">{m.preview}</div>}
            </div>
          </div>
        );
      })}
      {thread.isFetching && !thread.isFetched && (
        <div className="flex justify-center border-t border-border/40 py-1">
          <Spinner className="h-3.5 w-3.5" />
        </div>
      )}
    </div>
  );
}

/** Absender einer Unterhaltung, älteste zuerst, ohne Dubletten (bei vielen gekürzt). */
function conversationSenders(c: Conversation): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of [...c.messages].reverse()) {
    const id = (m.from?.address || m.from?.name || '').toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(m.from?.name?.split(/\s+/)[0] || m.from?.address || '');
  }
  if (!names.length) return '(unbekannt)';
  return names.length > 3 ? `${names[0]} … ${names.slice(-2).join(', ')}` : names.join(', ');
}

function QuickBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 text-muted hover:bg-surface hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Sortierung und Filter nach KI-Triage (Priorität) */
function TriageListMenu({
  sortByPriority,
  prioFilter,
  onSort,
  onPrioFilter,
  untriagedCount,
  onTriageUntriaged,
}: NonNullable<MessageListProps['triage']> & { untriagedCount: number; onTriageUntriaged: () => void }) {
  const active = sortByPriority || !!prioFilter;
  const heading = (text: string): MenuItem => ({ label: <span className="text-xs font-medium uppercase tracking-wide text-muted">{text}</span>, disabled: true });
  const items: MenuItem[] = [
    {
      label: untriagedCount ? `Nicht eingeordnete einordnen (${untriagedCount})` : 'Alle geladenen sind eingeordnet',
      icon: <Sparkles />,
      disabled: !untriagedCount,
      onClick: untriagedCount ? onTriageUntriaged : undefined,
    },
    { divider: true, label: '' },
    heading('Sortieren'),
    { label: 'Nach Datum', checked: !sortByPriority, onClick: () => onSort(false) },
    { label: 'Nach Priorität', checked: sortByPriority, onClick: () => onSort(true) },
    { divider: true, label: '' },
    heading('Priorität (KI-Triage)'),
    { label: 'Alle', checked: !prioFilter, onClick: () => onPrioFilter(null) },
    ...(Object.keys(PRIORITY_FILTER_LABELS) as PriorityFilter[]).map((f) => ({
      label: PRIORITY_FILTER_LABELS[f],
      checked: prioFilter === f,
      onClick: () => onPrioFilter(f),
    })),
  ];
  const title = [sortByPriority ? 'nach Priorität sortiert' : '', prioFilter ? `nur ${PRIORITY_FILTER_LABELS[prioFilter]}` : ''].filter(Boolean).join(', ');
  return (
    <Dropdown
      align="right"
      trigger={
        <IconButton
          label={title ? `Sortieren & Filtern (${title})` : 'Nach Priorität sortieren oder filtern'}
          size="icon-sm"
          className={cn('relative', active && 'text-primary')}
        >
          <ArrowDownWideNarrow className="h-4 w-4" />
          {active && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
        </IconButton>
      }
      items={items}
    />
  );
}
