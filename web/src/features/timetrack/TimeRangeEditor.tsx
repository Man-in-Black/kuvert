/**
 * Zeitbereich im Bearbeiten-Dialog: Datum, Von/Bis/Dauer (jeweils mit −15/+15),
 * Tageszeitleiste mit ziehbaren Griffen für Beginn und Ende, Schnellknöpfe
 * (−15 min … +1 h), Dauer-Vorgaben, „Ende = jetzt“ und Runden auf ¼ Stunde.
 *
 * Regeln: Beginn ändern lässt das Ende stehen (Dauer passt sich an), Ende oder Dauer
 * ändern verschiebt nur das Ende. Ein Ende vor dem Beginn gilt als „über Mitternacht“.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { addDays, format, isToday, isYesterday, startOfDay } from 'date-fns';
import { Clock, Minus, Plus } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatDuration, useNow } from './api';

const MIN = 60;
const DAY_MIN = 24 * 60;
const MAX_SEC = 7 * 24 * 3600;
const STEP = 15;

const PRESETS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];

/** „1:30“, „1,5“, „1.5h“, „90m“, „1h 30m“, „2“ (Stunden) → Sekunden; null = unverständlich */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(',', '.').replace(/\s+/g, ' ');
  if (!s) return null;
  let minutes: number | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,3}):(\d{1,2})$/))) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = s.match(/^(?:(\d+(?:\.\d+)?) ?(?:h|std|stunden?))? ?(?:(\d+) ?(?:m|min|minuten?))?$/)) && (m[1] || m[2])) minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  else if ((m = s.match(/^\d+(?:\.\d+)?$/))) minutes = Number(s) * 60;
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const sec = Math.round(minutes) * MIN;
  return sec > 0 && sec <= MAX_SEC ? sec : null;
}

