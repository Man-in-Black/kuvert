/**
 * Seitenleiste: Verfassen, gemeinsamer Posteingang und Ordnerbäume aller Konten
 * (inkl. freigegebener Postfächer), Drag & Drop zum Verschieben von Nachrichten
 * sowie zum Umsortieren von Favoriten und Konten.
 */
import { useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, ChevronDown, ChevronRight, FolderPlus, Inbox, Pencil, Pin, PinOff, Settings, SlidersHorizontal, Star, Trash2, Users } from 'lucide-react';
import { DEFAULT_USER_SETTINGS, type AccountInfo, type FavoriteFolder, type FolderListResult, type MailFolder, type UserSettings } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useSettings, useUpdateSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button, ColorDot, Spinner, useConfirm, type MenuItem } from '@/components/ui';
import { buildFolderTree, fetchFolders, folderLabel, folderPath, mailKeys, moveMessages, type FolderNode, type ListView, type MessageRef } from './api';
import { useMailAccounts } from './hooks';
import { ContextMenu, PromptDialog } from './components/menus';
import { FolderIcon } from './components/FolderIcon';
import { UnifiedInboxDialog } from './components/UnifiedInboxDialog';
import { openComposer } from './compose/store';

export const DRAG_MIME = 'application/x-kuvert-mail';
/** Interne Drag-Typen zum Umsortieren (nur Kleinbuchstaben – dataTransfer.types ist kleingeschrieben) */
const FAV_MIME = 'application/x-kuvert-favorite';
const ACCOUNT_MIME = 'application/x-kuvert-account';

/** Element `from` vor bzw. hinter `target` einsortieren (gibt bei No-op dieselbe Liste zurück) */
function reorder<T>(list: T[], from: number, target: number, before: boolean): T[] {
  if (from < 0 || target < 0 || from === target) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  const idx = (target > from ? target - 1 : target) + (before ? 0 : 1);
  next.splice(idx, 0, item!);
  return next.every((x, i) => x === list[i]) ? list : next;
}

/** Ablageziel beim Umsortieren: merkt sich, ob über oder unter dem Element abgelegt wird */
function useReorderTarget(mime: string, onDrop: (data: string, before: boolean) => void) {
  const [pos, setPos] = useState<'before' | 'after' | null>(null);
  const isBefore = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };
  return {
    pos,
    handlers: {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!e.dataTransfer.types.includes(mime)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setPos(isBefore(e) ? 'before' : 'after');
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPos(null);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!e.dataTransfer.types.includes(mime)) return;
        e.preventDefault();
        setPos(null);
        onDrop(e.dataTransfer.getData(mime), isBefore(e));
      },
    },
  };
}

/** Einfügelinie über bzw. unter einem Element (Elternelement braucht `relative`) */
function DropLine({ pos }: { pos: 'before' | 'after' | null }) {
  if (!pos) return null;
  return <div className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary', pos === 'before' ? '-top-px' : '-bottom-px')} />;
}

/** Konto-Reihenfolge (serverseitig, gilt überall in der App) */
function useMoveAccount() {
  const qc = useQueryClient();
  return (id: string, targetId: string, before: boolean) => {
    const all = qc.getQueryData<AccountInfo[]>(qk.accounts);
    if (!all) return;
    const next = reorder(
      all,
      all.findIndex((a) => a.id === id),
      all.findIndex((a) => a.id === targetId),
      before,
    );
    if (next === all) return;
    qc.setQueryData<AccountInfo[]>(
      qk.accounts,
      next.map((a, i) => ({ ...a, sort: i })),
    );
    api('/accounts/order', { method: 'PUT', body: { ids: next.map((a) => a.id) } }).catch((err) => {
      toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: qk.accounts });
    });
  };
}

const COLLAPSE_KEY = 'kuvert.mail.collapsed';
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s]));
  } catch {
    /* egal */
  }
}

type Current = ListView | 'scheduled';

const FAVORITES_KEY = '__favorites';

