/**
 * Kleiner Zeitstrahl eines Tages im Kopf der Tagesliste: zeigt, wann etwas erfasst ist (gebucht = grün,
 * offen = gelb, läuft = blau) und wo Lücken sind (schraffiert). Klick auf einen Eintrag öffnet ihn,
 * Klick auf eine Lücke legt dafür einen neuen Eintrag an.
 */
import { useMemo, type CSSProperties } from 'react';
import { format, isToday } from 'date-fns';
import type { TtEntry } from '@kuvert/shared';
import { cn } from '@/lib/utils';
import { formatDuration, useNow } from './api';
import { useQuickTags } from './EntryTags';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Kürzere Lücken (z. B. durch Rundung) nicht anzeigen */
const MIN_GAP = 5 * MIN;

const hhmm = (t: number) => format(t, 'HH:mm');
const lc = (s: string) => s.toLowerCase();

type Seg = { e: TtEntry; from: number; to: number; state: 'done' | 'open' | 'running' };
type Gap = { from: number; to: number; open?: boolean };

const STATE_CLASS: Record<Seg['state'], string> = {
  done: 'bg-success',
  open: 'bg-warning',
  running: 'bg-primary animate-pulse',
};

const HATCH = {
  backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-danger) 45%, transparent) 0 2px, transparent 2px 5px)',
};

