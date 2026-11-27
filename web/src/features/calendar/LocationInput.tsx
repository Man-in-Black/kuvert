import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Loader2, MapPin } from 'lucide-react';
import type { PlaceDetails, PlaceSuggestion } from '@kuvert/shared';
import { Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useFeature } from '@/lib/queries';
import { cn } from '@/lib/utils';

const newSession = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const looksLikeLink = (s: string) => /^(https?:\/\/|www\.)/i.test(s.trim());

/** Link zur Kartenansicht – funktioniert ohne API-Schlüssel */
export const mapsSearchUrl = (location: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.trim())}`;

/**
 * Feld „Ort“ mit Ortssuche über Google Places (Unternehmen, Sehenswürdigkeiten, Adressen).
 * Ohne eingerichteten Places-Schlüssel ein normales Textfeld. Freitext bleibt immer möglich.
 */
export function LocationInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const enabled = useFeature('places');
  const [typed, setTyped] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [resolving, setResolving] = useState(false);
  const session = useRef(newSession());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(typed ? value.trim() : ''), 300);
    return () => clearTimeout(t);
  }, [value, typed]);

  const queryOn = enabled && debounced.length >= 3 && !looksLikeLink(debounced);
  const { data: suggestions = [], isFetching, error } = useQuery({
    queryKey: ['calendar', 'places', debounced],
    queryFn: ({ signal }) => api<PlaceSuggestion[]>('/calendar/places', { query: { q: debounced, session: session.current }, signal }),
    enabled: queryOn,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const open = focused && queryOn && typed && (suggestions.length > 0 || !!error);

  const pick = async (s: PlaceSuggestion) => {
    const quick = s.secondary ? `${s.main}, ${s.secondary}` : s.main;
    setTyped(false);
    setActive(0);
    onChange(quick);
    const token = session.current;
    session.current = newSession();
    setResolving(true);
    try {
      const d = await api<PlaceDetails>(`/calendar/places/${encodeURIComponent(s.placeId)}`, {
        query: { name: s.poi ? s.main : undefined, session: token },
      });
      if (d.location) onChange(d.location);
    } catch {
      /* Vorschlagstext bleibt stehen */
    } finally {
      setResolving(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, suggestions.length - 1) : Math.max(a - 1, 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = suggestions[active];
      if (s) void pick(s);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setTyped(false);
    }
  };

  const showMapLink = !!value.trim() && !looksLikeLink(value);

  return (
    <div className="relative">
      <Input
        value={value}
        placeholder={placeholder ?? (enabled ? 'Ort, Adresse oder Firma suchen – oder Link' : 'Raum, Adresse oder Link')}
        autoComplete="off"
        className={cn(showMapLink && 'pr-9')}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setActive(0);
        }}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {(resolving || (isFetching && typed)) && <Loader2 className={cn('absolute top-2.5 h-4 w-4 animate-spin text-muted', showMapLink ? 'right-9' : 'right-2.5')} />}
      {showMapLink && (
        <a
          href={mapsSearchUrl(value)}
          target="_blank"
          rel="noopener noreferrer"
          title="In Google Maps anzeigen"
          className="absolute right-1.5 top-1.5 rounded p-1 text-muted hover:bg-hover hover:text-primary"
        >
          <MapPin className="h-4 w-4" />
        </a>
      )}
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl">
          {error ? (
            <div className="px-3 py-2 text-xs text-danger">{errorMessage(error)}</div>
          ) : (
            suggestions.map((s, i) => {
              const Icon = s.poi ? Building2 : MapPin;
              return (
                <button
                  key={s.placeId}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void pick(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn('flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm', i === active && 'bg-hover')}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.main}</span>
                    {s.secondary && <span className="block truncate text-xs text-muted">{s.secondary}</span>}
                  </span>
                </button>
              );
            })
          )}
          {/* Attribution laut Google-Maps-Platform-Richtlinie: „Google Maps“, unübersetzt */}
          <div className="border-t border-border px-3 pt-1 text-right text-xs text-muted" translate="no" style={{ fontFamily: 'Roboto, Arial, sans-serif' }}>
            Google Maps
          </div>
        </div>
      )}
    </div>
  );
}