/** Favoriten-Ordner (in den Benutzereinstellungen, also geräteübergreifend) */
function useFavoriteFolders() {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const favorites = settings.favoriteFolders ?? [];
  // Immer vom aktuellen Cache-Stand ausgehen, damit schnelle Klicks sich nicht überschreiben
  const current = () => qc.getQueryData<UserSettings>(qk.settings)?.favoriteFolders ?? favorites;
  const same = (a: FavoriteFolder, accountId: string, folderId: string) => a.accountId === accountId && a.folderId === folderId;
  const save = (next: FavoriteFolder[]) => {
    qc.setQueryData<UserSettings>(qk.settings, (old) => ({ ...(old ?? DEFAULT_USER_SETTINGS), favoriteFolders: next }));
    update.mutate(
      { favoriteFolders: next },
      {
        onError: (err) => {
          toast.error(errorMessage(err));
          void qc.invalidateQueries({ queryKey: qk.settings });
        },
      },
    );
  };
  return {
    favorites,
    isFavorite: (accountId: string, folderId: string) => favorites.some((f) => same(f, accountId, folderId)),
    add: (accountId: string, folderId: string) => {
      const list = current();
      if (!list.some((f) => same(f, accountId, folderId))) save([...list, { accountId, folderId }]);
    },
    remove: (accountId: string, folderId: string) => save(current().filter((f) => !same(f, accountId, folderId))),
    /** Zwei Favoriten tauschen (für „Nach oben/unten“) */
    swap: (a: FavoriteFolder, b: FavoriteFolder) => {
      const list = [...current()];
      const i = list.findIndex((f) => same(f, a.accountId, a.folderId));
      const j = list.findIndex((f) => same(f, b.accountId, b.folderId));
      if (i < 0 || j < 0) return;
      [list[i], list[j]] = [list[j]!, list[i]!];
      save(list);
    },
    /** Favoriten per Drag & Drop vor bzw. hinter einen anderen setzen */
    move: (a: FavoriteFolder, target: FavoriteFolder, before: boolean) => {
      const list = current();
      const next = reorder(
        list,
        list.findIndex((f) => same(f, a.accountId, a.folderId)),
        list.findIndex((f) => same(f, target.accountId, target.folderId)),
        before,
      );
      if (next !== list) save(next);
    },
  };
}

