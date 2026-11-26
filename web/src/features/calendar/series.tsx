/**
 * Serientermine: Abfrage „nur dieser / dieser und alle folgenden / ganze Serie“,
 * Umrechnung einer verschobenen Instanz auf den Serienmaster und Teilen einer Serie.
 *
 * Alle Anbieter liefern Serien als einzelne Instanzen mit `recurringEventId`
 * (Google: Master-ID, Microsoft: seriesMasterId, CalDAV: Objekt-URL). Änderungen
 * an der Instanz-ID betreffen nur diesen Termin (Ausnahme), Änderungen an der
 * Serien-ID die ganze Serie.
 *
 * „Dieser und alle folgenden“ kennt keiner der Anbieter direkt (auch Outlook und
 * Google teilen intern): Die bisherige Serie endet am Vortag, ab diesem Termin
 * wird eine neue Serie angelegt.
 */
import { useState, type ReactNode } from 'react';
import { addDays, differenceInCalendarDays, endOfDay, format, startOfDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarDays, ChevronsRight, Repeat } from 'lucide-react';
import type { CalendarEvent, EventInput } from '@kuvert/shared';
import { Button, Modal } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { createEvent, deleteEvent, fetchEvents, updateEvent } from './api';
import { buildRRule, parseRRule, ruleEnd, withRuleEnd } from './rrule';
import { parseEventDate, toDateInput } from './utils';

export type SeriesScope = 'occurrence' | 'following' | 'series';
export type SeriesAction = 'move' | 'edit' | 'delete';

/** Serie ab einer Instanz teilen: Master und die Instanz, ab der geteilt wird */
export interface SplitContext {
  master: CalendarEvent;
  occurrence: CalendarEvent;
}

/** Gehört zu einer Serie (Instanz oder Master) */
export const isRecurring = (ev: Pick<CalendarEvent, 'recurrence' | 'recurringEventId'>) => !!(ev.recurrence || ev.recurringEventId);

/** Einzelne Instanz einer Serie (nicht der Master) */
export const isOccurrence = (ev: Pick<CalendarEvent, 'recurringEventId'>) => !!ev.recurringEventId;

/** Serienmaster (Bearbeiten wirkt auf alle Termine) */
export const isSeriesMaster = (ev: Pick<CalendarEvent, 'recurrence' | 'recurringEventId'>) => !!ev.recurrence && !ev.recurringEventId;

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const TEXT: Record<SeriesAction, { title: string; one: string; following: string; followingHint: string; all: string; allHint: string }> = {
  move: {
    title: 'Serientermin verschieben',
    one: 'Nur diesen Termin verschieben',
    following: 'Diesen und alle folgenden verschieben',
    followingHint: 'Frühere Termine bleiben, wie sie sind.',
    all: 'Alle Termine der Serie verschieben',
    allHint: 'Uhrzeit bzw. Wochentag ändern sich für die gesamte Serie.',
  },
  edit: {
    title: 'Serientermin bearbeiten',
    one: 'Nur diesen Termin bearbeiten',
    following: 'Diesen und alle folgenden bearbeiten',
    followingHint: 'Frühere Termine bleiben, wie sie sind.',
    all: 'Gesamte Serie bearbeiten',
    allHint: 'Änderungen gelten für alle Termine, auch die Wiederholung lässt sich anpassen.',
  },
  delete: {
    title: 'Serientermin löschen',
    one: 'Nur diesen Termin löschen',
    following: 'Diesen und alle folgenden löschen',
    followingHint: 'Frühere Termine bleiben erhalten.',
    all: 'Gesamte Serie löschen',
    allHint: 'Alle vergangenen und künftigen Termine der Serie werden entfernt.',
  },
};

/** Dialog „Nur dieser / Dieser und alle folgenden / Gesamte Serie“. askScope liefert null bei Abbruch. */
export function useSeriesScope() {
  const [state, setState] = useState<{ action: SeriesAction; event: CalendarEvent; resolve: (v: SeriesScope | null) => void } | null>(null);
  const close = (v: SeriesScope | null) => {
    state?.resolve(v);
    setState(null);
  };
  const askScope = (action: SeriesAction, event: CalendarEvent) =>
    new Promise<SeriesScope | null>((resolve) => setState({ action, event, resolve }));

  let dialog = null;
  if (state) {
    const t = TEXT[state.action];
    const day = format(parseEventDate(state.event.start), 'EEEE, d. MMMM yyyy', { locale: de });
    const danger = state.action === 'delete';
    // Teilen legt eine neue Serie an – das darf nur der Organisator
    const canSplit = state.event.isOrganizer !== false;
    dialog = (
      <Modal open size="sm" title={t.title} onClose={() => close(null)} footer={<Button onClick={() => close(null)}>Abbrechen</Button>}>
        <div className="space-y-2">
          <p className="pb-1 text-sm text-fg/90">„{state.event.title || 'Ohne Titel'}“ ist Teil einer Terminserie.</p>
          <ScopeOption autoFocus icon={<CalendarDays />} label={t.one} hint={`Nur am ${day} – die übrige Serie bleibt unverändert.`} onClick={() => close('occurrence')} />
          {canSplit && <ScopeOption icon={<ChevronsRight />} label={t.following} hint={`Ab ${day}. ${t.followingHint}`} danger={danger} onClick={() => close('following')} />}
          <ScopeOption icon={<Repeat />} label={t.all} hint={t.allHint} danger={danger} onClick={() => close('series')} />
        </div>
      </Modal>
    );
  }
  return { askScope, dialog };
}

