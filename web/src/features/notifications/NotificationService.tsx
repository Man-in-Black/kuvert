/**
 * Unsichtbarer Dienst: reagiert auf Server-Ereignisse und zeigt Desktop-
 * Benachrichtigungen, spielt einen Ton und zählt neue Mails im Tab-Titel.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { CalendarEvent, MessageSummary } from '@kuvert/shared';
import { desktop } from '@/lib/desktop';
import { useServerEvent } from '@/lib/events';
import { useAccountMap, useSettings } from '@/lib/queries';
import { displayAddress } from '@/lib/utils';
import { playBeep, pushActiveHere, showSystemNotification } from './push';
import { messageUrl } from '@/features/mail/links';

const TITLE_PREFIX = /^\(\d+\)\s*/;

/** Kuvert im Hintergrund? In der Desktop-App zählt auch ein Fenster ohne Fokus (hinter anderen Programmen) –
 *  dort zeigt der Titelzähler den roten Punkt im Infobereich, und Hinweise kommen als Systembenachrichtigung. */
const inBackground = () => document.hidden || (!!desktop && !document.hasFocus());

function mailUrl(accountId: string, m: MessageSummary): string {
  return messageUrl({ accountId, folderId: m.folderId, id: m.id });
}

function eventTime(ev: CalendarEvent): string {
  const start = new Date(ev.start);
  if (Number.isNaN(start.getTime())) return '';
  if (ev.allDay) return 'Ganztägig';
  return start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

export function NotificationService() {
  const { settings } = useSettings();
  const accounts = useAccountMap();
  const navigate = useNavigate();
  const unseen = useRef(0);

  // Titelzähler zurücksetzen, sobald der Tab wieder sichtbar ist (Desktop-App: das Fenster den Fokus bekommt)
  useEffect(() => {
    const onVis = () => {
      if (!inBackground()) {
        unseen.current = 0;
        document.title = document.title.replace(TITLE_PREFIX, '');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  /** Systembenachrichtigung – bei verborgenem Tab nicht, wenn auf diesem Gerät Web Push aktiv ist
   *  (dann zeigt der Service Worker die Push-Nachricht des Servers an, sonst gäbe es sie doppelt) */
  const desktop = async (title: string, opts: NotificationOptions, url: string) => {
    if (!settings.notifications.desktop) return;
    if (document.hidden && (await pushActiveHere())) return;
    await showSystemNotification(title, opts, url, () => navigate(url));
  };

  useServerEvent('mail.new', (e) => {
    const acc = accounts.get(e.accountId);
    if (acc && acc.settings.notify === false) return;
    const msgs = e.messages.filter((m) => !m.seen);
    if (!msgs.length) return;

    if (inBackground()) {
      unseen.current += msgs.length;
      document.title = `(${unseen.current}) ${document.title.replace(TITLE_PREFIX, '')}`;
      if (msgs.length > 3) {
        void desktop(
          `${msgs.length} neue E-Mails${acc ? ` – ${acc.name}` : ''}`,
          {
            body: msgs
              .slice(0, 3)
              .map((m) => `${displayAddress(m.from) || 'Unbekannt'}: ${m.subject || '(kein Betreff)'}`)
              .join('\n'),
            tag: `mail-batch-${e.accountId}`,
          },
          '/mail',
        );
      } else {
        for (const m of msgs) {
          void desktop(displayAddress(m.from) || 'Neue E-Mail', { body: m.subject || '(kein Betreff)', tag: `mail-${m.id}` }, mailUrl(e.accountId, m));
        }
      }
      if (settings.notifications.sound) playBeep();
    } else {
      const first = msgs[0]!;
      toast(msgs.length > 1 ? `${msgs.length} neue E-Mails` : `Neue E-Mail von ${displayAddress(first.from) || 'Unbekannt'}`, {
        description: msgs.length > 1 ? acc?.name : first.subject || '(kein Betreff)',
        action: msgs.length === 1 ? { label: 'Öffnen', onClick: () => navigate(mailUrl(e.accountId, first)) } : undefined,
      });
    }
  });

  useServerEvent('calendar.reminder', (e) => {
    if (!settings.notifications.calendarReminders) return;
    const ev = e.event;
    const when = e.minutesBefore > 0 ? `in ${e.minutesBefore} Min.` : 'jetzt';
    const body = [`${eventTime(ev)} (${when})`, ev.location].filter(Boolean).join(' · ');
    void desktop(ev.title || 'Termin', { body, tag: `event-${ev.id}`, requireInteraction: true }, '/calendar');
    toast(ev.title || 'Termin', {
      description: body,
      duration: 15_000,
      action: ev.onlineMeetingUrl ? { label: 'Beitreten', onClick: () => window.open(ev.onlineMeetingUrl, '_blank', 'noopener') } : undefined,
    });
    if (settings.notifications.sound) playBeep();
  });

  useServerEvent('account.status', (e) => {
    if (e.status !== 'reauth') return;
    const acc = accounts.get(e.accountId);
    toast.error(`Konto „${acc?.name ?? 'Unbekannt'}" muss neu verbunden werden`, {
      description: e.message ?? undefined,
      duration: 20_000,
      action: { label: 'Einstellungen', onClick: () => navigate('/settings/accounts') },
    });
  });

  useServerEvent('send.status', (e) => {
    if (e.status === 'failed') {
      toast.error(`Versand fehlgeschlagen${e.subject ? `: „${e.subject}"` : ''}`, {
        description: e.error ?? undefined,
        duration: 20_000,
        action: { label: 'Details', onClick: () => navigate('/settings/scheduled') },
      });
    }
  });

  return null;
}
