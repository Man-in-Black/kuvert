/**
 * Angaben zu einer Mail, aus der eine Aufgabe oder ein Termin entsteht
 * (Verweis, Link zurück in Kuvert, Textauszug).
 */
import type { MessageDetail, TaskMailRef } from '@kuvert/shared';
import { messageUrl } from './links';
import { htmlToPlain } from './sanitize';

export interface MailSource {
  ref: TaskMailRef;
  /** Absoluter Link, der die Mail in Kuvert öffnet */
  url: string;
  /** „Name <adresse>“ bzw. nur die Adresse */
  fromLabel: string;
  subject: string;
  /** Klartext der Mail (gekürzt) */
  excerpt: (max: number) => string;
}

export function mailSource(accountId: string, folderId: string, message: MessageDetail): MailSource {
  const from = message.from;
  const fromLabel = from ? (from.name && from.name !== from.address ? `${from.name} <${from.address}>` : from.address) : '';
  const subject = message.subject?.trim() || '(Kein Betreff)';
  return {
    ref: { accountId, folderId, messageId: message.id, subject, from: fromLabel || undefined },
    url: `${window.location.origin}${messageUrl({ accountId, folderId, id: message.id })}`,
    fromLabel,
    subject,
    excerpt: (max) => {
      const body = (message.text || (message.html ? htmlToPlain(message.html) : '')).replace(/\n{3,}/g, '\n\n').trim();
      return body.length > max ? `${body.slice(0, max).trimEnd()} …` : body;
    },
  };
}

/** Betreff ohne „AW:“, „Re:“, „WG:“, „Fwd:“ … */
export function cleanSubject(subject: string): string {
  return subject.replace(/^\s*((re|aw|wg|fw|fwd|antw|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '').trim() || subject;
}
