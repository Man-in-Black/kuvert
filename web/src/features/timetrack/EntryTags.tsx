/**
 * Schlagworte und Verknüpfungen direkt in der Übersicht:
 *  - Haken für das erste Status-Schlagwort (Standard „gebucht“),
 *  - Menü mit Status-Schlagworten (gebucht, Rechnung, fakturiert …) und allen eigenen Schlagworten,
 *  - Chips für Schlagworte und Verknüpfungen (z. B. Ticket) unter dem Eintrag.
 * Änderungen gehen sofort an den Server (ohne Bearbeiten-Dialog, ohne die Zeit anzufassen).
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle2, Circle, Copy, ExternalLink, Link2, Plus, Tag, X } from 'lucide-react';
import { toast } from 'sonner';
import { TT_DEFAULT_QUICK_TAGS, type TtEntry, type TtLink } from '@kuvert/shared';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useEntryActions, useTags, useTtSettings } from './api';

const lc = (s: string) => s.toLowerCase();
const hasTag = (tags: string[], t: string) => tags.some((x) => lc(x) === lc(t));

/** Status-Schlagworte des Benutzers (das erste ist der Haken) */
export function useQuickTags(): string[] {
  const { data } = useTtSettings();
  return data?.quickTags ?? TT_DEFAULT_QUICK_TAGS;
}

/** Schlagworte und Verknüpfungen eines Eintrags ändern */
export function useEntryMeta(entry: TtEntry) {
  const { meta } = useEntryActions();
  const quick = useQuickTags();
  const setTags = (tags: string[]) => meta.mutate({ id: entry.id, body: { tags } });
  const toggleTag = (t: string) => setTags(hasTag(entry.tags, t) ? entry.tags.filter((x) => lc(x) !== lc(t)) : [...entry.tags, t]);
  const addLink = async (link: TtLink, opts?: { markDone?: boolean }) => {
    const links = [...entry.links.filter((l) => !(l.type === link.type && l.id === link.id)), link];
    const tags = opts?.markDone && quick[0] && !hasTag(entry.tags, quick[0]) ? [...entry.tags, quick[0]] : undefined;
    await meta.mutateAsync({ id: entry.id, body: { links, ...(tags ? { tags } : {}) } });
  };
  const removeLink = (link: TtLink) => meta.mutate({ id: entry.id, body: { links: entry.links.filter((l) => !(l.type === link.type && l.id === link.id)) } });
  return { quick, setTags, toggleTag, addLink, removeLink, doneTag: quick[0] ?? null };
}

/** Haken für das erste Status-Schlagwort */
export function DoneToggle({ entry, compact }: { entry: TtEntry; compact?: boolean }) {
  const { doneTag, toggleTag } = useEntryMeta(entry);
  if (!doneTag) return null;
  const on = hasTag(entry.tags, doneTag);
  return (
    <IconButton
      label={on ? `„${doneTag}“ entfernen` : `Als „${doneTag}“ markieren`}
      size="icon-sm"
      onClick={() => toggleTag(doneTag)}
      className={cn(on ? 'text-success hover:text-success' : cn('text-subtle', !compact && 'opacity-60 group-hover:opacity-100'))}
    >
      {on ? <CheckCircle2 className="h-[18px] w-[18px] fill-success/15" /> : <Circle className="h-[18px] w-[18px]" />}
    </IconButton>
  );
}

/** Beschreibung in die Zwischenablage (z. B. zum Einfügen ins Ticket); ohne Text unsichtbar */
export function CopyTextButton({ text, compact }: { text: string | null; compact?: boolean }) {
  const [done, setDone] = useState(false);
  if (!text?.trim()) return null;
  return (
    <IconButton
      label={done ? 'Kopiert' : 'Beschreibung kopieren'}
      size="icon-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text.trim());
          setDone(true);
          toast.success('Beschreibung kopiert');
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Kopieren nicht möglich');
        }
      }}
      className={cn(done ? 'text-success hover:text-success' : !compact && 'opacity-60 group-hover:opacity-100')}
    >
      {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </IconButton>
  );
}

/* ───────────────────────────── Schlagwort-Menü ───────────────────────────── */

