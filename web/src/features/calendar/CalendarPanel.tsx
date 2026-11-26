/**
 * Kalender als Seitenleiste (wie der KI-Chat): Monatsnavigator und die Termine der
 * nächsten sieben Tage ab dem gewählten Tag. Anpinnbar – dann bleibt Mail daneben bedienbar.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDays, format, isSameDay, isToday, isTomorrow, startOfDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarDays, ChevronLeft, ChevronRight, Maximize2, MapPin, Plus, Repeat, Video, X } from 'lucide-react';
import type { CalendarEvent } from '@kuvert/shared';
import { Button, IconButton, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { PinPanelButton, SidePanel, isPanelPinned } from '@/layout/SidePanel';
import { calKey, calKeyOf, useCalendars, useEvents } from './api';
import { EventDetails } from './EventDetails';
import { EventEditor, type EditorInit } from './EventEditor';
import { MiniMonth } from './MiniMonth';
import { isRecurring } from './series';
import { CALENDAR_PANEL_ID, closeCalendarPanel } from './panel-store';
import { eventColor, meetingLabel, parseEventDate } from './utils';
import { HIDDEN_KEY, usePersistentSet } from './visibility';

const DAYS = 7;

interface DayGroup {
  day: Date;
  events: CalendarEvent[];
}

function dayHeading(d: Date): string {
  const long = format(d, 'EEEE, d. MMMM', { locale: de });
  if (isToday(d)) return `Heute · ${long}`;
  if (isTomorrow(d)) return `Morgen · ${long}`;
  return long;
}

/** Termine je Tag (mehrtägige an jedem ihrer Tage), ganztägige zuerst, sonst nach Beginn */
function groupByDay(events: CalendarEvent[], from: Date): DayGroup[] {
  const groups: DayGroup[] = Array.from({ length: DAYS }, (_, i) => ({ day: addDays(from, i), events: [] }));
  for (const ev of events) {
    const start = parseEventDate(ev.start);
    const end = parseEventDate(ev.end);
    for (const g of groups) {
      const dayEnd = addDays(g.day, 1);
      // Ende exklusiv; Termine ohne Dauer zählen am Starttag
      if (start < dayEnd && (end > g.day || (+end === +start && start >= g.day))) g.events.push(ev);
    }
  }
  for (const g of groups) {
    g.events.sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || parseEventDate(a.start).getTime() - parseEventDate(b.start).getTime());
  }
  return groups;
}

