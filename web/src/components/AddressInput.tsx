import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { AddressSuggestion, EmailAddress } from '@kuvert/shared';
import { api } from '@/lib/api';
import { cn, isValidEmail, parseAddressList } from '@/lib/utils';
import { Avatar } from './ui';

/**
 * Eingabefeld für E-Mail-Adressen als "Chips" mit Autovervollständigung
 * (zuletzt verwendet + Kontakte + Verzeichnis aller Konten).
 */
export function AddressInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  className,
}: {
  value: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 180);
    return () => clearTimeout(t);
  }, [text]);

  const { data: suggestions = [] } = useQuery({
    queryKey: ['contacts', 'autocomplete', debounced],
    queryFn: () => api<AddressSuggestion[]>('/contacts/autocomplete', { query: { q: debounced } }),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
  const filtered = suggestions.filter((s) => !value.some((v) => v.address.toLowerCase() === s.address.toLowerCase()));
  const showList = focused && debounced.length >= 2 && filtered.length > 0;

  const add = (addrs: EmailAddress[]) => {
    const next = [...value];
    for (const a of addrs) if (a.address && !next.some((n) => n.address.toLowerCase() === a.address.toLowerCase())) next.push(a);
    onChange(next);
    setText('');
    setActive(0);
  };

  const commitText = () => {
    if (!text.trim()) return;
    add(parseAddressList(text));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, filtered.length - 1) : Math.max(a - 1, 0)));
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (showList && filtered[active] && e.key !== ',' && e.key !== ';') {
        e.preventDefault();
        const s = filtered[active]!;
        add([{ name: s.name, address: s.address }]);
      } else if (text.trim()) {
        if (e.key !== 'Tab') e.preventDefault();
        commitText();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      setFocused(false);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-md px-1 py-1"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((a) => (
          <span
            key={a.address}
            title={a.address}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-1.5 text-xs',
              isValidEmail(a.address) ? 'border-border bg-surface-2' : 'border-danger/50 bg-danger/10 text-danger',
            )}
          >
            <Avatar name={a.name} email={a.address} size={18} />
            <span className="truncate">{a.name || a.address}</span>
            <button
              type="button"
              className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v !== a));
              }}
              aria-label="Entfernen"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setTimeout(() => setFocused(false), 150);
            commitText();
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[,;\n]/.test(t)) {
              e.preventDefault();
              add(parseAddressList(t));
            }
          }}
          className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted"
        />
      </div>
      {showList && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl">
          {filtered.map((s, i) => (
            <button
              key={s.address}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                add([{ name: s.name, address: s.address }]);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', i === active && 'bg-hover')}
            >
              <Avatar name={s.name} email={s.address} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name || s.address}</span>
                {s.name && <span className="block truncate text-xs text-muted">{s.address}</span>}
              </span>
              <span className="text-[10px] uppercase text-muted">
                {s.label ?? (s.source === 'recent' ? 'Zuletzt' : s.source === 'directory' ? 'Verzeichnis' : 'Kontakt')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
