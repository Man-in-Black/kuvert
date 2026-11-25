import { useEffect, useMemo, useState } from 'react';
import { addDays, addMonths, endOfMonth, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Kleiner Monatsnavigator für die Seitenleiste. */
export function MiniMonth({
  date,
  rangeStart,
  rangeEnd,
  weekStartsOn,
  onPick,
}: {
  date: Date;
  rangeStart?: Date;
  rangeEnd?: Date;
  weekStartsOn: 0 | 1;
  onPick: (d: Date) => void;
}) {
  const [month, setMonth] = useState(() => startOfMonth(date));
  useEffect(() => setMonth(startOfMonth(date)), [date.getFullYear(), date.getMonth()]);

  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(month), { weekStartsOn });
    const last = endOfMonth(month);
    const out: Date[] = [];
    for (let d = first; out.length < 42 && (d <= last || out.length % 7 !== 0); d = addDays(d, 1)) out.push(d);
    return out;
  }, [month, weekStartsOn]);

  const weekdays = useMemo(() => {
    const first = startOfWeek(new Date(), { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => format(addDays(first, i), 'EEEEEE', { locale: de }));
  }, [weekStartsOn]);

  const today = new Date();
  const inRange = (d: Date) => rangeStart && rangeEnd && d >= rangeStart && d < rangeEnd;

  return (
    <div className="select-none px-3 pb-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold capitalize">{format(month, 'MMMM yyyy', { locale: de })}</span>
        <div className="flex">
          <IconButton label="Vorheriger Monat" size="icon-sm" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton label="Nächster Monat" size="icon-sm" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase text-muted">
        {weekdays.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
        {days.map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            onClick={() => onPick(d)}
            className={cn(
              'mx-auto flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-hover',
              !isSameMonth(d, month) && 'text-muted/60',
              inRange(d) && 'bg-primary-soft text-primary',
              isSameDay(d, today) && 'bg-primary font-semibold text-primary-fg hover:bg-primary',
            )}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}
