/**
 * Gemeinsame Bausteine für den Dateibrowser (Seite "Dateien" und Auswahldialog).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronRight,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import type { AccountInfo, StorageItem } from '@kuvert/shared';
import { EmptyState, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { cn, formatSize } from '@/lib/utils';
import { sortItems, useStorageItems } from './api';

export interface Crumb {
  /** '' = Wurzelverzeichnis */
  id: string;
  name: string;
}

export function fileIcon(item: Pick<StorageItem, 'isFolder' | 'name' | 'contentType'>): { icon: LucideIcon; color: string } {
  if (item.isFolder) return { icon: Folder, color: '#e0a526' };
  const ct = (item.contentType ?? '').toLowerCase();
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return { icon: FileImage, color: '#16a34a' };
  if (ct.startsWith('video/') || ['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return { icon: FileVideo, color: '#9333ea' };
  if (ct.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return { icon: FileAudio, color: '#db2777' };
  if (ct === 'application/pdf' || ext === 'pdf') return { icon: FileText, color: '#dc2626' };
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext) || ct.includes('spreadsheet')) return { icon: FileSpreadsheet, color: '#15803d' };
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext) || ct.includes('presentation')) return { icon: Presentation, color: '#ea580c' };
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext) || ct.includes('document') || ct.startsWith('text/')) return { icon: FileText, color: '#2563eb' };
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(ext) || ct.includes('zip') || ct.includes('compressed')) return { icon: FileArchive, color: '#92400e' };
  if (['js', 'ts', 'json', 'html', 'css', 'xml', 'py', 'sh', 'yml', 'yaml'].includes(ext)) return { icon: FileCode, color: '#0891b2' };
  return { icon: FileIcon, color: 'var(--k-muted)' };
}

/** Navigationszustand: Konto, Ordnerpfad, Suche */
export function useStorageNav(accounts: AccountInfo[], persistKey?: string) {
  const [accountId, setAccountIdState] = useState<string | undefined>(() => {
    const saved = persistKey ? safeGet(persistKey) : null;
    return saved && accounts.some((a) => a.id === saved) ? saved : accounts[0]?.id;
  });
  const [stack, setStack] = useState<Crumb[]>([{ id: '', name: '' }]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Konto verfügbar machen, sobald die Kontenliste geladen ist
  useEffect(() => {
    if (!accountId || !accounts.some((a) => a.id === accountId)) {
      if (accounts[0]) setAccountIdState(accounts[0].id);
    }
  }, [accounts, accountId]);

  const account = accounts.find((a) => a.id === accountId);
  const crumbs = useMemo(() => stack.map((c, i) => (i === 0 ? { ...c, name: account?.name ?? 'Speicher' } : c)), [stack, account]);

  return {
    accountId,
    account,
    setAccountId: (id: string) => {
      setAccountIdState(id);
      setStack([{ id: '', name: '' }]);
      setSearch('');
      if (persistKey) safeSet(persistKey, id);
    },
    crumbs,
    folderId: stack[stack.length - 1]!.id,
    open: (item: StorageItem) => {
      if (!item.isFolder) return;
      setSearch('');
      setStack((s) => (debounced ? [s[0]!, { id: item.id, name: item.name }] : [...s, { id: item.id, name: item.name }]));
    },
    goTo: (index: number) => {
      setSearch('');
      setStack((s) => s.slice(0, index + 1));
    },
    search,
    setSearch,
    debouncedSearch: debounced,
  };
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* egal */
  }
}

export function Breadcrumbs({ crumbs, onGo, searching }: { crumbs: Crumb[]; onGo: (index: number) => void; searching?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 text-sm">
      {crumbs.map((c, i) => (
        <span key={`${c.id}-${i}`} className="flex min-w-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />}
          <button
            type="button"
            onClick={() => onGo(i)}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-hover',
              i === crumbs.length - 1 && !searching ? 'font-semibold' : 'text-muted',
            )}
          >
            {i === 0 && <HardDrive className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{c.name}</span>
          </button>
        </span>
      ))}
      {searching && (
        <>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="px-1.5 font-semibold">Suchergebnisse</span>
        </>
      )}
    </div>
  );
}

function formatModified(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd.MM.yyyy HH:mm', { locale: de });
}

