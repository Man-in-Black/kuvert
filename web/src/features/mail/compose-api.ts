/**
 * Öffentliche Schnittstelle, um aus beliebigen Bereichen (Kontakte, Dateien,
 * Kalender …) das Verfassen-Fenster zu öffnen – ohne direkte Abhängigkeit
 * auf die Mail-Komponenten. Der Mail-Bereich lauscht auf das Ereignis.
 */
import type { EmailAddress, OutgoingAttachment } from '@kuvert/shared';

export interface ComposeInit {
  accountId?: string;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  /** HTML-Inhalt (Signatur wird automatisch ergänzt) */
  html?: string;
  /** Bereits hochgeladene Anhänge (uploadId) */
  attachments?: OutgoingAttachment[];
}

export const COMPOSE_EVENT = 'kuvert:compose';

export function openCompose(init: ComposeInit = {}) {
  window.dispatchEvent(new CustomEvent<ComposeInit>(COMPOSE_EVENT, { detail: init }));
}

export function onComposeRequest(fn: (init: ComposeInit) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<ComposeInit>).detail ?? {});
  window.addEventListener(COMPOSE_EVENT, handler);
  return () => window.removeEventListener(COMPOSE_EVENT, handler);
}
