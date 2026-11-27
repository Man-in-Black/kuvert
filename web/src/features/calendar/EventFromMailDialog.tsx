/**
 * Termin aus einer E-Mail anlegen: Titel = Betreff, Beschreibung mit Link zurück zur Mail
 * und dem Mailtext; auf Wunsch Absender bzw. alle Beteiligten als Teilnehmer.
 */
import { useMemo } from 'react';
import type { EmailAddress, MessageDetail } from '@kuvert/shared';
import { Modal, Spinner } from '@/components/ui';
import { useAccountMap } from '@/lib/queries';
import { cleanSubject, mailSource } from '@/features/mail/mail-source';
import { calKeyOf, useCalendars } from './api';
import { EventEditor } from './EventEditor';

export type MailEventMode = 'plain' | 'sender' | 'all';

export default function EventFromMailDialog({
  accountId,
  folderId,
  message,
  mode,
  onClose,
}: {
  accountId: string;
  folderId: string;
  message: MessageDetail;
  mode: MailEventMode;
  onClose: () => void;
}) {
  const accountMap = useAccountMap();
  const { data, isLoading } = useCalendars();
  const calendars = useMemo(() => data?.calendars ?? [], [data]);

  // Standard: Standardkalender des Mailkontos, sonst irgendein beschreibbarer Standardkalender
  const defaultKey = useMemo(() => {
    const w = calendars.filter((c) => !c.readOnly);
    const pick = w.find((c) => c.accountId === accountId && c.isDefault) ?? w.find((c) => c.isDefault) ?? w[0];
    return pick ? calKeyOf(pick) : '';
  }, [calendars, accountId]);

  const draft = useMemo(() => {
    const src = mailSource(accountId, folderId, message);
    const own = accountMap.get(accountId)?.email?.toLowerCase();
    let attendees: EmailAddress[] = [];
    if (mode !== 'plain') {
      const people = mode === 'sender' ? [message.from] : [message.from, ...(message.to ?? []), ...(message.cc ?? [])];
      const seen = new Set<string>();
      attendees = people.filter((p): p is EmailAddress => {
        const a = p?.address?.toLowerCase();
        if (!a || a === own || seen.has(a)) return false;
        seen.add(a);
        return true;
      });
    }
    const head = `E-Mail: ${src.subject}${src.fromLabel ? ` (von ${src.fromLabel})` : ''}`;
    // Mit Teilnehmern geht die Beschreibung an alle – dann ohne Kuvert-Link und Mailtext
    const description = attendees.length ? '' : [head, src.url, src.excerpt(3000)].filter(Boolean).join('\n\n');
    return { title: cleanSubject(src.subject), description, attendees };
  }, [accountId, folderId, message, mode, accountMap]);

  if (isLoading) {
    return (
      <Modal open onClose={onClose} title="Neuer Termin">
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      </Modal>
    );
  }
  if (!calendars.some((c) => !c.readOnly)) {
    return (
      <Modal open onClose={onClose} title="Neuer Termin">
        <p className="text-sm text-muted">Es ist kein beschreibbarer Kalender verbunden. Verbinde ein Konto mit Kalender in den Kontoeinstellungen.</p>
      </Modal>
    );
  }
  return <EventEditor init={{ calendarKey: defaultKey, draft }} calendars={calendars} accountMap={accountMap} defaultCalendarKey={defaultKey} onClose={onClose} />;
}