/**
 * Liste bzw. Kacheln mit Dateien/Ordnern. Datenabfrage erfolgt hier,
 * damit Seite und Dialog identisch funktionieren.
 */
export function StorageItemList({
  accountId,
  folderId,
  search,
  view = 'list',
  selectedIds,
  dimFiles,
  hideFiles,
  onItemClick,
  onItemDoubleClick,
  renderActions,
  emptyHint,
}: {
  accountId?: string;
  folderId: string;
  search: string;
  view?: 'list' | 'grid';
  selectedIds?: Set<string>;
  dimFiles?: boolean;
  hideFiles?: boolean;
  onItemClick: (item: StorageItem) => void;
  onItemDoubleClick?: (item: StorageItem) => void;
  renderActions?: (item: StorageItem) => ReactNode;
  emptyHint?: ReactNode;
}) {
  const { data, isLoading, error, isFetching } = useStorageItems(accountId, folderId, search);
  const items = useMemo(() => sortItems((data ?? []).filter((i) => !hideFiles || i.isFolder)), [data, hideFiles]);

  if (!accountId) return null;
  if (isLoading)
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  if (error) return <div className="p-5 text-sm text-danger">{errorMessage(error)}</div>;
  if (items.length === 0)
    return (
      <EmptyState icon={<Folder />} title={search ? 'Keine Treffer' : 'Dieser Ordner ist leer'}>
        {emptyHint}
      </EmptyState>
    );

  if (view === 'grid') {
    return (
      <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2 p-3', isFetching && 'opacity-80')}>
        {items.map((item) => {
          const { icon: Icon, color } = fileIcon(item);
          const selected = selectedIds?.has(item.id);
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onItemClick(item)}
              onDoubleClick={() => onItemDoubleClick?.(item)}
              onKeyDown={(e) => e.key === 'Enter' && onItemClick(item)}
              className={cn(
                'group relative flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-transparent p-3 text-center hover:bg-hover',
                selected && 'border-primary/50 bg-primary-soft hover:bg-primary-soft',
                dimFiles && !item.isFolder && 'opacity-40',
              )}
              title={item.name}
            >
              <Icon className="h-10 w-10" style={{ color }} strokeWidth={1.5} />
              <span className="line-clamp-2 w-full break-words text-xs">{item.name}</span>
              {!item.isFolder && <span className="text-[10px] text-muted">{formatSize(item.size)}</span>}
              {renderActions && <div className="absolute right-1 top-1 hidden group-hover:flex">{renderActions(item)}</div>}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <table className={cn('w-full text-sm', isFetching && 'opacity-80')}>
      <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-muted">
        <tr className="border-b border-border">
          <th className="px-4 py-2 font-medium">Name</th>
          <th className="hidden w-28 px-2 py-2 text-right font-medium sm:table-cell">Größe</th>
          <th className="hidden w-40 px-2 py-2 font-medium md:table-cell">Geändert</th>
          {renderActions && <th className="w-px px-2 py-2" />}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const { icon: Icon, color } = fileIcon(item);
          const selected = selectedIds?.has(item.id);
          return (
            <tr
              key={item.id}
              onClick={() => onItemClick(item)}
              onDoubleClick={() => onItemDoubleClick?.(item)}
              className={cn(
                'group cursor-pointer border-b border-border/60 hover:bg-hover',
                selected && 'bg-primary-soft hover:bg-primary-soft',
                dimFiles && !item.isFolder && 'opacity-40',
              )}
            >
              <td className="max-w-0 px-4 py-2">
                <div className="flex items-center gap-2.5">
                  <Icon className="h-5 w-5 shrink-0" style={{ color }} strokeWidth={1.75} />
                  <span className="truncate" title={item.path ?? item.name}>
                    {item.name}
                  </span>
                </div>
                {search && item.path && <div className="truncate pl-7 text-[11px] text-muted">{item.path}</div>}
              </td>
              <td className="hidden px-2 py-2 text-right text-xs text-muted sm:table-cell">{item.isFolder ? '' : formatSize(item.size)}</td>
              <td className="hidden px-2 py-2 text-xs text-muted md:table-cell">{formatModified(item.modified)}</td>
              {renderActions && (
                <td className="whitespace-nowrap px-2 py-1 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="invisible flex justify-end gap-0.5 group-hover:visible">{renderActions(item)}</div>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
