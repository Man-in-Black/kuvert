import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CalendarDays,
  Check,
  CircleHelp,
  Clock,
  ExternalLink,
  HelpCircle,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  User,
  Users,
  Video,
  X,
} from 'lucide-react';
import type { AccountInfo, Attendee, CalendarEvent, CalendarInfo, EventResponse } from '@kuvert/shared';
import { Avatar, Badge, Button, IconButton, useConfirm } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { deleteEvent, invalidateEvents, respondToEvent } from './api';
import { mapsSearchUrl } from './LocationInput';
import { describeRRule } from './rrule';
import { SHOW_AS_LABELS, eventColor, eventDescription, formatEventRange } from './utils';

const STATUS_LABEL: Record<NonNullable<Attendee['status']>, string> = {
  accepted: 'Zugesagt',
  declined: 'Abgesagt',
  tentative: 'Mit Vorbehalt',
  needsAction: 'Keine Antwort',
  none: 'Keine Antwort',
};

function StatusIcon({ status }: { status?: Attendee['status'] }) {
  if (status === 'accepted') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'declined') return <X className="h-3.5 w-3.5 text-danger" />;
  if (status === 'tentative') return <HelpCircle className="h-3.5 w-3.5 text-warning" />;
  return <CircleHelp className="h-3.5 w-3.5 text-muted" />;
}

/** Text mit klickbaren Links */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="mt-0.5 shrink-0 text-muted [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Seitliches Detail-Panel eines Termins. */
export function EventDetails({
  event,
  calendar,
  account,
  onClose,
  onEdit,
}: {
  event: CalendarEvent;
  calendar?: CalendarInfo;
  account?: AccountInfo;
  onClose: () => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const color = eventColor(event, calendar, account);
  const description = eventDescription(event);
  const readOnly = !!calendar?.readOnly;
  const canRespond = !event.isOrganizer && (!!event.myResponse || (event.attendees?.length ?? 0) > 0);
  const isRecurring = !!(event.recurrence || event.recurringEventId);

  const remove = async () => {
    const msg = isRecurring
      ? 'Dies ist ein Serientermin. Je nach Anbieter wird die gesamte Serie gelöscht. Fortfahren?'
      : `Termin „${event.title || 'Ohne Titel'}“ wirklich löschen?`;
    if (!(await confirm(msg, { danger: true }))) return;
    setBusy('delete');
    try {
      await deleteEvent(event.accountId, event.calendarId, event.id);
      toast.success('Termin gelöscht');
      await invalidateEvents(qc);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const respond = async (response: EventResponse) => {
    setBusy(response);
    try {
      await respondToEvent(event.accountId, event.calendarId, event.id, response);
      toast.success(response === 'accept' ? 'Zugesagt' : response === 'decline' ? 'Abgesagt' : 'Mit Vorbehalt angenommen');
      await invalidateEvents(qc);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[400px] flex-col border-l border-border bg-surface shadow-2xl">
      <div className="h-1.5 shrink-0" style={{ backgroundColor: color }} />
      <div className="flex items-start gap-2 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className={cn('text-lg font-semibold leading-snug', event.status === 'cancelled' && 'line-through opacity-70')}>
            {event.title || '(Ohne Titel)'}
          </h2>
          <div className="mt-1 flex flex-wrap gap-1">
            {event.status === 'cancelled' && <Badge color="#dc2626">Abgesagt</Badge>}
            {event.showAs && event.showAs !== 'busy' && <Badge>{SHOW_AS_LABELS[event.showAs]}</Badge>}
            {event.myResponse && event.myResponse !== 'none' && !event.isOrganizer && <Badge>{STATUS_LABEL[event.myResponse]}</Badge>}
          </div>
        </div>
        <IconButton label="Schließen" size="icon-sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        <Row icon={<Clock />}>
          <div>{formatEventRange(event)}</div>
          {isRecurring && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
              <Repeat className="h-3 w-3" />
              {event.recurrence ? describeRRule(event.recurrence) : 'Teil einer Serie'}
            </div>
          )}
        </Row>

        {event.onlineMeetingUrl && (
          <Row icon={<Video />}>
            <Button
              variant="primary"
              size="sm"
              icon={<Video className="h-4 w-4" />}
              onClick={() => window.open(event.onlineMeetingUrl, '_blank', 'noopener,noreferrer')}
            >
              Teilnehmen{event.onlineMeetingProvider ? ` (${event.onlineMeetingProvider === 'teams' ? 'Teams' : event.onlineMeetingProvider === 'meet' ? 'Meet' : event.onlineMeetingProvider})` : ''}
            </Button>
          </Row>
        )}

        {event.location && (
          <Row icon={<MapPin />}>
            <Linkified text={event.location} />
            {!/^(https?:\/\/|www\.)/i.test(event.location.trim()) && (
              <a href={mapsSearchUrl(event.location)} target="_blank" rel="noopener noreferrer" className="block text-xs text-primary hover:underline">
                In Google Maps öffnen
              </a>
            )}
          </Row>
        )}

        <Row icon={<CalendarDays />}>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
            <span>{calendar?.name ?? 'Kalender'}</span>
          </div>
          {account && <div className="text-xs text-muted">{account.name}</div>}
        </Row>

        {event.organizer && (
          <Row icon={<User />}>
            <div className="text-xs text-muted">Organisator</div>
            <div className="truncate">{event.organizer.name || event.organizer.address}</div>
          </Row>
        )}

        {(event.attendees?.length ?? 0) > 0 && (
          <Row icon={<Users />}>
            <div className="mb-1 text-xs text-muted">{event.attendees!.length} Teilnehmer</div>
            <ul className="space-y-1.5">
              {event.attendees!.map((a) => (
                <li key={a.address} className="flex items-center gap-2">
                  <Avatar name={a.name} email={a.address} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{a.name || a.address}</span>
                    {a.type === 'optional' && <span className="text-[11px] text-muted">optional</span>}
                  </span>
                  <span title={STATUS_LABEL[a.status ?? 'none']}>
                    <StatusIcon status={a.status} />
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        )}

        {description && (
          <div className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-sm">
            <Linkified text={description} />
          </div>
        )}

        {event.webLink && (
          <a href={event.webLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <ExternalLink className="h-3 w-3" /> Beim Anbieter öffnen
          </a>
        )}
      </div>

      {canRespond && (
        <div className="border-t border-border px-5 py-3">
          <div className="mb-2 text-xs text-muted">Teilnahme</div>
          <div className="flex gap-2">
            <Button size="sm" loading={busy === 'accept'} variant={event.myResponse === 'accepted' ? 'primary' : 'secondary'} onClick={() => respond('accept')}>
              Zusagen
            </Button>
            <Button size="sm" loading={busy === 'tentative'} variant={event.myResponse === 'tentative' ? 'primary' : 'secondary'} onClick={() => respond('tentative')}>
              Vorbehalt
            </Button>
            <Button size="sm" loading={busy === 'decline'} variant={event.myResponse === 'declined' ? 'danger' : 'secondary'} onClick={() => respond('decline')}>
              Absagen
            </Button>
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="flex justify-between gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} loading={busy === 'delete'} onClick={remove}>
            Löschen
          </Button>
          <Button icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
            Bearbeiten
          </Button>
        </div>
      )}
      {dialog}
    </aside>
  );
}