function ScopeOption({
  icon,
  label,
  hint,
  danger,
  autoFocus,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  danger?: boolean;
  autoFocus?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        danger && 'hover:border-danger/50',
      )}
    >
      <span className={cn('mt-0.5 shrink-0 text-muted [&_svg]:h-4 [&_svg]:w-4', danger && 'text-danger')}>{icon}</span>
      <span className="min-w-0">
        <span className={cn('block text-sm font-medium', danger && 'text-danger')}>{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}

/* ───────────── Regeln umrechnen ───────────── */

/** Regeln, die sich beim Verschieben auf einen anderen Tag sauber mitziehen lassen */
const DAY_SHIFTABLE = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/** Regel auf einen neuen Starttag umstellen (Wochentag/Monatstag), Endbedingung bleibt exakt erhalten */
function shiftRule(rule: string, start: Date): string {
  const state = parseRRule(rule);
  if (!DAY_SHIFTABLE.has(state.preset)) {
    throw new Error(
      'Bei dieser Wiederholungsregel lässt sich die Serie nur in der Uhrzeit verschieben, nicht auf einen anderen Tag. Verschiebe nur diesen Termin oder passe die Serie über „Bearbeiten“ an.',
    );
  }
  return withRuleEnd(buildRRule({ ...state, end: 'never' }, start) ?? rule, ruleEnd(rule));
}

/** Ursprünglicher Termin der Instanz laut Serienmuster (auch wenn sie einzeln verschoben wurde) */
const splitPoint = (occ: CalendarEvent) => parseEventDate(occ.originalStart ?? occ.start);

/** Ist die Instanz der erste Termin der Serie? Dann entspricht „ab hier“ der ganzen Serie. */
export function isFirstOccurrence(master: CalendarEvent, occ: CalendarEvent): boolean {
  return differenceInCalendarDays(splitPoint(occ), parseEventDate(master.start)) <= 0;
}

/** Regel der bisherigen Serie, die am Vortag der Instanz endet */
export function truncatedRule(master: CalendarEvent, occ: CalendarEvent): string {
  if (!master.recurrence) throw new Error('Die Wiederholungsregel der Serie ist nicht bekannt.');
  const prev = addDays(startOfDay(splitPoint(occ)), -1);
  // Ganztägig: Datum; sonst genauer Zeitpunkt (Ende des Vortags, lokal) in UTC
  const until = master.allDay ? format(prev, 'yyyyMMdd') : endOfDay(prev).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return withRuleEnd(master.recurrence, { until });
}

/**
 * Regel für den neuen Serienteil ab der Instanz. Bei „nach n Terminen“ zählen die
 * bereits vergangenen Termine der Serie mit, damit die Gesamtzahl gleich bleibt.
 */
export async function followingRule(master: CalendarEvent, occ: CalendarEvent): Promise<string> {
  if (!master.recurrence) throw new Error('Die Wiederholungsregel der Serie ist nicht bekannt.');
  const { count } = ruleEnd(master.recurrence);
  if (!count) return master.recurrence;
  const res = await fetchEvents(
    { start: parseEventDate(master.start).toISOString(), end: splitPoint(occ).toISOString() },
    [{ accountId: master.accountId, calendarId: master.calendarId }],
  );
  const before = res.events.filter((e) => e.recurringEventId === master.id).length;
  return withRuleEnd(master.recurrence, { count: Math.max(1, count - before) });
}

/* ───────────── Änderungen ───────────── */

/**
 * Änderung für den Serienmaster, wenn eine Instanz per Ziehen verschoben wurde und
 * die ganze Serie folgen soll: gleiche Tagesverschiebung und neue Uhrzeit/Dauer,
 * bezogen auf den ersten Termin der Serie. Wochentag bzw. Monatstag der Regel
 * werden mitgezogen.
 */
