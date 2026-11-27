/**
 * Zeitbereich im Bearbeiten-Dialog: Datum, Von/Bis/Dauer (jeweils mit −15/+15; Uhrzeitauswahl
 * im 5-Minuten-Raster), Tageszeitleiste mit ziehbaren Griffen für Beginn und Ende (15-Minuten-
 * Schritte), Schnellknöpfe (−15 min … +1 h), Dauer-Vorgaben, „Ende = jetzt“ und Runden auf ¼ Stunde.
 *
 * Regeln: Beginn ändern lässt das Ende stehen (Dauer passt sich an), Ende oder Dauer
 * ändern verschiebt nur das Ende. Ein Ende vor dem Beginn gilt als „über Mitternacht“.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { addDays, format, isToday, isYesterday, startOfDay } from 'date-fns';
import { Clock, Minus, Plus } from 'lucide-react';
import { Input, Select } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatDuration, roundUpSeconds, useNow, useTtSettings } from './api';

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
  const roundUp = useTtSettings().data?.roundUp ?? 15;
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
          <TimeField label="Beginn" value={format(begin, 'HH:mm')} onChange={(m) => setBegin(withTime(begin, m))} onNudge={(d) => setBegin(new Date(begin.getTime() + d * 60_000))} />
        </Labeled>
        <Labeled label={nextDay ? 'Bis (Folgetag)' : 'Bis'}>
          {running ? (
            <Input value="läuft" disabled className="h-10 text-center" />
          ) : (
            <TimeField label="Ende" value={format(end, 'HH:mm')} onChange={setEndMinute} onNudge={(d) => setDuration(duration + d * MIN)} />
          )}
        </Labeled>
        <Labeled label="Dauer">
          {running ? (
            <Input value={`${formatDuration(duration)} h`} disabled className="h-10 text-center font-mono tabular-nums" />
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
          {!roundUp && (minuteOfDay(begin) % STEP !== 0 || (duration / MIN) % STEP !== 0) && (
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
      {!running && roundUp > 0 && roundUpSeconds(duration, roundUp) !== duration && (
        <p className="text-xs text-muted">
          Gespeichert wird <span className="font-medium text-fg">{formatDuration(roundUpSeconds(duration, roundUp))} h</span> – aufgerundet auf volle {roundUp} Minuten
          (einstellbar unter Einstellungen → Zeiterfassung).
        </p>
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

/** Eingabe mit −/+ (je 15 min) links und rechts im selben Rahmen */
function Stepper({ onMinus, onPlus, minusDisabled, invalid, children }: { onMinus: () => void; onPlus: () => void; minusDisabled?: boolean; invalid?: boolean; children: ReactNode }) {
  const btn =
    'flex w-8 shrink-0 items-center justify-center text-muted transition-colors hover:bg-hover hover:text-fg active:bg-primary-soft disabled:pointer-events-none disabled:opacity-40';
  return (
    <div
      className={cn(
        'flex h-10 items-stretch overflow-hidden rounded-lg border bg-input transition-[border-color,box-shadow] focus-within:shadow-glow',
        invalid ? 'border-danger' : 'border-input-border focus-within:border-primary hover:border-border-strong',
      )}
    >
      <button type="button" className={cn(btn, 'border-r border-border')} onClick={onMinus} disabled={minusDisabled} title={`${STEP} Minuten weniger`} aria-label={`${STEP} Minuten weniger`}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      {children}
      <button type="button" className={cn(btn, 'border-l border-border')} onClick={onPlus} title={`${STEP} Minuten mehr`} aria-label={`${STEP} Minuten mehr`}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const innerInput =
  'min-w-0 flex-1 bg-transparent px-1 text-center font-mono text-[15px] font-medium tabular-nums text-fg focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:mx-auto';

/** Raster der Uhrzeitauswahl (Minuten) */
const PICK_STEP = 5;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MINUTES = Array.from({ length: 60 / PICK_STEP }, (_, i) => i * PICK_STEP);
const pad = (n: number) => String(n).padStart(2, '0');

/** „9“, „930“, „0930“, „9:30“, „9.30“ → Minuten seit Tagesbeginn, auf 5 min gerundet; null = ungültig */
function parseTime(input: string): number | null {
  const s = input.trim().replace(/[.,h]/g, ':');
  let h: number;
  let m: number;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{1,2}):(\d{1,2})$/))) [h, m] = [Number(r[1]), Number(r[2])];
  else if ((r = s.match(/^(\d{1,2})(\d{2})$/))) [h, m] = [Number(r[1]), Number(r[2])];
  else if ((r = s.match(/^(\d{1,2})$/))) [h, m] = [Number(r[1]), 0];
  else return null;
  if (h > 23 || m > 59) return null;
  return Math.min(DAY_MIN - PICK_STEP, Math.round((h * 60 + m) / PICK_STEP) * PICK_STEP);
}

