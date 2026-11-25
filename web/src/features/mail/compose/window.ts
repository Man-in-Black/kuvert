/**
 * Verfassen in einem eigenen Browserfenster (Popup).
 *
 * Das Hauptfenster legt die Startdaten (ComposerInit) unter einer ID ab und
 * öffnet /window/compose?id=…; das Popup holt sie über window.opener ab.
 * Weil sich das Popup nach dem Senden schließt, reicht es die Versandmeldung
 * (inkl. „Rückgängig") und Listen-Aktualisierungen an das Hauptfenster weiter.
 */
import type { SendResult } from '@kuvert/shared';
import type { ComposerInit } from './store';

export const COMPOSE_WINDOW_PATH = '/window/compose';
const GEOMETRY_KEY = 'kuvert.composeWindow.geometry';
const DEFAULT_SIZE = { w: 860, h: 780 };

/** Schnittstelle, die das Hauptfenster seinen Verfassen-Popups bereitstellt */
export interface ComposeBridge {
  /** Startdaten (JSON) abholen */
  take(id: string): string | undefined;
  /** Versandergebnis melden (JSON: { accountId, subject, res }) */
  announce(json: string): void;
  /** Mail-Listen neu laden (z. B. nach dem Speichern eines Entwurfs) */
  mailChanged(): void;
}

declare global {
  interface Window {
    kuvertCompose?: ComposeBridge;
  }
}

/* ───────────── Hauptfenster ───────────── */

const pending = new Map<string, string>();

/** Vom Popup aufgerufen (über die Bridge): Startdaten einmalig herausgeben */
export function takePendingInit(id: string): string | undefined {
  const v = pending.get(id);
  pending.delete(id);
  return v;
}

function storedGeometry(): { w: number; h: number; x?: number; y?: number } {
  try {
    const g = JSON.parse(localStorage.getItem(GEOMETRY_KEY) ?? 'null') as { w?: number; h?: number; x?: number; y?: number } | null;
    if (g && g.w && g.h && g.w >= 400 && g.h >= 300) return { w: g.w, h: g.h, x: g.x, y: g.y };
  } catch {
    /* egal */
  }
  return DEFAULT_SIZE;
}

/** Öffnet ein Verfassen-Popup; false, wenn der Browser es blockiert hat */
export function openComposeWindow(init: ComposerInit): boolean {
  const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const g = storedGeometry();
  const w = Math.min(g.w, window.screen.availWidth);
  const h = Math.min(g.h, window.screen.availHeight);
  const left = g.x ?? Math.round(window.screenX + Math.max(0, (window.outerWidth - w) / 2));
  const top = g.y ?? Math.round(window.screenY + Math.max(0, (window.outerHeight - h) / 2));

  pending.set(id, JSON.stringify(init));
  let win: Window | null = null;
  try {
    win = window.open(`${COMPOSE_WINDOW_PATH}?id=${id}`, `kuvert-compose-${id}`, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  } catch {
    win = null;
  }
  if (!win) {
    pending.delete(id);
    return false;
  }
  // Falls das Popup nie lädt (sofort geschlossen), nicht ewig festhalten
  setTimeout(() => pending.delete(id), 10 * 60_000);
  return true;
}

/* ───────────── Popup ───────────── */

export function isComposeWindow(): boolean {
  return typeof window !== 'undefined' && window.location.pathname === COMPOSE_WINDOW_PATH;
}

function bridge(): ComposeBridge | null {
  try {
    const o = window.opener as Window | null;
    return o && !o.closed && o.kuvertCompose ? o.kuvertCompose : null;
  } catch {
    return null;
  }
}

/**
 * Startdaten des Popups. Werden zusätzlich im sessionStorage abgelegt,
 * damit ein Neuladen des Fensters nicht ins Leere läuft.
 */
export function readWindowInit(): ComposerInit | null {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) return null;
  const cacheKey = `kuvert.composeWindow.init.${id}`;
  let json: string | null | undefined = null;
  try {
    json = sessionStorage.getItem(cacheKey);
  } catch {
    /* egal */
  }
  if (!json) {
    try {
      json = bridge()?.take(id);
    } catch {
      json = null;
    }
    if (json)
      try {
        sessionStorage.setItem(cacheKey, json);
      } catch {
        /* zu groß o. Ä. – dann eben ohne Wiederherstellung */
      }
  }
  if (!json) return null;
  try {
    return JSON.parse(json) as ComposerInit;
  } catch {
    return null;
  }
}

/** Im Popup: Versandmeldung an das Hauptfenster übergeben (true = erledigt) */
export function handOverSend(accountId: string, subject: string, res: SendResult): boolean {
  if (!isComposeWindow()) return false;
  const b = bridge();
  if (!b) return false;
  try {
    b.announce(JSON.stringify({ accountId, subject, res }));
    return true;
  } catch {
    return false;
  }
}

/** Im Popup: Hauptfenster soll seine Mail-Listen neu laden */
export function notifyMailChanged() {
  if (!isComposeWindow()) return;
  try {
    bridge()?.mailChanged();
  } catch {
    /* egal */
  }
}

/** Im Popup: Größe und Position für das nächste Fenster merken */
export function rememberWindowGeometry() {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify({ w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY }));
  } catch {
    /* egal */
  }
}