export function seriesMovePatch(
  master: CalendarEvent,
  instance: CalendarEvent,
  next: { start: Date; end: Date; allDay: boolean },
): Partial<EventInput> {
  const dayDelta = differenceInCalendarDays(next.start, parseEventDate(instance.start));
  const base = addDays(parseEventDate(master.start), dayDelta);
  let start: Date;
  let end: Date;
  if (next.allDay) {
    start = startOfDay(base);
    end = addDays(start, Math.max(1, differenceInCalendarDays(next.end, next.start)));
  } else {
    start = new Date(base);
    start.setHours(next.start.getHours(), next.start.getMinutes(), 0, 0);
    end = new Date(start.getTime() + Math.max(0, next.end.getTime() - next.start.getTime()));
  }
  const fmt = (d: Date) => (next.allDay ? toDateInput(d) : d.toISOString());
  const patch: Partial<EventInput> = { start: fmt(start), end: fmt(end), allDay: next.allDay, timeZone: localTz() };
  if (dayDelta !== 0 && master.recurrence) patch.recurrence = shiftRule(master.recurrence, start);
  return patch;
}

/** Inhalte des Masters für einen neuen Serienteil (ohne Zeiten und Regel) */
function seriesContent(master: CalendarEvent): Omit<EventInput, 'start' | 'end'> {
  return {
    title: master.title || '(Ohne Titel)',
    ...(master.descriptionHtml ? { descriptionHtml: master.descriptionHtml } : { description: master.description ?? '' }),
    location: master.location ?? '',
    attendees: master.attendees ?? [],
    reminderMinutes: master.reminderMinutes ?? null,
    showAs: master.showAs,
    onlineMeeting: !!master.onlineMeetingUrl,
  };
}

/** Neuer Serienteil, wenn eine Instanz per Ziehen verschoben wurde („dieser und alle folgenden“) */
export async function followingMoveInput(
  ctx: SplitContext,
  next: { start: Date; end: Date; allDay: boolean },
): Promise<EventInput> {
  const fmt = (d: Date) => (next.allDay ? toDateInput(d) : d.toISOString());
  let rule = await followingRule(ctx.master, ctx.occurrence);
  if (differenceInCalendarDays(next.start, parseEventDate(ctx.occurrence.start)) !== 0) rule = shiftRule(rule, next.start);
  return { ...seriesContent(ctx.master), start: fmt(next.start), end: fmt(next.end), allDay: next.allDay, timeZone: localTz(), recurrence: rule };
}

/**
 * Teilt eine Serie: legt ab der Instanz eine neue Serie mit `input` an und lässt die
 * bisherige Serie am Vortag enden. Scheitert das Kürzen, wird die neue Serie wieder entfernt.
 */
export async function splitSeries(ctx: SplitContext, input: EventInput): Promise<CalendarEvent> {
  const { master, occurrence } = ctx;
  const ev: EventInput = {
    ...input,
    // Neue Einladung: Antworten der Teilnehmer gelten nicht automatisch weiter
    attendees: input.attendees?.map((a) => ({ ...a, status: undefined })),
  };
  // Steht der Besprechungslink schon in der übernommenen Beschreibung (Teams), keinen zweiten anlegen
  if (ev.onlineMeeting && master.onlineMeetingUrl) {
    const body = (ev.descriptionHtml ?? ev.description ?? '').replace(/&amp;/g, '&');
    if (body.includes(master.onlineMeetingUrl)) ev.onlineMeeting = false;
  }
  const truncated = truncatedRule(master, occurrence);
  const created = await createEvent(master.accountId, master.calendarId, ev);
  try {
    await updateEvent(master.accountId, master.calendarId, master.id, { recurrence: truncated, timeZone: localTz() });
  } catch (err) {
    const rollback = await deleteEvent(master.accountId, master.calendarId, created.recurringEventId ?? created.id).then(
      () => true,
      () => false,
    );
    throw new Error(
      rollback
        ? `Die Serie konnte nicht geteilt werden: ${errorMessage(err)}`
        : `Die neue Serie wurde angelegt, aber die bisherige konnte nicht beendet werden (${errorMessage(err)}). Bitte die doppelten Termine prüfen.`,
    );
  }
  return created;
}

/** Löscht eine Instanz und alle folgenden Termine (Serie endet am Vortag) */
export async function deleteFollowing(ctx: SplitContext): Promise<void> {
  const { master, occurrence } = ctx;
  if (isFirstOccurrence(master, occurrence)) {
    await deleteEvent(master.accountId, master.calendarId, master.id);
    return;
  }
  await updateEvent(master.accountId, master.calendarId, master.id, { recurrence: truncatedRule(master, occurrence), timeZone: localTz() });
}