export default function CalendarPanel() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const { settings } = useSettings();
  const accountMap = useAccountMap();
  const { data: calData, isLoading: calLoading } = useCalendars();
  const calendars = useMemo(() => calData?.calendars ?? [], [calData]);
  const calendarMap = useMemo(() => new Map(calendars.map((c) => [calKeyOf(c), c])), [calendars]);
  const [hidden] = usePersistentSet(HIDDEN_KEY);
  const visible = useMemo(() => calendars.filter((c) => !hidden.has(calKeyOf(c))), [calendars, hidden]);
  const visibleRefs = useMemo(() => visible.map((c) => ({ accountId: c.accountId, calendarId: c.id })), [visible]);

  const [day, setDay] = useState(() => startOfDay(new Date()));
  const range = useMemo(() => ({ start: day.toISOString(), end: addDays(day, DAYS).toISOString() }), [day]);
  const { data: evData, isFetching, error: evError } = useEvents(range, visibleRefs);
  const groups = useMemo(() => groupByDay(evData?.events ?? [], day), [evData, day]);
  const hasEvents = groups.some((g) => g.events.length > 0);

  const [detail, setDetail] = useState<CalendarEvent | null>(null);
  const [editor, setEditor] = useState<EditorInit | null>(null);

  // Vergangene Termine abblenden – einmal pro Minute neu bewerten
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const writableDefault = useMemo(() => {
    const w = visible.filter((c) => !c.readOnly);
    const pick = w.find((c) => c.isDefault) ?? w[0] ?? calendars.find((c) => !c.readOnly);
    return pick ? calKeyOf(pick) : '';
  }, [visible, calendars]);

  const noCalendars = !calLoading && calendars.length === 0;

  const openFull = () => {
    navigate('/calendar');
    if (mobile || !isPanelPinned(CALENDAR_PANEL_ID)) closeCalendarPanel();
  };

  const newEvent = () => {
    setDetail(null);
    // Gewählter Tag (nicht heute): Termin dort um 9 Uhr vorschlagen
    const start = isToday(day) ? undefined : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
    setEditor(start ? { calendarKey: writableDefault, start, end: new Date(start.getTime() + 3_600_000), allDay: false } : { calendarKey: writableDefault });
  };

  return (
    <SidePanel id={CALENDAR_PANEL_ID} label="Kalender" defaultWidth={360} onClose={closeCalendarPanel} canClose={!detail && !editor}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <CalendarDays className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 text-sm font-semibold">Kalender</div>
        {isFetching && <Spinner className="h-4 w-4 shrink-0" />}
        <HeaderButton label="Neuer Termin" onClick={newEvent} disabled={noCalendars}>
          <Plus className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton label="Im Kalender öffnen" onClick={openFull}>
          <Maximize2 className="h-4 w-4" />
        </HeaderButton>
        <PinPanelButton id={CALENDAR_PANEL_ID} />
        <HeaderButton label="Schließen" onClick={closeCalendarPanel}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </header>

      <div className="shrink-0 border-b border-border pt-2">
        <MiniMonth date={day} rangeStart={day} rangeEnd={addDays(day, 1)} weekStartsOn={settings.weekStartsOn} onPick={(d) => setDay(startOfDay(d))} />
      </div>

      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <Button size="sm" onClick={() => setDay(startOfDay(new Date()))} disabled={isToday(day)}>
          Heute
        </Button>
        <IconButton label="Vorheriger Tag" size="icon-sm" onClick={() => setDay((d) => addDays(d, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton label="Nächster Tag" size="icon-sm" onClick={() => setDay((d) => addDays(d, 1))}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <span className="ml-1 truncate text-xs text-muted">Nächste {DAYS} Tage</span>
      </div>

      {evError && <div className="shrink-0 border-b border-border bg-danger/10 px-3 py-1.5 text-xs text-danger">Termine konnten nicht geladen werden: {errorMessage(evError)}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {calLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : noCalendars ? (
          <p className="p-4 text-center text-sm text-muted">
            Kein Kalender verbunden.{' '}
            <Link to="/settings/accounts" className="text-primary hover:underline">
              Konto verbinden
            </Link>
          </p>
        ) : (
          <>
            {groups.map((g) =>
              g.events.length || isSameDay(g.day, day) ? (
                <section key={g.day.toISOString()} className="mb-3">
                  <h3 className={cn('sticky top-0 z-[1] bg-surface px-2 py-1 text-xs font-semibold', isToday(g.day) ? 'text-primary' : 'text-muted')}>{dayHeading(g.day)}</h3>
                  {g.events.length === 0 ? (
                    <p className="px-2 py-1 text-sm text-subtle">Keine Termine</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {g.events.map((ev) => (
                        <AgendaItem
                          key={`${calKey({ accountId: ev.accountId, calendarId: ev.calendarId })}|${ev.id}`}
                          ev={ev}
                          day={g.day}
                          now={now}
                          color={eventColor(ev, calendarMap.get(calKey({ accountId: ev.accountId, calendarId: ev.calendarId })), accountMap.get(ev.accountId))}
                          onOpen={() => setDetail(ev)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null,
            )}
            {!hasEvents && !isFetching && <p className="px-2 text-xs text-subtle">Auch in den folgenden Tagen stehen keine Termine an.</p>}
          </>
        )}
      </div>

      {detail && (
        <EventDetails
          event={detail}
          calendar={calendarMap.get(calKey({ accountId: detail.accountId, calendarId: detail.calendarId }))}
          account={accountMap.get(detail.accountId)}
          onClose={() => setDetail(null)}
          onEdit={(ev, split) => {
            setEditor({ event: ev, split });
            setDetail(null);
          }}
        />
      )}
      {editor && (
        <EventEditor init={editor} calendars={calendars} accountMap={accountMap} defaultCalendarKey={writableDefault} onClose={() => setEditor(null)} />
      )}
    </SidePanel>
  );
}

function AgendaItem({ ev, day, now, color, onOpen }: { ev: CalendarEvent; day: Date; now: number; color: string; onOpen: () => void }) {
  const start = parseEventDate(ev.start);
  const end = parseEventDate(ev.end);
  const past = end.getTime() <= now;
  const running = !ev.allDay && start.getTime() <= now && !past;
  const cancelled = ev.status === 'cancelled';

  let time: string;
  if (ev.allDay) time = 'ganztägig';
  else {
    // Mehrtägig: am Folgetag ab 00:00 bzw. bis 24:00
    const from = start < day ? '00:00' : format(start, 'HH:mm');
    const to = end >= addDays(day, 1) ? '24:00' : format(end, 'HH:mm');
    time = `${from}–${to}`;
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn('group flex cursor-pointer gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover', past && 'opacity-55')}
      >
        <span className="mt-0.5 w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className={cn('truncate text-sm font-medium', cancelled && 'line-through')}>{ev.title || '(Ohne Titel)'}</span>
            {isRecurring(ev) && (
              <span className="shrink-0 text-muted" title={ev.isException ? 'Einzeln geänderter Serientermin' : 'Serientermin'}>
                <Repeat className="h-3 w-3" aria-label="Serientermin" />
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className={cn('shrink-0 tabular-nums', running && 'font-semibold text-primary')}>{running ? `jetzt · bis ${format(end, 'HH:mm')}` : time}</span>
            {ev.location && (
              <span className="flex min-w-0 items-center gap-0.5 truncate">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{ev.location}</span>
              </span>
            )}
          </div>
        </div>
        {ev.onlineMeetingUrl && !past && !cancelled && (
          <a
            href={ev.onlineMeetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`${meetingLabel(ev.onlineMeetingProvider)} beitreten`}
            aria-label={`${meetingLabel(ev.onlineMeetingProvider)} beitreten`}
            className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-primary transition-colors hover:bg-primary-soft"
          >
            <Video className="h-4 w-4" />
          </a>
        )}
      </div>
    </li>
  );
}

function HeaderButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