/** Per Drag & Drop abgelegte Nachrichten in einen Ordner verschieben */
async function dropMessages(qc: QueryClient, e: DragEvent, accountId: string, folder: MailFolder) {
  e.preventDefault();
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return;
  let refs: MessageRef[] = [];
  try {
    refs = JSON.parse(raw) as MessageRef[];
  } catch {
    return;
  }
  const same = refs.filter((r) => r.accountId === accountId && r.folderId !== folder.id);
  if (same.length < refs.length) toast.warning('Nachrichten können nur innerhalb desselben Kontos verschoben werden');
  if (!same.length) return;
  try {
    await moveMessages(qc, same, folder.id);
    toast.success(`${same.length} Nachricht${same.length > 1 ? 'en' : ''} verschoben nach „${folderLabel(folder)}“`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** Ungelesen-Zähler wie im Ordnerbaum (Gesendet/Papierkorb zählen nicht) */
const unreadOf = (f: MailFolder) => (f.role === 'sent' || f.role === 'trash' ? 0 : f.unread ?? 0);

export function MailSidebar({ current }: { current: Current }) {
  const accounts = useMailAccounts();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  const folderQueries = useQueries({
    queries: accounts.map((a) => ({ queryKey: mailKeys.folders(a.id), queryFn: () => fetchFolders(a.id), staleTime: 60_000, refetchInterval: 120_000 })),
  });
  // Ungelesen-Zähler über alle ausgewählten Posteingänge (Hauptpostfach + gewählte freigegebene Postfächer)
  const unifiedUnread = accounts.reduce((sum, a, i) => {
    const data = folderQueries[i]?.data;
    if (!data) return sum;
    const primary = data.mailboxes[0]?.id;
    const shared = new Set((a.settings.unifiedSharedMailboxes ?? []).map((m) => m.trim().toLowerCase()));
    return (
      sum +
      data.folders
        .filter((f) => f.role === 'inbox')
        .filter((f) => (!f.mailboxId || f.mailboxId === primary ? a.settings.includeInUnifiedInbox !== false : shared.has(f.mailboxId.toLowerCase())))
        .reduce((n, f) => n + (f.unread ?? 0), 0)
    );
  }, 0);
  const [unifiedDialog, setUnifiedDialog] = useState(false);
  const [unifiedMenu, setUnifiedMenu] = useState<{ x: number; y: number } | null>(null);

  const isUnified = typeof current === 'object' && current.kind === 'unified';
  const isFlagged = isUnified && !!current.flaggedOnly;

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="p-3">
        <Button variant="primary" className="w-full justify-center" icon={<Pencil className="h-4 w-4" />} onClick={() => openComposer({ mode: 'new' })}>
          Verfassen
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 text-sm">
        <SideLink
          to="/mail/unified"
          active={isUnified && !isFlagged}
          icon={<Inbox className="h-4 w-4" />}
          label="Alle Posteingänge"
          count={unifiedUnread}
          onContextMenu={(e) => {
            e.preventDefault();
            setUnifiedMenu({ x: e.clientX, y: e.clientY });
          }}
          action={{ label: 'Posteingänge auswählen', icon: <SlidersHorizontal className="h-3.5 w-3.5" />, onClick: () => setUnifiedDialog(true) }}
        />
        <SideLink to="/mail/flagged" active={isFlagged} icon={<Star className="h-4 w-4" />} label="Markiert" />
        <SideLink to="/mail/scheduled" active={current === 'scheduled'} icon={<CalendarClock className="h-4 w-4" />} label="Geplant" />

        <FavoritesSection
          accounts={accounts}
          folderQueries={folderQueries}
          current={current}
          closed={collapsed.has(FAVORITES_KEY)}
          onToggle={() => toggle(FAVORITES_KEY)}
        />

        {accounts.length === 0 && (
          <div className="mt-6 rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted">
            Noch kein Mail-Konto verbunden.
            <Button size="sm" className="mt-2" onClick={() => navigate('/settings/accounts')}>
              Konto hinzufügen
            </Button>
          </div>
        )}

        {accounts.map((a, i) => (
          <AccountSection
            key={a.id}
            account={a}
            prevId={accounts[i - 1]?.id}
            nextId={accounts[i + 1]?.id}
            data={folderQueries[i]?.data}
            loading={!!folderQueries[i]?.isLoading}
            error={folderQueries[i]?.error}
            current={current}
            collapsed={collapsed}
            onToggle={toggle}
          />
        ))}
      </nav>
      {unifiedMenu && (
        <ContextMenu
          x={unifiedMenu.x}
          y={unifiedMenu.y}
          items={[{ label: 'Posteingänge auswählen …', icon: <SlidersHorizontal />, onClick: () => setUnifiedDialog(true) }]}
          onClose={() => setUnifiedMenu(null)}
        />
      )}
      <UnifiedInboxDialog open={unifiedDialog} onClose={() => setUnifiedDialog(false)} accounts={accounts} folderQueries={folderQueries} />
    </aside>
  );
}

function SideLink({
  to,
  active,
  icon,
  label,
  count,
  onContextMenu,
  action,
}: {
  to: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onContextMenu?: (e: ReactMouseEvent) => void;
  /** Optionale Schaltfläche, die beim Überfahren rechts eingeblendet wird */
  action?: { label: string; icon: React.ReactNode; onClick: () => void };
}) {
  return (
    <div className="group relative" onContextMenu={onContextMenu}>
      <Link
        to={to}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-fg/90 hover:bg-hover',
          active && 'bg-primary-soft font-medium text-primary hover:bg-primary-soft',
        )}
      >
        <span className={cn('text-muted', active && 'text-primary')}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!!count && <span className={cn('text-xs font-semibold text-primary', action && 'group-focus-within:invisible group-hover:invisible')}>{count}</span>}
      </Link>
      {action && (
        <button
          type="button"
          title={action.label}
          aria-label={action.label}
          onClick={action.onClick}
          className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-muted hover:bg-hover hover:text-fg focus-visible:flex group-focus-within:flex group-hover:flex"
        >
          {action.icon}
        </button>
      )}
    </div>
  );
}

