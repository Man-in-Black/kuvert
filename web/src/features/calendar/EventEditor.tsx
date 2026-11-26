import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addDays, addHours, differenceInMinutes, startOfHour } from 'date-fns';
import { AlertTriangle, Video } from 'lucide-react';
import type { AccountInfo, Attendee, CalendarEvent, CalendarInfo, EmailAddress, EventInput, ShowAs } from '@kuvert/shared';
import { AddressInput } from '@/components/AddressInput';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { calKey, calKeyOf, createEvent, invalidateEvents, updateEvent } from './api';
import { LocationInput } from './LocationInput';
import { PRESET_LABELS, buildRRule, parseRRule, type RecurrencePreset, type RecurrenceState } from './rrule';
import { REMINDER_OPTIONS, SHOW_AS_LABELS, eventDescription, meetingLabel, parseEventDate, toDateInput, toTimeInput } from './utils';

export interface EditorInit {
  event?: CalendarEvent;
  start?: Date;
  end?: Date;
  allDay?: boolean;
  calendarKey?: string;
}

interface FormState {
  title: string;
  calendarKey: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  attendees: EmailAddress[];
  reminder: string;
  recurrence: RecurrenceState;
  showAs: ShowAs;
  onlineMeeting: boolean;
}

function initialState(init: EditorInit, defaultKey: string): FormState {
  const ev = init.event;
  let start: Date;
  let end: Date;
  let allDay: boolean;
  if (ev) {
    allDay = ev.allDay;
    start = parseEventDate(ev.start);
    end = parseEventDate(ev.end);
    if (allDay) end = addDays(end, -1); // Anzeige: inklusives Enddatum
    if (end < start) end = start;
  } else if (init.start) {
    allDay = !!init.allDay;
    start = init.start;
    end = init.end ?? addHours(init.start, 1);
    if (allDay) end = addDays(end, -1);
    if (end < start) end = start;
  } else {
    allDay = false;
    start = startOfHour(addHours(new Date(), 1));
    end = addHours(start, 1);
  }
  return {
    title: ev?.title ?? '',
    calendarKey: ev ? calKey({ accountId: ev.accountId, calendarId: ev.calendarId }) : (init.calendarKey ?? defaultKey),
    allDay,
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: toDateInput(end),
    endTime: toTimeInput(end),
    location: ev?.location ?? '',
    description: ev ? eventDescription(ev) : '',
    attendees: (ev?.attendees ?? []).map((a) => ({ name: a.name, address: a.address })),
    reminder: ev?.reminderMinutes === null || ev?.reminderMinutes === undefined ? (ev ? '' : '15') : String(ev.reminderMinutes),
    recurrence: parseRRule(ev?.recurrence),
    showAs: ev?.showAs ?? 'busy',
    onlineMeeting: !!ev?.onlineMeetingUrl,
  };
}

function toInput(s: FormState, original?: CalendarEvent): EventInput {
  const start = s.allDay ? parseEventDate(s.startDate) : new Date(`${s.startDate}T${s.startTime || '00:00'}`);
  const endBase = s.allDay ? addDays(parseEventDate(s.endDate), 1) : new Date(`${s.endDate}T${s.endTime || '00:00'}`);
  const attendees: Attendee[] = s.attendees.map((a) => {
    const prev = original?.attendees?.find((o) => o.address.toLowerCase() === a.address.toLowerCase());
    return { name: a.name ?? prev?.name, address: a.address, type: prev?.type ?? 'required', status: prev?.status };
  });
  return {
    title: s.title.trim(),
    description: s.description,
    location: s.location,
    start: s.allDay ? toDateInput(start) : start.toISOString(),
    end: s.allDay ? toDateInput(endBase) : endBase.toISOString(),
    allDay: s.allDay,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    attendees,
    recurrence: buildRRule(s.recurrence, start),
    reminderMinutes: s.reminder === '' ? null : Number(s.reminder),
    showAs: s.showAs,
    onlineMeeting: s.onlineMeeting,
  };
}