/**
 * Uhrzeit mit −/+ 15 min. Klick öffnet eine Auswahl mit Stunden und Minuten im 5-Minuten-Raster;
 * Eintippen geht auch (wird auf 5 min gerundet). onChange liefert Minuten seit Tagesbeginn.
 */
function TimeField({ value, onChange, onNudge, label }: { value: string; onChange: (minutes: number) => void; onNudge: (deltaMinutes: number) => void; label: string }) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hourListRef = useRef<HTMLDivElement>(null);
  useEffect(() => setText(value), [value]);

  const [h, rawM] = value.split(':').map(Number) as [number, number];
  /** Minute im 5-Minuten-Raster (für die Auswahl; z. B. importierte 12:03 → 05) */
  const m = Math.min(55, Math.round(rawM / PICK_STEP) * PICK_STEP);
  const current = h * 60 + rawM;

  const commit = () => {
    const v = parseTime(text);
    if (v != null && v !== current) onChange(v);
    else setText(value);
  };
  const close = () => {
    setOpen(false);
    commit();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = inputRef.current?.parentElement?.getBoundingClientRect();
      if (!r) return;
      const width = 236;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom;
      setPos(below < 260 && r.top > below ? { left, width, bottom: window.innerHeight - r.top + 4 } : { left, width, top: r.bottom + 4 });
    };
    place();
    hourListRef.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: 'center' });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !inputRef.current?.parentElement?.contains(t)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  const cell = (on: boolean) =>
    cn('h-7 shrink-0 rounded-md text-sm tabular-nums transition-colors', on ? 'bg-primary font-semibold text-primary-fg' : 'hover:bg-hover');

  return (
    <Stepper onMinus={() => onNudge(-STEP)} onPlus={() => onNudge(STEP)}>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={(e) => {
          // Klick in die Auswahl: offen lassen
          if (popRef.current?.contains(e.relatedTarget as Node)) return;
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            close();
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation(); // nicht gleich den Dialog schließen
            setText(value);
            setOpen(false);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onNudge(e.key === 'ArrowUp' ? PICK_STEP : -PICK_STEP);
          }
        }}
        className={innerInput}
        aria-label={label}
        inputMode="numeric"
        autoComplete="off"
        title="Uhrzeit, z. B. 9:30 oder 0930 – Pfeiltasten: ±5 min"
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-[70] animate-scale-in rounded-xl border border-border bg-surface p-2 shadow-pop"
            style={pos}
            onMouseDown={(e) => e.preventDefault() /* Fokus im Feld lassen */}
          >
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <div>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Stunde</div>
                <div ref={hourListRef} className="grid max-h-52 grid-cols-3 gap-0.5 overflow-y-auto pr-0.5">
                  {HOURS.map((hh) => (
                    <button key={hh} type="button" data-on={hh === h ? '1' : undefined} className={cell(hh === h)} onClick={() => onChange(hh * 60 + m)}>
                      {pad(hh)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Minute</div>
                <div className="grid grid-cols-3 gap-0.5">
                  {MINUTES.map((mm) => (
                    <button
                      key={mm}
                      type="button"
                      className={cell(mm === m)}
                      onClick={() => {
                        onChange(h * 60 + mm);
                        setOpen(false);
                        inputRef.current?.blur();
                      }}
                    >
                      {pad(mm)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Stepper>
  );
}

/** Dauer frei eintippen (übernommen bei Enter/Verlassen) mit −/+ 15 min */
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
    <Stepper onMinus={() => onChange(seconds - STEP * MIN)} onPlus={() => onChange(seconds + STEP * MIN)} minusDisabled={seconds <= MIN} invalid={focused && !!text.trim() && parsed == null}>
      <input
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
        className={innerInput}
        title="z. B. 1:30, 1,5 oder 90m"
        aria-label="Dauer"
        inputMode="decimal"
        autoComplete="off"
      />
    </Stepper>
  );
}

/**
 * Tag als Leiste (0–24 Uhr) mit zwei Griffen (15-Minuten-Schritte). Endet der Eintrag am Folgetag,
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
          max={DAY_MIN - STEP}
          step={STEP}
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
            min={STEP}
            max={DAY_MIN}
            step={STEP}
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
