/**
 * Befehlspalette (Strg/⌘ + K): schnell zu Bereichen, Einstellungs- und
 * Admin-Seiten springen oder Aktionen ausführen (neue E-Mail, neuer Termin, Theme …).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarPlus, CornerDownLeft, LogOut, Mail, PenSquare, Search } from 'lucide-react';
import type { SearchResult } from '@kuvert/shared';
import { api } from '@/lib/api';
import { useAppInfo, useFeature } from '@/lib/queries';
import { cn, displayAddress, formatListDate } from '@/lib/utils';
import { Highlighted } from '@/features/mail/Highlight';
import { messageUrl } from '@/features/mail/links';
import { useModules } from '@/modules/context';
import { openCompose } from '@/features/mail/compose-api';
import { Kbd } from '@/components/ui';
import { THEME_OPTIONS, useLogout, useShellActions, useThemeSwitch } from './shell-helpers';

const OPEN_EVENT = 'kuvert:command-palette';

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Command {
  id: string;
  group: string;
  label: string;
  /** Hervorgehobener Label-Text (Suchtreffer) */
  highlight?: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const mods = useModules();
  const { data: app } = useAppInfo();
  const { setTheme } = useThemeSwitch();
  const logout = useLogout();
  const shellActions = useShellActions();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Im Editor ist Strg+K für Links reserviert
      if ((e.target as HTMLElement | null)?.closest?.('.ProseMirror')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => navigate(path);
    const list: Command[] = [
      { id: 'compose', group: 'Aktionen', label: 'Neue E-Mail verfassen', icon: <PenSquare />, keywords: 'mail schreiben compose', run: () => openCompose() },
      { id: 'event', group: 'Aktionen', label: 'Neuer Termin', icon: <CalendarPlus />, keywords: 'kalender event', run: go('/calendar?new=1') },
    ];
    for (const a of shellActions) {
      list.push({ id: `act-${a.id}`, group: 'Aktionen', label: a.label, icon: <a.icon />, keywords: a.keywords, run: a.run });
    }
    for (const n of mods.flatMap((m) => m.nav ?? []).sort((a, b) => a.order - b.order)) {
      list.push({ id: `nav-${n.path}`, group: 'Gehe zu', label: n.label, icon: <n.icon />, run: go(`/${n.path}`) });
    }
    for (const s of mods.flatMap((m) => m.settings ?? []).sort((a, b) => a.order - b.order)) {
      list.push({
        id: `set-${s.id}`,
        group: 'Einstellungen',
        label: s.label,
        hint: 'Einstellungen',
        icon: s.icon ? <s.icon /> : undefined,
        keywords: 'einstellungen settings',
        run: go(`/settings/${s.id}`),
      });
    }
    if (app?.user?.isAdmin) {
      const adminSections = mods.flatMap((m) => m.admin ?? []).sort((a, b) => a.order - b.order);
      for (const s of adminSections) {
        list.push({
          id: `adm-${s.id}`,
          group: 'Admin',
          label: s.label,
          hint: 'Admin',
          icon: s.icon ? <s.icon /> : undefined,
          keywords: 'admin verwaltung',
          run: go(`/admin/${s.id}`),
        });
      }
    }
    for (const t of THEME_OPTIONS) {
      list.push({ id: `theme-${t.value}`, group: 'Darstellung', label: `Design: ${t.label}`, icon: <t.icon />, keywords: 'theme dark light modus', run: () => setTheme(t.value) });
    }
    list.push({ id: 'logout', group: 'Konto', label: 'Abmelden', icon: <LogOut />, keywords: 'logout', run: () => void logout() });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, shellActions, app?.user?.isAdmin]);

  // Mit Suchindex: passende E-Mails direkt in der Palette (Millisekunden)
  const searchOn = useFeature('search');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 120);
    return () => clearTimeout(t);
  }, [query]);
  const mailHits = useQuery({
    queryKey: ['search', 'palette', debounced],
    queryFn: () => api<SearchResult>('/search/query', { query: { q: debounced, limit: 6 } }),
    enabled: open && searchOn && debounced.length >= 2,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const terms = q.split(/\s+/);
    const matching = commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    if (!searchOn || q.length < 2) return matching;
    const mails: Command[] = (mailHits.data?.items ?? []).map((m) => ({
      id: `mail-${m.accountId}-${m.folderId}-${m.id}`,
      group: mailHits.data ? `E-Mails · ${mailHits.data.total.toLocaleString('de-DE')} Treffer in ${mailHits.data.processingTimeMs} ms` : 'E-Mails',
      label: m.subject || '(ohne Betreff)',
      highlight: m.highlight?.subject,
      hint: `${displayAddress(m.from)} · ${formatListDate(m.date)}`,
      icon: <Mail />,
      run: () => navigate(messageUrl({ accountId: m.accountId, folderId: m.folderId, id: m.id })),
    }));
    if (mails.length) {
      mails.push({
        id: 'mail-all',
        group: mails[0]!.group,
        label: `Alle Treffer für „${query.trim()}“ anzeigen`,
        icon: <Search />,
        run: () => navigate(`/mail/search?q=${encodeURIComponent(query.trim())}`),
      });
    }
    return [...matching, ...mails];
  }, [commands, query, searchOn, mailHits.data, navigate]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (c?: Command) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[60] flex animate-fade-in items-start justify-center bg-slate-950/40 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
      <div
        className="w-full max-w-xl animate-scale-in overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Befehlspalette"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-subtle" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(filtered[active]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder={searchOn ? 'E-Mails, Befehle oder Bereiche suchen …' : 'Wohin möchtest du? Befehl oder Bereich suchen …'}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted">Keine Treffer für „{query}“</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{header}</div>}
                <button
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    i === active ? 'bg-primary-soft text-primary' : 'text-fg',
                  )}
                >
                  <span className={cn('flex h-7 w-7 items-center justify-center rounded-md [&_svg]:h-4 [&_svg]:w-4', i === active ? 'bg-surface text-primary' : 'bg-surface-2 text-muted')}>
                    {c.icon ?? <ArrowRight />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.highlight ? <Highlighted text={c.highlight} /> : c.label}</span>
                  {c.hint && <span className="text-xs text-subtle">{c.hint}</span>}
                  {i === active && <CornerDownLeft className="h-3.5 w-3.5 text-primary" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-border bg-surface-2/60 px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> auswählen
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> ausführen
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
