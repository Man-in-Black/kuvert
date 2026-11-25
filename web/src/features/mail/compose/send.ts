/**
 * Versand inkl. "Rückgängig"-Toast und Wiederherstellung abgebrochener Nachrichten.
 */
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import type { OutgoingMessage, SendResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { openComposer, type ComposerAttachment, type ComposerInit } from './store';
import { handOverSend } from './window';

/** Von diesem Tab ausgelöste Versandaufträge (für SSE-Rückmeldungen) */
export const pendingJobs = new Map<string, { accountId: string; subject: string }>();

let keyCounter = 0;
const akey = () => `a${Date.now()}-${keyCounter++}`;

/** Inline-Anhänge (cid) wieder in den Editor zurückführen */
export function restoreInit(accountId: string, message: OutgoingMessage): ComposerInit {
  let html = message.html ?? '';
  const attachments: ComposerAttachment[] = [];
  for (const a of message.attachments ?? []) {
    if (a.inline && a.contentId && html.includes(`cid:${a.contentId}`)) {
      const src = a.uploadId ? `/api/uploads/${a.uploadId}?inline=1` : a.contentBase64 ? `data:${a.contentType ?? 'image/png'};base64,${a.contentBase64}` : '';
      if (src) {
        html = html.split(`cid:${a.contentId}`).join(src);
        continue;
      }
    }
    attachments.push({ ...a, key: akey() });
  }
  return {
    mode: 'new',
    accountId,
    identityAddress: message.from?.address,
    message: { ...message, html, attachments: undefined, sendAt: undefined },
    attachments,
    skipSignature: true,
  };
}

/** Bis wann ein Verfassen-Popup nach dem Senden offen bleiben soll (eigener Rückgängig-Toast) */
let lingerUntil = 0;
export const lingerMs = () => Math.max(0, lingerUntil - Date.now());

export async function sendMessage(accountId: string, message: OutgoingMessage, undoSeconds: number): Promise<SendResult> {
  const res = await api<SendResult>(`/mail/accounts/${accountId}/send`, { method: 'POST', body: { message } });
  const subject = message.subject || '(ohne Betreff)';
  // Im Popup übernimmt das Hauptfenster die Meldung, weil sich das Popup gleich schließt
  if (!handOverSend(accountId, subject, res)) announceSend(accountId, subject, res);
  return res;
}

/** Rückmeldung zum Versand: Erfolg, „Rückgängig“-Toast oder geplanter Zeitpunkt */
export function announceSend(accountId: string, subject: string, res: SendResult) {
  lingerUntil = Math.max(lingerUntil, Date.now() + 2500);
  if (res.status === 'sent') {
    toast.success(`„${subject}“ gesendet`);
    return;
  }
  if (res.jobId) pendingJobs.set(res.jobId, { accountId, subject });
  const sendAt = res.sendAt ? new Date(res.sendAt) : new Date();
  const soon = sendAt.getTime() - Date.now() < 65_000;
  if (soon && res.jobId) {
    lingerUntil = Math.max(lingerUntil, sendAt.getTime() + 500);
    const jobId = res.jobId;
    toast('Nachricht wird gesendet …', {
      description: subject,
      duration: Math.max(3000, sendAt.getTime() - Date.now()),
      action: {
        label: 'Rückgängig',
        onClick: async () => {
          try {
            const r = await api<{ message: OutgoingMessage }>(`/mail/scheduled/${jobId}/cancel`, { method: 'POST' });
            pendingJobs.delete(jobId);
            openComposer(restoreInit(accountId, r.message));
            toast.info('Versand abgebrochen');
          } catch (err) {
            toast.error(`Rückgängig nicht mehr möglich: ${errorMessage(err)}`);
          }
        },
      },
    });
  } else {
    toast.success(`Geplant für ${format(sendAt, "EEEE, d. MMMM 'um' HH:mm", { locale: de })}`, { description: subject });
  }
}

export async function retryJob(jobId: string) {
  try {
    await api(`/mail/scheduled/${jobId}/retry`, { method: 'POST' });
    toast.info('Versand wird erneut versucht');
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export async function cancelJob(jobId: string): Promise<OutgoingMessage | undefined> {
  try {
    const r = await api<{ message: OutgoingMessage }>(`/mail/scheduled/${jobId}/cancel`, { method: 'POST' });
    pendingJobs.delete(jobId);
    return r.message;
  } catch (err) {
    toast.error(errorMessage(err));
    return undefined;
  }
}
