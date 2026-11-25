/**
 * mailto:-Links (RFC 6068): in Verfassen-Daten umwandeln und Kuvert im Browser
 * als Programm für E-Mail-Links anmelden.
 *
 * Der Browser ruft dann /mail?mailto=<mailto-URL> auf. Beim Start wird der
 * Parameter abgeholt, aus der Adresse entfernt und bis zur Anmeldung im
 * sessionStorage gehalten; der ComposerHost öffnet daraus eine neue Nachricht.
 * Als installierte App (PWA) landen weitere Links über die launchQueue im
 * bereits offenen Fenster statt in einem neuen.
 */
import type { EmailAddress } from '@kuvert/shared';
import { parseAddressList, textToHtml } from '@/lib/utils';
import type { ComposeInit } from './compose-api';

export const MAILTO_PARAM = 'mailto';
const PENDING_KEY = 'kuvert.mailto';

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const addresses = (s: string): EmailAddress[] => parseAddressList(s).filter((a) => a.address.includes('@'));

/** Wandelt einen mailto:-Link in Verfassen-Daten um; null, wenn es keiner ist */
export function parseMailto(url: string): ComposeInit | null {
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return null;
  // „+" bleibt bei mailto: ein Pluszeichen (z. B. a+b@x.de) – nur %-Kodierung auflösen
  const to = addresses(decode(m[1] ?? ''));
  const cc: EmailAddress[] = [];
  const bcc: EmailAddress[] = [];
  let subject: string | undefined;
  let body: string | undefined;
  for (const pair of (m[2] ?? '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const key = decode(i < 0 ? pair : pair.slice(0, i)).toLowerCase();
    const value = i < 0 ? '' : decode(pair.slice(i + 1));
    if (key === 'to') to.push(...addresses(value));
    else if (key === 'cc') cc.push(...addresses(value));
    else if (key === 'bcc') bcc.push(...addresses(value));
    else if (key === 'subject') subject = value;
    else if (key === 'body') body = value;
  }
  return {
    to,
    cc,
    bcc,
    subject,
    html: body ? textToHtml(body.replace(/\r\n?/g, '\n')) : undefined,
  };
}

/** Verfassen-Daten zu einem einfachen Linksklick auf einen mailto:-Link, sonst null */
export function mailtoFromClick(e: MouseEvent): ComposeInit | null {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]');
  // Links im Editor (Verfassen) bleiben bearbeitbar
  if (!a || a.closest('[contenteditable]:not([contenteditable="false"])')) return null;
  return parseMailto(a.getAttribute('href') ?? '');
}

/* ───────────── Aufruf über den Protokoll-Handler ───────────── */

let memoryPending: string | null = null;
/** Beim Start aus der Adresse übernommener Link (für den Abgleich mit der launchQueue) */
let initialRaw: string | null = null;

/**
 * Früh beim Start aufrufen (vor dem Router): ?mailto=… aus der Adresse holen,
 * merken und entfernen, damit ein Neuladen nicht erneut eine Nachricht öffnet.
 */
export function captureMailtoLaunch() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(MAILTO_PARAM);
  if (!raw) return;
  params.delete(MAILTO_PARAM);
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  initialRaw = raw;
  memoryPending = raw;
  try {
    sessionStorage.setItem(PENDING_KEY, raw);
  } catch {
    /* dann nur im Speicher */
  }
}

/** Noch nicht geöffneten mailto:-Link einmalig abholen */
export function takePendingMailto(): ComposeInit | null {
  let raw = memoryPending;
  try {
    raw = sessionStorage.getItem(PENDING_KEY) ?? raw;
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* egal */
  }
  memoryPending = null;
  return raw ? parseMailto(raw) : null;
}

interface LaunchQueue {
  setConsumer(fn: (p: { targetURL?: string }) => void): void;
}

/**
 * Installierte App: weitere mailto:-Links kommen über die launchQueue ins offene
 * Fenster (manifest: launch_handler focus-existing). Der Start-Link selbst wird
 * schon über captureMailtoLaunch() behandelt und hier übersprungen.
 */
export function onMailtoLaunch(fn: (init: ComposeInit) => void) {
  (window as unknown as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer((p) => {
    if (!p.targetURL) return;
    let raw: string | null = null;
    try {
      raw = new URL(p.targetURL).searchParams.get(MAILTO_PARAM);
    } catch {
      return;
    }
    if (!raw) return;
    if (raw === initialRaw) {
      initialRaw = null;
      return;
    }
    const init = parseMailto(raw);
    if (init) fn(init);
  });
}

/* ───────────── Anmeldung im Browser ───────────── */

export function canRegisterMailtoHandler(): boolean {
  return typeof navigator !== 'undefined' && 'registerProtocolHandler' in navigator && window.isSecureContext;
}

/** Bittet den Browser, Kuvert für mailto:-Links zu verwenden (der Browser fragt selbst nach) */
export function registerMailtoHandler() {
  navigator.registerProtocolHandler('mailto', `${window.location.origin}/mail?${MAILTO_PARAM}=%s`);
}
