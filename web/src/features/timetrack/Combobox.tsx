/**
 * Auswahlfeld mit Suche (für Projekte und Tätigkeiten). Die Liste schwebt per Portal über
 * allem (auch in Dialogen und der Seitenleiste), gruppiert nach `group` und durchsucht
 * Bezeichnung, Gruppe und `search` – bei Projekten also auch Kundenname und Nummern.
 * Tastatur: Pfeile, Enter, Esc; Tippen auf dem geschlossenen Feld öffnet die Suche.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { ColorDot } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface ComboItem {
  /** '' = Leer-Option („Keine Tätigkeit“, „Alle Projekte“) */
  id: string;
  label: string;
  group?: string;
  /** Zusätzliche Suchbegriffe (Nummern …) */
  search?: string;
  color?: string | null;
  /** Kleiner Hinweis rechts (z. B. „ausgeblendet“) */
  hint?: string;
}

const norm = (s: string) => s.toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '');

export function Combobox({
  items,
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
  display,
  className,
  searchPlaceholder = 'Suchen …',
}: {
  items: ComboItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  disabled?: boolean;
  ariaLabel: string;
  /** Anzeige des gewählten Eintrags im Feld (Standard: Gruppe › Bezeichnung) */
  display?: (item: ComboItem) => string;
  className?: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = items.find((i) => i.id === value);

  const filtered = useMemo(() => {
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    if (!tokens.length) return items;
    return items.filter((i) => {
      if (!i.id) return false; // Leer-Option nur ohne Suche
      const hay = norm(`${i.group ?? ''} ${i.label} ${i.search ?? ''}`);
      return tokens.every((t) => hay.includes(t));
    });
  }, [items, q]);

  const close = (refocus = true) => {
    setOpen(false);
    setQ('');
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (id: string) => {
    onChange(id);
    close();
  };
  const openWith = (text = '') => {
    if (disabled) return;
    setQ(text);
    setOpen(true);
  };

  // Beim Öffnen den gewählten Eintrag markieren, bei jeder Suche den ersten Treffer
  useEffect(() => {
    if (!open) return;
    const idx = q ? 0 : Math.max(0, filtered.findIndex((i) => i.id === value));
    setActive(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // Lage am Feld ausrichten (unten, sonst oben), bei Scrollen/Größenänderung nachführen
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom;
      const up = below < 300 && r.top > below;
      setPos(up ? { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(380, r.top - 12) } : { left, width, top: r.bottom + 4, maxHeight: Math.min(380, below - 12) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Klick außerhalb schließt
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const it = filtered[active];
      if (it) pick(it.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // nicht gleich den ganzen Dialog schließen
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openWith();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openWith(e.key);
    }
  };

  const text = selected ? (display ? display(selected) : selected.group ? `${selected.group} › ${selected.label}` : selected.label) : '';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openWith())}
        onKeyDown={onTriggerKey}
        className={cn(
          'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input-border bg-input px-3 text-left text-sm text-fg transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus:border-primary focus:shadow-glow focus:outline-none disabled:cursor-not-allowed disabled:opacity-60',
          open && 'border-primary shadow-glow',
          className,
        )}
      >
        {selected?.id && <ColorDot color={selected.color ?? undefined} />}
        <span className={cn('min-w-0 flex-1 truncate', !text && 'text-subtle')}>{text || placeholder}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-[70] flex animate-scale-in flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
            style={pos}
            onKeyDown={onListKey}
          >
            <div className="relative border-b border-border p-1.5">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-md bg-surface-2 pl-8 pr-2 text-sm text-fg placeholder:text-subtle focus:outline-none"
                aria-label="Suche"
                autoComplete="off"
              />
            </div>
            <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
              {filtered.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">Nichts gefunden</div>}
              {filtered.map((it, i) => {
                const header = it.group && it.group !== filtered[i - 1]?.group;
                return (
                  <div key={it.id || '__empty'}>
                    {header && <div className="truncate px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{it.group}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={it.id === value}
                      data-idx={i}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(it.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
                        it.group && 'pl-4',
                        i === active ? 'bg-hover' : '',
                        !it.id && 'text-muted',
                      )}
                    >
                      {it.id ? <ColorDot color={it.color ?? undefined} /> : null}
                      <span className="min-w-0 flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="shrink-0 text-xs text-muted">{it.hint}</span>}
                      {it.id === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
