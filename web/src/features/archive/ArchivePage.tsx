/**
 * Archiv: archivierte E-Mails aus Mail-Archiver durchsuchen, filtern und öffnen.
 * Zustand liegt in der URL (?q=…&acc=…&folder=…&from=…&to=…&dir=…&page=…&id=…),
 * damit Suchen verlinkt werden können (z. B. aus der Mail-Suche).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Inbox,
  Paperclip,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { ArchiverAccount, ArchiverFolder, ArchiverSearchQuery } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { cn, colorFromString } from '@/lib/utils';
import { Avatar, Badge, Button, EmptyState, IconButton, Input, Kbd, Select, Skeleton, Tabs } from '@/components/ui';
import { formatArchiveDate, useArchiverAccounts, useArchiverConfig, useArchiverFolders, useArchiverSearch, useArchiverStatus } from './api';
import { ArchiveMessage } from './ArchiveMessage';
import { ArchiveSetupCard } from './ArchiveSettings';

type Dir = 'all' | 'incoming' | 'outgoing';
const PAGE_SIZE = 25;

export function ArchivePage() {
  const { data: config, isLoading } = useArchiverConfig();

  if (isLoading) {
    return (
      <div className="p-8">
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!config?.enabled) {
    return <EmptyState icon={<Archive />} title="Mail-Archiv nicht aktiviert">Die Anbindung an Mail-Archiver wurde vom Administrator deaktiviert.</EmptyState>;
  }
  if (!config.configured) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-lg animate-scale-in">
          <ArchiveSetupCard />
        </div>
      </div>
    );
  }
  return <ArchiveBrowser />;
}

/* ───────────────────────────── Browser ───────────────────────────── */