const presetLabel = (min: number) => (min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h` : `${min / 60} h`);

/** Minuten seit Tagesbeginn */
const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

function withTime(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
}

export interface TimeRangeValue {
  begin: Date;
  /** Sekunden; null = Timer läuft */
  duration: number | null;
}

export function TimeRangeEditor({ value, onChange }: { value: TimeRangeValue; onChange: (v: TimeRangeValue) => void }) {
  const running = value.duration == null;
  const now = useNow(running);
  const { begin } = value;
  const duration = value.duration ?? Math.max(0, Math.floor((now - begin.getTime()) / 1000));
  const end = new Date(begin.getTime() + duration * 1000);
  const nextDay = !running && startOfDay(end).getTime() !== startOfDay(begin).getTime();

  const setDuration = (sec: number) => onChange({ begin, duration: Math.min(MAX_SEC, Math.max(MIN, Math.round(sec / MIN) * MIN)) });
  /** Beginn verschieben, Ende bleibt (beim laufenden Timer läuft die Zeit weiter) */
  const setBegin = (b: Date) => {
    if (running) {
      onChange({ begin: new Date(Math.min(b.getTime(), Date.now())), duration: null });
      return;
    }
    let d = Math.round((end.getTime() - b.getTime()) / 1000);
    if (d < MIN) d = MIN; // Beginn über das Ende hinaus: Mindestdauer
    onChange({ begin: b, duration: Math.min(MAX_SEC, d) });
  };
  /** Ende auf Uhrzeit setzen; vor dem Beginn = am Folgetag */
  const setEndMinute = (minutes: number) => {
    let e = withTime(begin, minutes);
    if (e.getTime() <= begin.getTime()) e = addDays(e, 1);
    setDuration((e.getTime() - begin.getTime()) / 1000);
  };

  const setDate = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
    const d = new Date(`${s}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    onChange({ begin: withTime(d, minuteOfDay(begin)), duration: value.duration });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
      {/* Datum */}
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={format(begin, 'yyyy-MM-dd')} onChange={(e) => setDate(e.target.value)} className="w-40" aria-label="Datum" required />
        {!running && (
          <>
            <Chip active={isToday(begin)} onClick={() => setDate(format(new Date(), 'yyyy-MM-dd'))}>
              Heute
            </Chip>
            <Chip active={isYesterday(begin)} onClick={() => setDate(format(addDays(new Date(), -1), 'yyyy-MM-dd'))}>
              Gestern
            </Chip>
          </>
        )}
      </div>

      {/* Von / Bis / Dauer */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Labeled label="Von">
          <TimeField value={format(begin, 'HH:mm')} onChange={(m) => setBegin(withTime(begin, m))} onNudge={(d) => setBegin(new Date(begin.getTime() + d * 60_000))} />
        </Labeled>
        <Labeled label={nextDay ? 'Bis (Folgetag)' : 'Bis'}>
          {running ? (
            <Input value="läuft" disabled className="text-center" />
          ) : (
            <TimeField value={format(end, 'HH:mm')} onChange={setEndMinute} onNudge={(d) => setDuration(duration + d * MIN)} />
          )}
        </Labeled>
        <Labeled label="Dauer">
          {running ? (
            <Input value={`${formatDuration(duration)} h`} disabled className="text-center font-mono tabular-nums" />
          ) : (
            <DurationField seconds={duration} onChange={setDuration} />
          )}
        </Labeled>
      </div>

      {/* Zeitleiste */}
      <Timeline begin={begin} end={running ? new Date(now) : end} running={running} onBegin={setBegin} onEnd={setEndMinute} />

      {/* Schnellknöpfe */}
      {running ? (
        <p className="text-xs text-muted">Der Timer läuft – Beginn mit den Knöpfen oder dem linken Griff anpassen.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {[-15, 15, 30, 60].map((d) => (
            <Chip key={d} onClick={() => setDuration(duration + d * MIN)} disabled={d < 0 && duration <= MIN}>
              {d < 0 ? `−${-d} min` : d < 60 ? `+${d} min` : `+${d / 60} h`}
            </Chip>
          ))}
          <Select
            value=""
            onChange={(e) => e.target.value && setDuration(Number(e.target.value) * MIN)}
            className="h-7 w-auto rounded-full py-0 pl-3 text-xs"
            aria-label="Dauer wählen"
          >
            <option value="">Dauer wählen …</option>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {presetLabel(p)}
              </option>
            ))}
          </Select>
          {begin.getTime() < Date.now() - MIN * 1000 && Date.now() - begin.getTime() <= MAX_SEC * 1000 && (
            <Chip onClick={() => setDuration((Date.now() - begin.getTime()) / 1000)} title="Ende auf die aktuelle Uhrzeit setzen">
              <Clock className="h-3 w-3" />
              Ende = jetzt
            </Chip>
          )}
          {(minuteOfDay(begin) % STEP !== 0 || (duration / MIN) % STEP !== 0) && (
            <Chip
              onClick={() => {
                const b = withTime(begin, Math.round(minuteOfDay(begin) / STEP) * STEP);
                const d = Math.max(STEP, Math.round(duration / MIN / STEP) * STEP) * MIN;
                onChange({ begin: b, duration: d });
              }}
              title="Beginn und Dauer auf Viertelstunden runden"
            >
              Auf ¼ h runden
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Bausteine ───────────────────────────── */

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg/80">{label}</span>
      {children}
    </div>
  );
}

function Chip({ children, onClick, active, disabled, title }: { children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs font-medium tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-40',
        active ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface hover:border-border-strong hover:bg-hover',
      )}
    >
      {children}
    </button>
  );
}

