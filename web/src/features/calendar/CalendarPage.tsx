import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import type {
  CalendarApi,
  CalendarOptions,
  DateSelectArg,
  DatesSetArg,
  EventClickArg,
  EventDropArg,
  EventInput as FcEventInput,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { addDays, addHours } from 'date-fns';
import { AlertTriangle, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Columns3, Layers, Menu, Plus, RefreshCw } from 'lucide-react';
import type { AccountInfo, CalendarEvent, CalendarInfo, UserSettings } from '@kuvert/shared';
import { Button, ColorDot, EmptyState, IconButton, SidebarSheet, Spinner, Tabs } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap, useSettings, useUpdateSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { calKey, calKeyOf, getEvent, invalidateEvents, updateEvent, useCalendars, useEvents, type AccountError } from './api';
import { EventDetails } from './EventDetails';
import { EventEditor, type EditorInit } from './EventEditor';
import { MiniMonth } from './MiniMonth';
import { followingMoveInput, isFirstOccurrence, isOccurrence, isRecurring, seriesMovePatch, splitSeries, useSeriesScope, type SeriesScope } from './series';
import { eventColor, toDateInput } from './utils';
import { COLLAPSED_KEY, HIDDEN_KEY, usePersistentSet } from './visibility';
import './calendar.css';

type ViewName = UserSettings['calendarView'];
const VIEW_TABS: { value: ViewName; label: string }[] = [
  { value: 'dayGridMonth', label: 'Monat' },
  { value: 'timeGridWeek', label: 'Woche' },
  { value: 'timeGridDay', label: 'Tag' },
  { value: 'listWeek', label: 'Liste' },
];

const MODE_TABS: { value: UserSettings['calendarMode']; label: ReactNode }[] = [
  {
    value: 'overlay',
    label: (
      <span className="inline-flex items-center gap-1" title="Alle Kalender in einer Ansicht">
        <Layers className="h-3.5 w-3.5" /> Überlagert
      </span>
    ),
  },
  {
    value: 'split',
    label: (
      <span className="inline-flex items-center gap-1" title="Kalender nebeneinander">
        <Columns3 className="h-3.5 w-3.5" /> Nebeneinander
      </span>
    ),
  },
];

interface RangeState {
  start: string;
  end: string;
  title: string;
  startDate: Date;
  endDate: Date;
}

export default function CalendarPage() {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const accountMap = useAccountMap();
  const { data: calData, isLoading: calLoading } = useCalendars();
  const calendars = calData?.calendars ?? [];
  const calendarMap = useMemo(() => new Map(calendars.map((c) => [calKeyOf(c), c])), [calendars]);

  const [hidden, updateHidden] = usePersistentSet(HIDDEN_KEY);
  const [collapsed, updateCollapsed] = usePersistentSet(COLLAPSED_KEY);
  const visible = useMemo(() => calendars.filter((c) => !hidden.has(calKeyOf(c))), [calendars, hidden]);
  const visibleRefs = useMemo(() => visible.map((c) => ({ accountId: c.accountId, calendarId: c.id })), [visible]);

  const mode = settings.calendarMode;
  const [view, setView] = useState<ViewName>(settings.calendarView);
  const [range, setRange] = useState<RangeState | null>(null);
  const currentDate = useRef<Date>(new Date());
  const apis = useRef(new Map<string, CalendarApi>());
  /** Bereich der Kalender – ändert sich seine Größe (Seitenleisten auf/zu), muss FullCalendar neu messen */
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // FullCalendar reagiert nur auf Fenstergrößen; Seitenleisten ändern aber nur den Inhaltsbereich
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apis.current.forEach((api) => api.updateSize()));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  const [detail, setDetail] = useState<CalendarEvent | null>(null);
  const [editor, setEditor] = useState<EditorInit | null>(null);
  const { askScope, dialog } = useSeriesScope();

  // Mobil: Seitenleiste als Schublade
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  const { data: evData, isFetching, error: evError } = useEvents(range ? { start: range.start, end: range.end } : null, visibleRefs);

  // Einstellungen aus dem Server übernehmen, sobald sie geladen sind
  const viewTouched = useRef(false);
  useEffect(() => {
    if (!viewTouched.current && settings.calendarView !== view) {
      setView(settings.calendarView);
      apis.current.forEach((a) => a.changeView(settings.calendarView));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.calendarView]);

  const forEachApi = (fn: (api: CalendarApi) => void) => apis.current.forEach(fn);

  /* ───────────── Ereignisse → FullCalendar ───────────── */

  const fcEvents = useMemo(() => {
    const out: (FcEventInput & { calKey: string })[] = [];
    for (const ev of evData?.events ?? []) {
      const key = calKey({ accountId: ev.accountId, calendarId: ev.calendarId });
      const cal = calendarMap.get(key);
      const color = eventColor(ev, cal, accountMap.get(ev.accountId));
      out.push({
        calKey: key,
        id: `${key}|${ev.id}`,
        title: ev.title || '(Ohne Titel)',
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        backgroundColor: color,
        borderColor: color,
        textColor: '#ffffff',
        editable: !cal?.readOnly,
        classNames: [
          ev.status === 'cancelled' ? 'is-cancelled' : '',
          ev.showAs === 'tentative' || ev.myResponse === 'tentative' ? 'is-tentative' : '',
          ev.showAs === 'free' ? 'is-free' : '',
          ev.myResponse === 'needsAction' && !ev.isOrganizer ? 'is-pending' : '',
          isRecurring(ev) ? (ev.isException ? 'is-recurring is-exception' : 'is-recurring') : '',
        ].filter(Boolean),
        extendedProps: { ev },
      });
    }
    return out;
  }, [evData, calendarMap, accountMap]);

  /* ───────────── Navigation ───────────── */

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    currentDate.current = arg.view.currentStart;
    setRange({
      start: arg.start.toISOString(),
      end: arg.end.toISOString(),
      title: arg.view.title,
      startDate: arg.view.currentStart,
      endDate: arg.view.currentEnd,
    });
  }, []);

  const changeView = (v: ViewName, date?: Date) => {
    viewTouched.current = true;
    setView(v);
    forEachApi((a) => a.changeView(v, date));
    if (v !== settings.calendarView) updateSettings.mutate({ calendarView: v });
  };

  const setMode = (m: UserSettings['calendarMode']) => {
    if (m !== mode) updateSettings.mutate({ calendarMode: m });
  };

  /* ───────────── Interaktion ───────────── */

  const writableDefault = useMemo(() => {
    const w = visible.filter((c) => !c.readOnly);
    const pick = w.find((c) => c.isDefault) ?? w[0] ?? calendars.find((c) => !c.readOnly);
    return pick ? calKeyOf(pick) : '';
  }, [visible, calendars]);

  const onSelect = (arg: DateSelectArg, columnKey?: string) => {
    arg.view.calendar.unselect();
    let end = arg.end;
    // Ein einzelner Klick in der Wochenansicht → 1 Stunde statt 30 Minuten
    if (!arg.allDay && end.getTime() - arg.start.getTime() <= 30 * 60_000) end = addHours(arg.start, 1);
    setDetail(null);
    setEditor({ start: arg.start, end, allDay: arg.allDay, calendarKey: columnKey && !calendarMap.get(columnKey)?.readOnly ? columnKey : writableDefault });
  };

  const onEventClick = (arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    setDetail(arg.event.extendedProps.ev as CalendarEvent);
  };

  const onMove = async (arg: EventDropArg | EventResizeDoneArg) => {
    const ev = arg.event.extendedProps.ev as CalendarEvent;
    const allDay = arg.event.allDay;
    const start = arg.event.start!;
    const end = arg.event.end ?? (allDay ? addDays(start, 1) : addHours(start, 1));
    const fmt = (d: Date) => (allDay ? toDateInput(d) : d.toISOString());
    let scope: SeriesScope = 'occurrence';
    if (isOccurrence(ev)) {
      const picked = await askScope('move', ev);
      if (!picked) {
        arg.revert();
        return;
      }
      scope = picked;
    }
    try {
      if (scope !== 'occurrence') {
        const master = await getEvent(ev.accountId, ev.calendarId, ev.recurringEventId!);
        if (scope === 'following' && !isFirstOccurrence(master, ev)) {
          const input = await followingMoveInput({ master, occurrence: ev }, { start, end, allDay });
          await splitSeries({ master, occurrence: ev }, input);
          toast.success('Dieser und alle folgenden Termine verschoben');
        } else {
          await updateEvent(master.accountId, master.calendarId, master.id, seriesMovePatch(master, ev, { start, end, allDay }));
          toast.success('Alle Termine der Serie verschoben');
        }
      } else {
        await updateEvent(ev.accountId, ev.calendarId, ev.id, {
          start: fmt(start),
          end: fmt(end),
          allDay,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        toast.success(isOccurrence(ev) ? 'Termin verschoben – die übrige Serie bleibt unverändert' : 'Termin verschoben');
      }
      await invalidateEvents(qc);
    } catch (err) {
      arg.revert();
      toast.error(errorMessage(err));
    }
  };

  const baseOptions: CalendarOptions = {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
    locale: deLocale,
    firstDay: settings.weekStartsOn,
    headerToolbar: false,
    height: '100%',
    nowIndicator: true,
    weekNumbers: view !== 'listWeek',
    weekText: 'KW',
    allDayText: 'ganztägig',
    noEventsText: 'Keine Termine in diesem Zeitraum',
    businessHours: { daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00' },
    scrollTime: '07:00:00',
    selectable: true,
    selectMirror: true,
    editable: true,
    dayMaxEvents: true,
    navLinks: true,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventClick: onEventClick,
    eventDidMount: ({ event, el }) => {
      const ev = event.extendedProps.ev as CalendarEvent | undefined;
      if (ev && isRecurring(ev)) el.title = `${event.title} · ${ev.isException ? 'einzeln geänderter Serientermin' : 'Serientermin'}`;
    },
    eventDrop: (a) => void onMove(a),
    eventResize: (a) => void onMove(a),
    navLinkDayClick: (date) => changeView('timeGridDay', date),
  };

  const registerApi = (key: string) => (r: FullCalendar | null) => {
    if (r) apis.current.set(key, r.getApi());
    else apis.current.delete(key);
  };

  const accountErrors: AccountError[] = [...(calData?.errors ?? []), ...(evData?.errors ?? [])];

  /* ───────────── Seitenleiste: Kalender nach Konto ───────────── */

  const groups = useMemo(() => {
    const m = new Map<string, CalendarInfo[]>();
    for (const c of calendars) m.set(c.accountId, [...(m.get(c.accountId) ?? []), c]);
    return [...m.entries()].map(([accId, cals]) => ({ account: accountMap.get(accId), accountId: accId, cals }));
  }, [calendars, accountMap]);

  const noCalendars = !calLoading && calendars.length === 0;
  const splitColumns = mode === 'split' ? visible : [];

  const newEvent = () => {
    setNavOpen(false);
    setEditor({ calendarKey: writableDefault });
  };

  const sidebarContent = (
    <>
      <div className="p-3">
        <Button variant="primary" className="w-full justify-center" icon={<Plus className="h-4 w-4" />} onClick={newEvent} disabled={noCalendars}>
          Neuer Termin
        </Button>
      </div>
      {isMobile && (
        <div className="px-3 pb-3">
          <Tabs className="w-full [&>button]:flex-1" value={mode} onChange={setMode} tabs={MODE_TABS} />
        </div>
      )}
      <MiniMonth
        date={range?.startDate ?? new Date()}
        rangeStart={range ? new Date(range.start) : undefined}
        rangeEnd={range ? new Date(range.end) : undefined}
        weekStartsOn={settings.weekStartsOn}
        onPick={(d) => {
          forEachApi((a) => a.gotoDate(d));
          setNavOpen(false);
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto border-t border-border px-2 py-2">
        {calLoading && (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        )}
        {groups.map((g) => (
          <CalendarGroup
            key={g.accountId}
            account={g.account}
            calendars={g.cals}
            hidden={hidden}
            collapsed={collapsed.has(g.accountId)}
            alwaysShowToggleAll={isMobile}
            onToggleCollapsed={() => updateCollapsed((s) => (s.has(g.accountId) ? s.delete(g.accountId) : s.add(g.accountId)))}
            onToggle={(key) => updateHidden((s) => (s.has(key) ? s.delete(key) : s.add(key)))}
            onToggleAll={(show) =>
              updateHidden((s) => {
                for (const c of g.cals) (show ? s.delete(calKeyOf(c)) : s.add(calKeyOf(c)));
              })
            }
          />
        ))}
        {accountErrors.length > 0 && (
          <div className="mt-2 space-y-1">
            {dedupeErrors(accountErrors).map((e) => (
              <div key={e.accountId} className="flex gap-1.5 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger" title={e.message}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">
                  <span className="font-medium">{e.account}:</span> <span className="break-words">{e.message}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  const navButtons = (
    <>
      <Button size="sm" onClick={() => forEachApi((a) => a.today())}>
        Heute
      </Button>
      <IconButton label="Zurück" size="icon-sm" onClick={() => forEachApi((a) => a.prev())}>
        <ChevronLeft className="h-4 w-4" />
      </IconButton>
      <IconButton label="Weiter" size="icon-sm" onClick={() => forEachApi((a) => a.next())}>
        <ChevronRight className="h-4 w-4" />
      </IconButton>
    </>
  );

  const refreshButton = (
    <IconButton
      label="Aktualisieren"
      size="icon-sm"
      onClick={() => {
        void qc.invalidateQueries({ queryKey: ['calendar'] });
      }}
    >
      <RefreshCw className="h-4 w-4" />
    </IconButton>
  );

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* Seitenleiste */}
      {!isMobile && <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">{sidebarContent}</aside>}

      {/* Hauptbereich */}
      <section className="flex min-w-0 flex-1 flex-col bg-surface">
        {isMobile ? (
          <header className="shrink-0 border-b border-border">
            <div className="flex h-12 items-center gap-1 px-2">
              <IconButton label="Kalender & Optionen" size="icon-sm" onClick={() => setNavOpen(true)}>
                <Menu className="h-4 w-4" />
              </IconButton>
              <h1 className="ml-1 min-w-0 flex-1 truncate text-base font-semibold">{range?.title ?? ''}</h1>
              {isFetching && <Spinner className="h-4 w-4 shrink-0" />}
              {navButtons}
            </div>
            <div className="flex items-center gap-1 px-2 pb-2">
              <Tabs className="flex-1 [&>button]:flex-1 [&>button]:px-1" value={view} onChange={(v) => changeView(v)} tabs={VIEW_TABS} />
              {refreshButton}
              <IconButton label="Neuer Termin" size="icon-sm" onClick={newEvent} disabled={noCalendars}>
                <Plus className="h-4 w-4" />
              </IconButton>
            </div>
          </header>
        ) : (
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
            {navButtons}
            <h1 className="ml-1 truncate text-lg font-semibold">{range?.title ?? ''}</h1>
            {isFetching && <Spinner className="h-4 w-4" />}
            <div className="flex-1" />
            <Tabs value={view} onChange={(v) => changeView(v)} tabs={VIEW_TABS} />
            <Tabs value={mode} onChange={setMode} tabs={MODE_TABS} />
            {refreshButton}
          </header>
        )}

        {evError && (
          <div className="border-b border-border bg-danger/10 px-4 py-1.5 text-xs text-danger">Termine konnten nicht geladen werden: {errorMessage(evError)}</div>
        )}

        <div ref={areaRef} className="min-h-0 flex-1">
          {noCalendars ? (
            <EmptyState icon={<CalendarDays />} title="Kein Kalender verbunden">
              Verbinde ein Konto mit Kalender (Microsoft 365, Google, CalDAV, Nextcloud) in den{' '}
              <Link to="/settings/accounts" className="text-primary hover:underline">
                Kontoeinstellungen
              </Link>
              .
            </EmptyState>
          ) : mode === 'overlay' ? (
            <div className="kuvert-cal h-full">
              <FullCalendar
                key="overlay"
                ref={registerApi('overlay')}
                {...baseOptions}
                initialView={view}
                initialDate={currentDate.current}
                events={fcEvents}
                datesSet={onDatesSet}
                select={(a) => onSelect(a)}
              />
            </div>
          ) : splitColumns.length === 0 ? (
            <EmptyState icon={<Columns3 />} title="Keine Kalender ausgewählt">
              Wähle {isMobile ? 'im Menü' : 'links'} mindestens einen Kalender aus.
            </EmptyState>
          ) : (
            <div className="flex h-full min-h-0 divide-x divide-border overflow-x-auto">
              {splitColumns.map((cal, i) => {
                const key = calKeyOf(cal);
                const acc = accountMap.get(cal.accountId);
                const color = cal.color || acc?.color;
                return (
                  <div key={key} className="flex h-full min-w-[320px] flex-1 flex-col">
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3" style={{ boxShadow: `inset 0 3px 0 ${color}` }}>
                      <ColorDot color={color} />
                      <span className="truncate text-sm font-medium">{cal.name}</span>
                      <span className="truncate text-xs text-muted">{acc?.name}</span>
                    </div>
                    <div className="kuvert-cal min-h-0 flex-1">
                      <FullCalendar
                        ref={registerApi(key)}
                        {...baseOptions}
                        weekNumbers={i === 0 && view !== 'listWeek'}
                        initialView={view}
                        initialDate={currentDate.current}
                        events={fcEvents.filter((e) => e.calKey === key)}
                        datesSet={i === 0 ? onDatesSet : undefined}
                        select={(a) => onSelect(a, key)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <SidebarSheet open={isMobile && navOpen} onClose={() => setNavOpen(false)}>
        {sidebarContent}
      </SidebarSheet>

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
        <EventEditor
          init={editor}
          calendars={calendars}
          accountMap={accountMap}
          defaultCalendarKey={writableDefault}
          onClose={() => setEditor(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function dedupeErrors(errors: AccountError[]): AccountError[] {
  const m = new Map<string, AccountError>();
  for (const e of errors) if (!m.has(e.accountId)) m.set(e.accountId, e);
  return [...m.values()];
}

function CalendarGroup({
  account,
  calendars,
  hidden,
  collapsed,
  alwaysShowToggleAll,
  onToggle,
  onToggleAll,
  onToggleCollapsed,
}: {
  account?: AccountInfo;
  calendars: CalendarInfo[];
  hidden: Set<string>;
  collapsed: boolean;
  alwaysShowToggleAll?: boolean;
  onToggle: (key: string) => void;
  onToggleAll: (show: boolean) => void;
  onToggleCollapsed: () => void;
}) {
  const allVisible = calendars.every((c) => !hidden.has(calKeyOf(c)));
  return (
    <div className="mb-2">
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-hover">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={onToggleCollapsed}>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform', collapsed && '-rotate-90')} />
          <ColorDot color={account?.color} />
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{account?.name ?? 'Konto'}</span>
        </button>
        <button
          type="button"
          className={cn('text-[11px] text-muted hover:text-fg', alwaysShowToggleAll ? 'block px-1' : 'hidden group-hover:block')}
          onClick={() => onToggleAll(!allVisible)}
          title={allVisible ? 'Alle ausblenden' : 'Alle einblenden'}
        >
          {allVisible ? 'keine' : 'alle'}
        </button>
      </div>
      {!collapsed && (
        <ul className="mt-0.5">
          {calendars.map((c) => {
            const key = calKeyOf(c);
            const color = c.color || account?.color || '#2563eb';
            const checked = !hidden.has(key);
            return (
              <li key={key}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-hover" title={c.owner ?? c.name}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(key)} className="h-3.5 w-3.5 rounded" style={{ accentColor: color }} />
                  <span className={cn('min-w-0 flex-1 truncate', !checked && 'text-muted')}>{c.name}</span>
                  {c.readOnly && <span className="text-[10px] text-muted">nur lesen</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