function ArchiveBrowser() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const accountId = params.get('acc') ? Number(params.get('acc')) : undefined;
  const folder = params.get('folder') ?? undefined;
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const dir = (params.get('dir') as Dir) || 'all';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const sort = params.get('sort') ?? 'sentDate:desc';
  const selected = params.get('id') ? Number(params.get('id')) : undefined;
  const [showFilters, setShowFilters] = useState(false);

  const set = (patch: Record<string, string | number | undefined | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => set({ q: input.trim() || undefined }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const [sortBy, sortOrder] = sort.split(':') as [ArchiverSearchQuery['sortBy'], ArchiverSearchQuery['sortOrder']];
  const query: ArchiverSearchQuery = {
    q: q || undefined,
    accountId,
    folder,
    from,
    to,
    direction: dir === 'all' ? undefined : dir,
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    sortOrder,
  };

  const { data: status } = useArchiverStatus(true);
  const { data: accounts, error: accError } = useArchiverAccounts(true);
  const search = useArchiverSearch(query, true);
  const result = search.data;
  const total = result?.totalItems ?? 0;
  const startIdx = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const endIdx = Math.min(page * PAGE_SIZE, total);
  const activeFilters = [accountId, folder, from, to, dir !== 'all' ? dir : undefined].filter(Boolean).length;
  const accountById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);

  return (
    <div className="flex h-full min-h-0">
      {/* ── Filter ── */}
      <aside
        className={cn(
          'w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar',
          showFilters ? 'fixed inset-y-0 left-0 z-40 flex shadow-pop lg:static lg:shadow-none' : selected ? 'hidden 2xl:flex' : 'hidden lg:flex',
        )}
      >
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Archive className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold tracking-tight">Archiv</div>
            <div className="text-xs text-muted">{status ? `${status.emails.toLocaleString('de-DE')} Nachrichten` : 'Mail-Archiver'}</div>
          </div>
          {showFilters && (
            <IconButton label="Schließen" size="icon-sm" onClick={() => setShowFilters(false)}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>

        <div className="space-y-5 px-3 pb-6">
          <section>
            <SectionLabel>Konten</SectionLabel>
            <NavRow active={!accountId} icon={<Inbox className="h-4 w-4" />} label="Alle Konten" onClick={() => set({ acc: undefined, folder: undefined })} />
            {accError && <p className="px-2.5 py-1 text-xs text-danger">{errorMessage(accError)}</p>}
            {(accounts ?? []).map((a) => (
              <div key={a.id}>
                <NavRow
                  active={accountId === a.id && !folder}
                  icon={<Avatar name={a.emailAddress.split('@')[0] || a.name} email={a.emailAddress} size={20} />}
                  label={a.emailAddress || a.name}
                  tooltip={accountTooltip(a)}
                  onClick={() => set({ acc: a.id, folder: undefined })}
                />
                {accountId === a.id && <FolderTree accountId={a.id} current={folder} onPick={(f) => set({ folder: f })} />}
              </div>
            ))}
          </section>

          <section>
            <SectionLabel>Richtung</SectionLabel>
            <Tabs<Dir>
              className="w-full"
              value={dir}
              onChange={(v) => set({ dir: v === 'all' ? undefined : v })}
              tabs={[
                { value: 'all', label: 'Alle' },
                { value: 'incoming', label: 'Empfangen' },
                { value: 'outgoing', label: 'Gesendet' },
              ]}
            />
          </section>

          <section>
            <SectionLabel>
              <CalendarRange className="mr-1 inline h-3.5 w-3.5" /> Zeitraum
            </SectionLabel>
            <div className="grid grid-cols-2 gap-2 px-1">
              <Input type="date" value={from ?? ''} max={to} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="Von" />
              <Input type="date" value={to ?? ''} min={from} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="Bis" />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 px-1">
              {[
                { label: '30 Tage', days: 30 },
                { label: '1 Jahr', days: 365 },
                { label: '5 Jahre', days: 365 * 5 },
              ].map((r) => (
                <button
                  key={r.days}
                  type="button"
                  className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-fg"
                  onClick={() => set({ from: new Date(Date.now() - r.days * 86_400_000).toISOString().slice(0, 10), to: undefined })}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <SectionLabel>Sortierung</SectionLabel>
            <div className="px-1">
              <Select value={sort} onChange={(e) => set({ sort: e.target.value === 'sentDate:desc' ? undefined : e.target.value })}>
                <option value="sentDate:desc">Neueste zuerst</option>
                <option value="sentDate:asc">Älteste zuerst</option>
                <option value="subject:asc">Betreff A–Z</option>
                <option value="from:asc">Absender A–Z</option>
              </Select>
            </div>
          </section>

          {activeFilters > 0 && (
            <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => set({ acc: undefined, folder: undefined, from: undefined, to: undefined, dir: undefined })}>
              Filter zurücksetzen
            </Button>
          )}
        </div>
      </aside>
      {showFilters && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setShowFilters(false)} />}

      {/* ── Ergebnisliste ── */}
      <section className={cn('flex min-w-0 flex-col', selected ? 'hidden w-[400px] shrink-0 lg:flex' : 'flex-1')}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-3">
          <IconButton label="Filter" variant="outline" className={cn('relative', selected ? '2xl:hidden' : 'lg:hidden')} onClick={() => setShowFilters(true)}>
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilters > 0 && <span className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-fg">{activeFilters}</span>}
          </IconButton>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <Input
              className="h-10 pl-9 pr-16"
              placeholder="Archiv durchsuchen – z. B. subject:Rechnung from:anna@…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && set({ q: input.trim() || undefined })}
            />
            {input ? (
              <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg" onClick={() => setInput('')} aria-label="Leeren">
                <X className="h-4 w-4" />
              </button>
            ) : (
              <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 sm:block">
                <Kbd>↵</Kbd>
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3 text-xs text-muted">
          {['subject:', 'from:', 'to:'].map((hint) => (
            <button
              key={hint}
              type="button"
              onClick={() => setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}${hint}`)}
              className="rounded-md border border-dashed border-border px-1.5 py-0.5 font-mono transition-colors hover:border-border-strong hover:text-fg"
            >
              {hint}
            </button>
          ))}
          <span className="ml-auto tabular-nums">{search.isFetching ? 'Suche …' : total ? `${startIdx}–${endIdx} von ${total.toLocaleString('de-DE')}` : ''}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {search.isLoading ? (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : search.error ? (
            <EmptyState icon={<Archive />} title="Suche fehlgeschlagen">
              {errorMessage(search.error)}
            </EmptyState>
          ) : !result?.items.length ? (
            <EmptyState icon={<Search />} title="Keine Nachrichten gefunden">
              Passe Suchbegriff oder Filter an.
            </EmptyState>
          ) : (
            <ul className={cn('space-y-0.5 transition-opacity', search.isFetching && 'opacity-60')}>
              {result.items.map((m) => {
                const who = m.isOutgoing ? m.to : m.from;
                const name = who.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || who;
                const active = selected === m.id;
                const account = accountId ? undefined : accountById.get(m.accountId);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => set({ id: m.id }, false)}
                      className={cn(
                        'group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                        active ? 'bg-primary-soft' : 'hover:bg-hover',
                      )}
                    >
                      <Avatar name={name} email={who} size={34} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium">
                            {m.isOutgoing ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-info" /> : <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />}
                            <span className="truncate">{m.isOutgoing ? `An: ${name}` : name}</span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted">{formatArchiveDate(m.sentDate)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className={cn('min-w-0 flex-1 truncate text-sm', active ? 'text-fg' : 'text-muted')}>{m.subject || '(kein Betreff)'}</span>
                          {m.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-subtle" />}
                          {m.folderName && (
                            <Badge tone="neutral" className="max-w-28 shrink-0 truncate">
                              {m.folderName}
                            </Badge>
                          )}
                        </div>
                        {account && (
                          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-subtle" title={accountTooltip(account)}>
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorFromString(account.emailAddress || account.name) }} aria-hidden />
                            <span className="truncate">{account.emailAddress || account.name}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {result && result.totalPages > 1 && (
          <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2.5">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} disabled={page <= 1} onClick={() => set({ page: page - 1 }, false)}>
              Zurück
            </Button>
            <span className="text-xs tabular-nums text-muted">
              Seite {page} von {result.totalPages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= result.totalPages} onClick={() => set({ page: page + 1 }, false)}>
              Weiter <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </section>

      {/* ── Lesebereich ── */}
      {selected ? (
        <section className="min-w-0 flex-1 border-l border-border bg-surface animate-slide-in-right">
          <ArchiveMessage id={selected} onClose={() => set({ id: undefined }, false)} />
        </section>
      ) : (
        <section className="hidden min-w-0 flex-1 items-center justify-center border-l border-border bg-surface-2/30 2xl:flex">
          <EmptyState icon={<Archive />} title="Nachricht auswählen">
            Archivierte Nachrichten werden hier angezeigt. Antworten und Weiterleiten funktioniert direkt aus dem Archiv.
            <div className="mt-3 text-xs">
              Schlüssel verwalten unter <Link className="text-primary hover:underline" to="/settings/archive">Einstellungen → Mail-Archiv</Link>
            </div>
          </EmptyState>
        </section>
      )}
    </div>
  );
}

/* ───────────────────────────── Bausteine ───────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{children}</div>;
}

/** Tooltip für ein Konto: Name (Mandant) und Adresse, ohne Dopplung */
function accountTooltip(a: ArchiverAccount): string {
  return [...new Set([a.name, a.emailAddress].map((v) => v?.trim()).filter(Boolean))].join('\n');
}

function NavRow({
  active,
  icon,
  label,
  tooltip,
  onClick,
  depth = 0,
  trailing,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
  onClick: () => void;
  depth?: number;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: 10 + depth * 14 }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg py-1.5 pr-2.5 text-left text-sm transition-colors',
        active ? 'bg-primary-soft font-medium text-primary' : 'text-fg hover:bg-hover',
      )}
      title={tooltip}
    >
      <span className="flex shrink-0 items-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

function FolderTree({ accountId, current, onPick }: { accountId: number; current?: string; onPick: (fullPath: string | undefined) => void }) {
  const { data, isLoading } = useArchiverFolders(accountId);
  const flat = useMemo(() => {
    const out: ArchiverFolder[] = [];
    const walk = (list: ArchiverFolder[]) => list.forEach((f) => (out.push(f), walk(f.children ?? [])));
    walk(data ?? []);
    return out;
  }, [data]);
  if (isLoading) return <Skeleton className="mx-3 my-1 h-16" />;
  return (
    <div className="my-1 space-y-0.5">
      {flat.map((f) => (
        <NavRow
          key={f.fullPath}
          depth={f.level + 1}
          active={current === f.fullPath}
          icon={current === f.fullPath ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
          label={f.name}
          tooltip={f.fullPath}
          onClick={() => onPick(current === f.fullPath ? undefined : f.fullPath)}
          trailing={f.totalCount > 0 ? <span className="shrink-0 text-[11px] tabular-nums text-subtle">{f.totalCount.toLocaleString('de-DE')}</span> : null}
        />
      ))}
    </div>
  );
}