function FavoritesSection({
  accounts,
  folderQueries,
  current,
  closed,
  onToggle,
}: {
  accounts: AccountInfo[];
  folderQueries: UseQueryResult<FolderListResult>[];
  current: Current;
  closed: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fav = useFavoriteFolders();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Nur Favoriten anzeigen, deren Konto und Ordner (noch) existieren
  const rows = fav.favorites.flatMap((f) => {
    const i = accounts.findIndex((a) => a.id === f.accountId);
    const data = i >= 0 ? folderQueries[i]?.data : undefined;
    const folder = data?.folders.find((x) => x.id === f.folderId);
    if (!data || !folder) return [];
    // Bei freigegebenen Postfächern den Postfachnamen dazuschreiben (sonst gäbe es mehrere „Posteingang“)
    const primary = data.mailboxes[0]?.id;
    const mailbox = data.mailboxes.length > 1 && folder.mailboxId && folder.mailboxId !== primary ? data.mailboxes.find((m) => m.id === folder.mailboxId) : undefined;
    return [{ fav: f, account: accounts[i]!, folder, mailbox }];
  });
  if (!rows.length) return null;

  return (
    <div className="mt-4">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-hover">
        {closed ? <ChevronRight className="h-3.5 w-3.5 text-muted" /> : <ChevronDown className="h-3.5 w-3.5 text-muted" />}
        <Pin className="h-3 w-3 text-muted" />
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">Favoriten</span>
      </button>
      {!closed && (
        <div className="mt-0.5">
          {rows.map(({ fav: f, account, folder, mailbox }, idx) => {
            const active = typeof current === 'object' && current.kind === 'folder' && current.accountId === account.id && current.folderId === folder.id;
            const prev = rows[idx - 1]?.fav;
            const next = rows[idx + 1]?.fav;
            return (
              <FavoriteItem key={`${f.accountId}|${f.folderId}`} fav={f} onMove={fav.move}>
                <FolderRow
                  label={folderLabel(folder)}
                  sub={mailbox?.name || account.email || account.name}
                  title={`${folderLabel(folder)} – ${mailbox ? `${mailbox.name} (${mailbox.address})` : `${account.name} (${account.email})`}`}
                  lead={<ColorDot color={account.color} className="h-2 w-2" />}
                  role={folder.role}
                  depth={0}
                  active={active}
                  unread={unreadOf(folder)}
                  total={folder.role === 'drafts' ? folder.total : undefined}
                  selectable={folder.selectable !== false}
                  hasChildren={false}
                  closed={false}
                  onToggle={() => {}}
                  onOpen={() => navigate(folderPath(account.id, folder.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: 'Nach oben', icon: <ArrowUp />, disabled: !prev, onClick: () => prev && fav.swap(f, prev) },
                        { label: 'Nach unten', icon: <ArrowDown />, disabled: !next, onClick: () => next && fav.swap(f, next) },
                        { divider: true, label: '' },
                        { label: 'Aus Favoriten entfernen', icon: <PinOff />, onClick: () => fav.remove(account.id, folder.id) },
                      ],
                    });
                  }}
                  onDrop={(e) => void dropMessages(qc, e, account.id, folder)}
                />
              </FavoriteItem>
            );
          })}
        </div>
      )}
      {/* Trennlinie zwischen Favoriten und Konten */}
      <div className="mx-1 mt-3 border-t border-border" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Ein per Drag & Drop umsortierbarer Favorit */