/** Kleines schwebendes Menü an einem Auslöser (Portal, oben/unten je nach Platz) */
export function Popover({ trigger, children, width = 260 }: { trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom;
      setPos(below < 320 && r.top > below ? { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: r.top - 12 } : { left, width, top: r.bottom + 4, maxHeight: below - 12 });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !anchor.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, width]);

  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({ open, toggle: () => setOpen((o) => !o) })}
      </span>
      {open &&
        createPortal(
          <div ref={pop} className="fixed z-[70] flex animate-scale-in flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop" style={pos}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuCheck({ on, label, onClick, tone }: { on: boolean; label: string; onClick: () => void; tone?: 'success' }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover">
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
          on ? (tone === 'success' ? 'border-success bg-success text-white' : 'border-primary bg-primary text-primary-fg') : 'border-border-strong',
        )}
      >
        {on && <Check className="h-3 w-3" strokeWidth={3.5} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function TagMenu({ entry }: { entry: TtEntry }) {
  const { quick, setTags, toggleTag } = useEntryMeta(entry);
  const { data: all } = useTags();
  const [q, setQ] = useState('');
  const others = useMemo(() => {
    const set = new Map<string, string>();
    for (const t of [...entry.tags, ...(all ?? [])]) if (!hasTag(quick, t) && !set.has(lc(t))) set.set(lc(t), t);
    const list = [...set.values()].sort((a, b) => a.localeCompare(b, 'de'));
    return q.trim() ? list.filter((t) => lc(t).includes(lc(q.trim()))) : list;
  }, [all, entry.tags, quick, q]);
  const canAdd = !!q.trim() && !hasTag([...quick, ...others], q.trim());
  const add = () => {
    const t = q.trim();
    if (!t) return;
    if (!hasTag(entry.tags, t)) setTags([...entry.tags, t]);
    setQ('');
  };
  const count = entry.tags.length;

  return (
    <Popover
      trigger={({ open, toggle }) => (
        <IconButton label="Schlagworte" size="icon-sm" onClick={toggle} className={cn(open && 'bg-hover text-fg', count && 'text-fg/80')}>
          <Tag className="h-4 w-4" />
        </IconButton>
      )}
    >
      {() => (
        <>
          {quick.length > 0 && (
            <div className="border-b border-border p-1">
              <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Status</div>
              {quick.map((t) => (
                <MenuCheck key={t} on={hasTag(entry.tags, t)} label={t} onClick={() => toggleTag(t)} tone="success" />
              ))}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col p-1">
            <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Schlagworte</div>
            <div className="flex items-center gap-1 px-1 pb-1">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="Suchen oder neu …"
                className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-sm placeholder:text-subtle focus:outline-none"
                autoFocus
                maxLength={100}
              />
              {canAdd && (
                <IconButton label={`„${q.trim()}“ hinzufügen`} size="icon-sm" onClick={add}>
                  <Plus className="h-4 w-4" />
                </IconButton>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto">
              {others.map((t) => (
                <MenuCheck key={t} on={hasTag(entry.tags, t)} label={t} onClick={() => toggleTag(t)} />
              ))}
              {!others.length && !canAdd && <div className="px-2.5 py-2 text-xs text-muted">Noch keine weiteren Schlagworte</div>}
              {canAdd && (
                <button type="button" onClick={add} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-primary hover:bg-hover">
                  <Plus className="h-4 w-4" />„{q.trim()}“ hinzufügen
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </Popover>
  );
}

/* ───────────────────────────── Chips ───────────────────────────── */

/** Schlagworte (Status grün) und Verknüpfungen unter dem Eintrag */
export function EntryChips({ entry, className }: { entry: TtEntry; className?: string }) {
  const { quick, toggleTag, removeLink } = useEntryMeta(entry);
  if (!entry.tags.length && !entry.links.length) return null;
  const status = entry.tags.filter((t) => hasTag(quick, t));
  const rest = entry.tags.filter((t) => !hasTag(quick, t));
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} onClick={(e) => e.stopPropagation()}>
      {status.map((t) => (
        <Chip key={t} tone="success" onRemove={() => toggleTag(t)} removeLabel={`„${t}“ entfernen`}>
          <Check className="h-3 w-3" strokeWidth={3} />
          {t}
        </Chip>
      ))}
      {entry.links.map((l) => (
        <Chip key={`${l.type}:${l.id}`} tone="primary" onRemove={() => removeLink(l)} removeLabel="Verknüpfung entfernen">
          {l.url ? (
            <a href={l.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 items-center gap-1 hover:underline" title={l.label}>
              <Link2 className="h-3 w-3 shrink-0" />
              <span className="max-w-[16rem] truncate">{l.label}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </a>
          ) : (
            <>
              <Link2 className="h-3 w-3 shrink-0" />
              <span className="max-w-[16rem] truncate">{l.label}</span>
            </>
          )}
        </Chip>
      ))}
      {rest.map((t) => (
        <Chip key={t} onRemove={() => toggleTag(t)} removeLabel={`„${t}“ entfernen`}>
          <Tag className="h-3 w-3" />
          {t}
        </Chip>
      ))}
    </div>
  );
}

function Chip({ children, tone, onRemove, removeLabel }: { children: ReactNode; tone?: 'success' | 'primary'; onRemove: () => void; removeLabel: string }) {
  return (
    <span
      className={cn(
        'group/chip inline-flex h-5 max-w-full items-center gap-1 rounded-md pl-1.5 pr-0.5 text-[11px] font-medium',
        tone === 'success' ? 'bg-success/10 text-success' : tone === 'primary' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-fg/75',
      )}
    >
      {children}
      <button type="button" onClick={onRemove} className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-black/10 group-hover/chip:opacity-70" aria-label={removeLabel} title={removeLabel}>
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