export function DayTimeline({
  day,
  list,
  compact,
  onSelect,
  onFillGap,
}: {
  /** yyyy-MM-dd (lokal) */
  day: string;
  list: TtEntry[];
  compact?: boolean;
  onSelect?: (e: TtEntry) => void;
  onFillGap?: (begin: Date, durationSec: number) => void;
}) {
  const doneTag = useQuickTags()[0];
  const dayStart = useMemo(() => new Date(`${day}T00:00:00`).getTime(), [day]);
  const today = isToday(dayStart);
  const now = useNow(today);

  const { segs, gaps, from, to, sums } = useMemo(() => {
    const dayEnd = dayStart + 24 * HOUR;
    const segs: Seg[] = list
      .map((e): Seg => {
        const running = !e.end;
        const end = running ? now : Date.parse(e.end!);
        const done = !!doneTag && e.tags.some((t) => lc(t) === lc(doneTag));
        return { e, from: Math.max(dayStart, Date.parse(e.begin)), to: Math.min(dayEnd, end), state: running ? 'running' : done ? 'done' : 'open' };
      })
      .filter((s) => s.to > s.from)
      .sort((a, b) => a.from - b.from);

    // Lücken zwischen den (zusammengefassten) erfassten Zeiten; heute auch vom letzten Ende bis jetzt
    const gaps: Gap[] = [];
    let cursor = segs[0]?.from ?? 0;
    for (const s of segs) {
      if (s.from - cursor >= MIN_GAP) gaps.push({ from: cursor, to: s.from });
      cursor = Math.max(cursor, s.to);
    }
    if (today && segs.length && !segs.some((s) => s.state === 'running') && now - cursor >= MIN_GAP) gaps.push({ from: cursor, to: now, open: true });

    const sums = { done: 0, open: 0, running: 0, gaps: 0 };
    for (const s of segs) sums[s.state] += (s.to - s.from) / 1000;
    for (const g of gaps) sums.gaps += (g.to - g.from) / 1000;

    // Sichtbarer Bereich: mindestens 8–18 Uhr, sonst auf volle Stunden um alle Einträge (und jetzt)
    const first = Math.min(segs[0]?.from ?? Infinity, today ? now : Infinity);
    const last = Math.max(...segs.map((s) => s.to), today ? now : -Infinity);
    const floorH = (t: number) => dayStart + Math.floor((t - dayStart) / HOUR) * HOUR;
    const ceilH = (t: number) => dayStart + Math.ceil((t - dayStart) / HOUR) * HOUR;
    const from = Math.max(dayStart, Math.min(dayStart + 8 * HOUR, floorH(first)));
    const to = Math.min(dayEnd, Math.max(dayStart + 18 * HOUR, ceilH(last)));
    return { segs, gaps, from, to, sums };
  }, [list, dayStart, today, now, doneTag]);

  if (!segs.length) return null;

  const span = to - from;
  const pct = (t: number) => `${((t - from) / span) * 100}%`;
  const width = (a: number, b: number) => `max(2px, ${((b - a) / span) * 100}%)`;
  const hours = Math.round(span / HOUR);
  const step = compact ? (hours > 8 ? 3 : 2) : hours > 14 ? 2 : 1;
  const ticks: number[] = [];
  for (let t = from; t <= to; t += step * HOUR) ticks.push(t);

  return (
    <div className={cn('select-none', compact ? 'px-1 pb-2' : 'px-4 pb-2 pt-0.5')}>
      <div className="relative h-3 rounded-full bg-surface-2">
        {gaps.map((g) => (
          <button
            key={`g${g.from}`}
            type="button"
            className={cn('absolute inset-y-0 rounded-sm ring-1 ring-inset ring-danger/30 transition hover:ring-danger/70', !onFillGap && 'cursor-default')}
            style={{ left: pct(g.from), width: width(g.from, g.to), ...HATCH }}
            title={`Lücke ${hhmm(g.from)}–${g.open ? 'jetzt' : hhmm(g.to)} (${formatDuration((g.to - g.from) / 1000)} h)${onFillGap ? ' – klicken zum Nachtragen' : ''}`}
            onClick={() => onFillGap?.(new Date(g.from), Math.round((g.to - g.from) / 1000))}
          />
        ))}
        {segs.map((s) => (
          <button
            key={s.e.id}
            type="button"
            className={cn('absolute inset-y-0 rounded-sm opacity-90 ring-1 ring-surface transition hover:opacity-100 hover:ring-fg/40', STATE_CLASS[s.state], !onSelect && 'cursor-default')}
            style={{ left: pct(s.from), width: width(s.from, s.to) }}
            title={[
              `${hhmm(s.from)}–${s.state === 'running' ? 'läuft' : hhmm(s.to)}`,
              [s.e.customerName, s.e.projectName].filter(Boolean).join(' › '),
              s.e.description,
              s.state === 'done' ? doneTag : s.state === 'open' ? 'offen' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            onClick={() => onSelect?.(s.e)}
          />
        ))}
        {today && now > from && now < to && (
          <span className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-fg/70" style={{ left: pct(now) }} title={`Jetzt ${hhmm(now)}`} />
        )}
      </div>

      <div className="relative mt-0.5 h-3.5 text-[10px] tabular-nums text-muted">
        {ticks.map((t, i) => (
          <span
            key={t}
            className={cn('absolute top-0', i === 0 ? '' : t >= to ? '-translate-x-full' : '-translate-x-1/2')}
            style={{ left: pct(t) }}
          >
            {format(t, 'H')}
          </span>
        ))}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
        {sums.done > 0 && <Legend className="bg-success" label={doneTag ?? 'gebucht'} sec={sums.done} />}
        {sums.open > 0 && <Legend className="bg-warning" label="offen" sec={sums.open} strong />}
        {sums.running > 0 && <Legend className="bg-primary" label="läuft" sec={sums.running} />}
        {sums.gaps > 0 && <Legend style={HATCH} className="ring-1 ring-inset ring-danger/40" label="Lücken" sec={sums.gaps} />}
      </div>
    </div>
  );
}

function Legend({ className, style, label, sec, strong }: { className?: string; style?: CSSProperties; label: string; sec: number; strong?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-block h-2 w-2 rounded-sm', className)} style={style} />
      <span className={cn(strong && 'text-fg')}>{label}</span>
      <span className="font-mono tabular-nums">{formatDuration(sec)}</span>
    </span>
  );
}