function FavoriteItem({
  fav,
  onMove,
  children,
}: {
  fav: FavoriteFolder;
  onMove: (a: FavoriteFolder, target: FavoriteFolder, before: boolean) => void;
  children: ReactNode;
}) {
  const { pos, handlers } = useReorderTarget(FAV_MIME, (data, before) => {
    try {
      onMove(JSON.parse(data) as FavoriteFolder, fav, before);
    } catch {
      /* fremde Daten */
    }
  });
  return (
    <div
      className="relative"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FAV_MIME, JSON.stringify({ accountId: fav.accountId, folderId: fav.folderId }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      {...handlers}
    >
      <DropLine pos={pos} />
      {children}
    </div>
  );
}

function AccountSection({
  account,
  prevId,
  nextId,
  data,
  loading,
  error,
  current,
  collapsed,
  onToggle,
}: {
  account: AccountInfo;
  /** Nachbarkonten in der Seitenleiste (für „Nach oben/unten“) */
  prevId?: string;
  nextId?: string;
  data?: FolderListResult;
  loading: boolean;
  error: unknown;
  current: Current;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; label: string; initial?: string; submit: (v: string) => void } | null>(null);
  const fav = useFavoriteFolders();
  const moveAccount = useMoveAccount();
  const drop = useReorderTarget(ACCOUNT_MIME, (id, before) => id && id !== account.id && moveAccount(id, account.id, before));
  const isCollapsed = collapsed.has(account.id);

  const groups = useMemo(() => {
    if (!data) return [];
    const mbs = data.mailboxes;
    if (mbs.length <= 1) return [{ mailbox: undefined, tree: buildFolderTree(data.folders) }];
    return mbs.map((mb, idx) => ({
      mailbox: mb,
      tree: buildFolderTree(data.folders.filter((f) => f.mailboxId === mb.id || (!f.mailboxId && idx === 0))),
    }));
  }, [data]);

  const createFolder = (parentId: string | null) =>
    setPrompt({
      title: parentId ? 'Neuer Unterordner' : 'Neuer Ordner',
      label: 'Name',
      submit: async (name) => {
        try {
          await api(`/mail/accounts/${account.id}/folders`, { method: 'POST', body: { name, parentId } });
          void qc.invalidateQueries({ queryKey: mailKeys.folders(account.id) });
        } catch (err) {
          toast.error(errorMessage(err));
        }
      },
    });

  const folderMenu = (e: ReactMouseEvent, f: MailFolder) => {
    e.preventDefault();
    const pinned = fav.isFavorite(account.id, f.id);
    const items: MenuItem[] = [
      pinned
        ? { label: 'Aus Favoriten entfernen', icon: <PinOff />, onClick: () => fav.remove(account.id, f.id) }
        : { label: 'Zu Favoriten hinzufügen', icon: <Pin />, disabled: f.selectable === false, onClick: () => fav.add(account.id, f.id) },
      { divider: true, label: '' },
      { label: 'Neuer Unterordner …', icon: <FolderPlus />, onClick: () => createFolder(f.id) },
      {
        label: 'Umbenennen …',
        icon: <Pencil />,
        disabled: f.role !== 'other',
        onClick: () =>
          setPrompt({
            title: 'Ordner umbenennen',
            label: 'Neuer Name',
            initial: f.name,
            submit: async (name) => {
              try {
                await api(`/mail/accounts/${account.id}/folders`, { method: 'PATCH', body: { folderId: f.id, name } });
                void qc.invalidateQueries({ queryKey: mailKeys.folders(account.id) });
              } catch (err) {
                toast.error(errorMessage(err));
              }
            },
          }),
      },
      { divider: true, label: '' },
      {
        label: 'Ordner löschen',
        icon: <Trash2 />,
        danger: true,
        disabled: f.role !== 'other',
        onClick: async () => {
          if (!(await confirm(`Ordner „${f.name}“ mit allen Nachrichten löschen?`, { danger: true }))) return;
          try {
            await api(`/mail/accounts/${account.id}/folders`, { method: 'DELETE', query: { folderId: f.id } });
            if (fav.isFavorite(account.id, f.id)) fav.remove(account.id, f.id);
            void qc.invalidateQueries({ queryKey: mailKeys.folders(account.id) });
            if (typeof current === 'object' && current.kind === 'folder' && current.folderId === f.id) navigate('/mail/unified');
          } catch (err) {
            toast.error(errorMessage(err));
          }
        },
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const accountMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Neuer Ordner …', icon: <FolderPlus />, onClick: () => createFolder(null) },
        { label: 'Ordner aktualisieren', onClick: () => void qc.invalidateQueries({ queryKey: mailKeys.folders(account.id) }) },
        { label: 'Kontoeinstellungen', icon: <Settings />, onClick: () => navigate('/settings/accounts') },
        { divider: true, label: '' },
        { label: 'Nach oben', icon: <ArrowUp />, disabled: !prevId, onClick: () => prevId && moveAccount(account.id, prevId, true) },
        { label: 'Nach unten', icon: <ArrowDown />, disabled: !nextId, onClick: () => nextId && moveAccount(account.id, nextId, false) },
      ],
    });
  };

  const activeFolderId = typeof current === 'object' && current.kind === 'folder' && current.accountId === account.id ? current.folderId : undefined;
  // E-Mail-Adresse unter dem Namen, damit gleich benannte Konten unterscheidbar sind
  const showEmail = !!account.email && account.email.trim().toLowerCase() !== account.name.trim().toLowerCase();

  const renderNode = (n: FolderNode) => {
    const f = n.folder;
    const key = `${account.id}|${f.id}`;
    const hasChildren = n.children.length > 0;
    const closed = collapsed.has(key);
    const active = activeFolderId === f.id;
    return (
      <div key={f.id}>
        <FolderRow
          label={folderLabel(f)}
          role={f.role}
          depth={n.depth}
          active={active}
          unread={unreadOf(f)}
          total={f.role === 'drafts' ? f.total : undefined}
          selectable={f.selectable !== false}
          hasChildren={hasChildren}
          closed={closed}
          onToggle={() => onToggle(key)}
          onOpen={() => f.selectable !== false && navigate(folderPath(account.id, f.id))}
          onContextMenu={(e) => folderMenu(e, f)}
          onDrop={(e) => void dropMessages(qc, e, account.id, f)}
        />
        {hasChildren && !closed && n.children.map(renderNode)}
      </div>
    );
  };

  return (
    <div className="relative mt-4" {...drop.handlers}>
      <DropLine pos={drop.pos} />
      <div
        className="group flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-hover"
        onContextMenu={accountMenu}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(ACCOUNT_MIME, account.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button
          type="button"
          onClick={() => onToggle(account.id)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          title={showEmail ? `${account.name} <${account.email}>` : account.name}
        >
          <span className="flex h-4 shrink-0 items-center gap-1.5">
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted" /> : <ChevronDown className="h-3.5 w-3.5 text-muted" />}
            <ColorDot color={account.color} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold uppercase tracking-wide text-muted">{account.name}</span>
            {showEmail && <span className="block truncate text-[11px] leading-4 text-muted/70">{account.email}</span>}
          </span>
        </button>
        {account.status !== 'ok' && (
          <Link to="/settings/accounts" title={account.statusMessage ?? 'Verbindungsproblem – Konto prüfen'} className="text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {!isCollapsed && (
        <div className="mt-0.5">
          {loading && (
            <div className="flex justify-center py-2">
              <Spinner className="h-4 w-4" />
            </div>
          )}
          {!!error && (
            <div className="px-2 py-1 text-xs text-danger" title={errorMessage(error)}>
              Ordner konnten nicht geladen werden
            </div>
          )}
          {groups.map((g) =>
            g.mailbox ? (
              <div key={g.mailbox.id} className="mt-1">
                <button
                  type="button"
                  onClick={() => onToggle(`${account.id}|mb|${g.mailbox!.id}`)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-hover"
                  title={g.mailbox.address}
                >
                  {collapsed.has(`${account.id}|mb|${g.mailbox.id}`) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {g.mailbox.shared && <Users className="h-3.5 w-3.5" />}
                  <span className="truncate font-medium">{g.mailbox.name}</span>
                </button>
                {!collapsed.has(`${account.id}|mb|${g.mailbox.id}`) && <div className="pl-2">{g.tree.map(renderNode)}</div>}
              </div>
            ) : (
              <div key="primary">{g.tree.map(renderNode)}</div>
            ),
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <PromptDialog
        open={!!prompt}
        title={prompt?.title ?? ''}
        label={prompt?.label ?? ''}
        initial={prompt?.initial}
        onClose={() => setPrompt(null)}
        onSubmit={(v) => prompt?.submit(v)}
      />
      {dialog}
    </div>
  );
}

function FolderRow({
  label,
  sub,
  title,
  lead,
  role,
  depth,
  active,
  unread,
  total,
  selectable,
  hasChildren,
  closed,
  onToggle,
  onOpen,
  onContextMenu,
  onDrop,
}: {
  label: string;
  /** Zweite Zeile unter dem Namen (z. B. Konto bzw. Postfach bei Favoriten) */
  sub?: string;
  title?: string;
  /** Ersetzt den Auf-/Zuklapp-Pfeil (z. B. Konto-Farbpunkt bei Favoriten) */
  lead?: ReactNode;
  role: MailFolder['role'];
  depth: number;
  active: boolean;
  unread: number;
  total?: number;
  selectable: boolean;
  hasChildren: boolean;
  closed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (selectable && e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
      className={cn(
        'flex cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pr-2 text-fg/90 hover:bg-hover',
        active && 'bg-primary-soft font-medium text-primary hover:bg-primary-soft',
        !selectable && 'cursor-default text-muted',
        over && 'ring-2 ring-primary',
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      <span
        className={cn('flex h-4 w-4 shrink-0 items-center justify-center text-muted', !hasChildren && !lead && 'invisible')}
        onClick={
          hasChildren
            ? (e) => {
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
      >
        {lead ?? (closed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
      <FolderIcon role={role} className={cn('h-4 w-4 shrink-0 text-muted', active && 'text-primary')} />
      <span className={cn('min-w-0 flex-1', unread > 0 && 'font-semibold')}>
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-[11px] font-normal leading-4 text-muted/70">{sub}</span>}
      </span>
      {unread > 0 ? <span className="text-xs font-semibold text-primary">{unread}</span> : total ? <span className="text-xs text-muted">{total}</span> : null}
    </div>
  );
}