function NudgeButton({ delta, onClick }: { delta: number; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      className="h-9 shrink-0 gap-0.5 px-2 tabular-nums"
      title={`${delta < 0 ? '−' : '+'}${Math.abs(delta)} Minuten`}
      aria-label={`${delta < 0 ? 'minus' : 'plus'} ${Math.abs(delta)} Minuten`}
    >
      {delta < 0 ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
      {Math.abs(delta)}
    </Button>
  );
}

/** Uhrzeit mit −15/+15 daneben; onChange liefert Minuten seit Tagesbeginn */
function TimeField({ value, onChange, onNudge }: { value: string; onChange: (minutes: number) => void; onNudge: (deltaMinutes: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <NudgeButton delta={-STEP} onClick={() => onNudge(-STEP)} />
      <Input
        type="time"
        value={value}
        onChange={(e) => {
          const m = e.target.value.match(/^(\d{1,2}):(\d{2})/);
          if (m) onChange(Number(m[1]) * 60 + Number(m[2]));
        }}
        className="min-w-0 flex-1 px-1.5 text-center tabular-nums"
        required
      />
      <NudgeButton delta={STEP} onClick={() => onNudge(STEP)} />
    </div>
  );
}

/** Dauer frei eintippen (übernommen bei Enter/Verlassen) mit −15/+15 */
function DurationField({ seconds, onChange }: { seconds: number; onChange: (sec: number) => void }) {
  const [text, setText] = useState(formatDuration(seconds));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(formatDuration(seconds));
  }, [seconds, focused]);
  const parsed = parseDuration(text);
  const commit = () => {
    if (parsed != null) onChange(parsed);
    else setText(formatDuration(seconds));
  };
  return (
    <div className="flex items-center gap-1">
      <NudgeButton delta={-STEP} onClick={() => onChange(seconds - STEP * MIN)} />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className={cn('min-w-0 flex-1 px-1.5 text-center font-mono tabular-nums', focused && text.trim() && parsed == null && 'border-danger focus:border-danger')}
        title="z. B. 1:30, 1,5 oder 90m"
        aria-label="Dauer"
        inputMode="decimal"
      />
      <NudgeButton delta={STEP} onClick={() => onChange(seconds + STEP * MIN)} />
    </div>
  );
}

/**
 * Tag als Leiste (0–24 Uhr) mit zwei Griffen (5-Minuten-Raster). Endet der Eintrag am Folgetag,
 * steht der rechte Griff am Tagesende und lässt sich nur zurückziehen.
 */
function Timeline({ begin, end, running, onBegin, onEnd }: { begin: Date; end: Date; running: boolean; onBegin: (d: Date) => void; onEnd: (minutes: number) => void }) {
  const b = minuteOfDay(begin);
  const e = startOfDay(end).getTime() === startOfDay(begin).getTime() ? minuteOfDay(end) : DAY_MIN;
  const pct = (m: number) => `${(m / DAY_MIN) * 100}%`;
  const nowM = isToday(begin) ? minuteOfDay(new Date()) : null;
  const thumb =
    'pointer-events-none absolute inset-x-0 top-0 h-8 w-full appearance-none bg-transparent focus:outline-none ' +
    '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-md [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow ' +
    '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:cursor-ew-resize [&::-moz-range-thumb]:rounded-md [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-surface ' +
    'focus-visible:[&::-webkit-slider-thumb]:shadow-glow';
  return (
    <div className="select-none">
      <div className="relative h-8">
        {/* Leiste mit Stundenmarken */}
        <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full bg-surface-3">
          {[6, 12, 18].map((h) => (
            <span key={h} className="absolute top-0 h-full w-px bg-border-strong/60" style={{ left: pct(h * 60) }} />
          ))}
          <span className={cn('absolute top-0 h-full rounded-full', running ? 'bg-primary/40' : 'bg-primary/70')} style={{ left: pct(b), width: pct(Math.max(0, e - b)) }} />
          {nowM != null && <span className="absolute -top-1 h-5 w-0.5 rounded bg-danger/70" style={{ left: pct(nowM) }} title="Jetzt" />}
        </div>
        <input
          type="range"
          min={0}
          max={DAY_MIN - 5}
          step={5}
          value={b}
          onChange={(ev) => {
            const m = Number(ev.target.value);
            if (!running && m >= e && e < DAY_MIN) return; // nicht über das Ende ziehen
            onBegin(withTime(begin, m));
          }}
          className={cn(thumb, b > DAY_MIN * 0.9 ? 'z-20' : 'z-10')}
          aria-label="Beginn"
        />
        {!running && (
          <input
            type="range"
            min={5}
            max={DAY_MIN}
            step={5}
            value={e}
            onChange={(ev) => {
              const m = Number(ev.target.value);
              if (m <= b) return;
              onEnd(m >= DAY_MIN ? DAY_MIN - 1 : m);
            }}
            className={cn(thumb, 'z-10')}
            aria-label="Ende"
          />
        )}
      </div>
      <div className="relative h-4 text-[10px] tabular-nums text-muted">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className={cn('absolute', h === 0 ? 'left-0' : h === 24 ? 'right-0' : '-translate-x-1/2')} style={h > 0 && h < 24 ? { left: pct(h * 60) } : undefined}>
            {h}:00
          </span>
        ))}
      </div>
    </div>
  );
}