/** Dialog zum Anlegen/Bearbeiten eines Termins. */
export function EventEditor({
  init,
  calendars,
  accountMap,
  defaultCalendarKey,
  onClose,
  onSaved,
}: {
  init: EditorInit;
  calendars: CalendarInfo[];
  accountMap: Map<string, AccountInfo>;
  defaultCalendarKey: string;
  onClose: () => void;
  onSaved?: (ev: CalendarEvent) => void;
}) {
  const qc = useQueryClient();
  const editing = init.event;
  const isRecurring = !!(editing?.recurrence || editing?.recurringEventId);
  const [s, setS] = useState<FormState>(() => initialState(init, defaultCalendarKey));
  const initialInput = useRef<EventInput>(toInput(initialState(init, defaultCalendarKey), editing));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));

  const writable = calendars.filter((c) => !c.readOnly || (editing && calKeyOf(c) === s.calendarKey));
  const grouped = useMemo(() => {
    const m = new Map<string, CalendarInfo[]>();
    for (const c of writable) m.set(c.accountId, [...(m.get(c.accountId) ?? []), c]);
    return [...m.entries()];
  }, [writable]);
  const calendar = calendars.find((c) => calKeyOf(c) === s.calendarKey);

  /** Beim Verschieben des Beginns die Dauer beibehalten */
  const shiftStart = (date: string, time: string) => {
    setS((p) => {
      const oldStart = p.allDay ? parseEventDate(p.startDate) : new Date(`${p.startDate}T${p.startTime}`);
      const oldEnd = p.allDay ? parseEventDate(p.endDate) : new Date(`${p.endDate}T${p.endTime}`);
      const dur = Math.max(differenceInMinutes(oldEnd, oldStart), 0);
      const newStart = p.allDay ? parseEventDate(date) : new Date(`${date}T${time || '00:00'}`);
      if (Number.isNaN(newStart.getTime())) return { ...p, startDate: date, startTime: time };
      const newEnd = new Date(newStart.getTime() + dur * 60_000);
      return { ...p, startDate: date, startTime: time, endDate: toDateInput(newEnd), endTime: p.allDay ? p.endTime : toTimeInput(newEnd) };
    });
  };

  const save = async () => {
    if (!calendar) {
      toast.error('Bitte einen Kalender wählen');
      return;
    }
    const input = toInput(s, editing);
    const startD = parseEventDate(input.start);
    const endD = parseEventDate(input.end);
    if (Number.isNaN(startD.getTime()) || Number.isNaN(endD.getTime())) {
      toast.error('Bitte gültige Zeiten angeben');
      return;
    }
    if (endD < startD) {
      toast.error('Das Ende liegt vor dem Beginn');
      return;
    }
    setSaving(true);
    try {
      let result: CalendarEvent;
      let meetingRequested = false;
      if (editing) {
        // Nur geänderte Felder senden (verhindert z. B. Verlust von HTML-Beschreibungen)
        const patch: Partial<EventInput> = {};
        const before = initialInput.current as unknown as Record<string, unknown>;
        const after = input as unknown as Record<string, unknown>;
        for (const k of Object.keys(after) as (keyof EventInput)[]) {
          if (k === 'timeZone') continue;
          if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) (patch as Record<string, unknown>)[k] = after[k];
        }
        if ('start' in patch || 'end' in patch || 'allDay' in patch) {
          patch.start = input.start;
          patch.end = input.end;
          patch.allDay = input.allDay;
          patch.timeZone = input.timeZone;
        }
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        meetingRequested = !!patch.onlineMeeting;
        result = await updateEvent(editing.accountId, editing.calendarId, editing.id, patch);
      } else {
        if (!input.title) input.title = '(Ohne Titel)';
        if (!calendar.canOnlineMeeting) delete input.onlineMeeting;
        meetingRequested = !!input.onlineMeeting;
        result = await createEvent(calendar.accountId, calendar.id, input);
      }
      if (meetingRequested && !result.onlineMeetingUrl) {
        toast.warning(`${editing ? 'Termin gespeichert' : 'Termin angelegt'}, aber der Anbieter hat (noch) keinen Besprechungslink geliefert`, {
          description: 'Bitte den Termin in einigen Sekunden erneut öffnen. Fehlt der Link weiterhin, wurde keine Online-Besprechung erstellt.',
        });
      } else toast.success(editing ? 'Termin gespeichert' : 'Termin angelegt');
      await invalidateEvents(qc);
      onSaved?.(result);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={editing ? 'Termin bearbeiten' : 'Neuer Termin'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {isRecurring && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Dies ist ein Serientermin – Änderungen können je nach Anbieter die gesamte Serie betreffen.
          </div>
        )}
        <Input
          autoFocus
          placeholder="Titel hinzufügen"
          className="h-11 text-base font-medium"
          value={s.title}
          onChange={(e) => set('title', e.target.value)}
        />

        <Field label="Kalender">
          <Select value={s.calendarKey} disabled={!!editing} onChange={(e) => set('calendarKey', e.target.value)}>
            {!calendar && <option value="">– Kalender wählen –</option>}
            {grouped.map(([accId, cals]) => (
              <optgroup key={accId} label={accountMap.get(accId)?.name ?? accId}>
                {cals.map((c) => (
                  <option key={calKeyOf(c)} value={calKeyOf(c)}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>

        <div className="space-y-2">
          <Checkbox checked={s.allDay} onChange={(v) => set('allDay', v)} label="Ganztägig" />
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 sm:grid-cols-[auto_1fr_auto_auto_1fr_auto]">
            <span className="text-xs text-muted">Beginn</span>
            <Input type="date" value={s.startDate} onChange={(e) => shiftStart(e.target.value, s.startTime)} required />
            {!s.allDay ? (
              <Input type="time" className="w-28" value={s.startTime} onChange={(e) => shiftStart(s.startDate, e.target.value)} required />
            ) : (
              <span />
            )}
            <span className="text-xs text-muted">Ende</span>
            <Input type="date" value={s.endDate} min={s.startDate} onChange={(e) => set('endDate', e.target.value)} required />
            {!s.allDay ? <Input type="time" className="w-28" value={s.endTime} onChange={(e) => set('endTime', e.target.value)} required /> : <span />}
          </div>
        </div>

        {calendar?.canOnlineMeeting && (editing?.onlineMeetingUrl || editing?.isOrganizer !== false) && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <Video className="h-4 w-4 text-primary" />
            {editing?.onlineMeetingUrl ? (
              <span className="text-sm">
                {meetingLabel(calendar.onlineMeetingProvider)} vorhanden ·{' '}
                <a href={editing.onlineMeetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Link öffnen
                </a>
              </span>
            ) : (
              <Checkbox checked={s.onlineMeeting} onChange={(v) => set('onlineMeeting', v)} label={`${meetingLabel(calendar.onlineMeetingProvider)} hinzufügen`} />
            )}
          </div>
        )}

        <Field label="Ort">
          <LocationInput value={s.location} onChange={(v) => set('location', v)} />
        </Field>

        <Field label="Teilnehmer">
          <div className="rounded-md border border-border bg-surface">
            <AddressInput value={s.attendees} onChange={(v) => set('attendees', v)} placeholder="Personen einladen …" />
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Erinnerung">
            <Select value={s.reminder} onChange={(e) => set('reminder', e.target.value)}>
              {REMINDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Anzeigen als">
            <Select value={s.showAs} onChange={(e) => set('showAs', e.target.value as ShowAs)}>
              {(Object.keys(SHOW_AS_LABELS) as ShowAs[]).map((k) => (
                <option key={k} value={k}>
                  {SHOW_AS_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Wiederholung">
            <Select
              value={s.recurrence.preset}
              disabled={!!editing?.recurringEventId}
              onChange={(e) => set('recurrence', { ...s.recurrence, preset: e.target.value as RecurrencePreset })}
            >
              {(Object.keys(PRESET_LABELS) as RecurrencePreset[])
                .filter((p) => p !== 'custom' || s.recurrence.raw)
                .map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        {s.recurrence.preset === 'custom' && s.recurrence.raw && (
          <div className="rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-muted">RRULE: {s.recurrence.raw}</div>
        )}
        {s.recurrence.preset !== 'none' && s.recurrence.preset !== 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Endet</span>
            <Select
              className="w-48"
              value={s.recurrence.end}
              onChange={(e) => set('recurrence', { ...s.recurrence, end: e.target.value as RecurrenceState['end'] })}
            >
              <option value="never">Nie</option>
              <option value="count">Nach Anzahl Terminen</option>
              <option value="until">Am Datum</option>
            </Select>
            {s.recurrence.end === 'count' && (
              <Input
                type="number"
                min={1}
                max={999}
                className="w-24"
                value={s.recurrence.count}
                onChange={(e) => set('recurrence', { ...s.recurrence, count: Number(e.target.value) || 1 })}
              />
            )}
            {s.recurrence.end === 'until' && (
              <Input
                type="date"
                className="w-44"
                min={s.startDate}
                value={s.recurrence.until}
                onChange={(e) => set('recurrence', { ...s.recurrence, until: e.target.value })}
              />
            )}
          </div>
        )}

        <Field label="Beschreibung">
          <Textarea rows={5} value={s.description} onChange={(e) => set('description', e.target.value)} placeholder="Notizen, Agenda …" />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
