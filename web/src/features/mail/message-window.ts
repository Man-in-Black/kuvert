/**
 * Nachrichten und Unterhaltungen in einem eigenen Browserfenster lesen
 * (/window/mail?m=<ref>[&c=<id>]).
 *
 * Bei Unterhaltungen legt das Hauptfenster die Nachrichten der Listenzeile kurz im
 * localStorage ab; das Fenster übernimmt sie (und merkt sie sich im sessionStorage,
 * damit Neuladen funktioniert). Fehlen sie, lädt das Fenster die Unterhaltung
 * ausgehend von der Nachricht selbst nach.
 */
import type { FolderRole, MessageSummary } from '@kuvert/shared';
import { encodeMessageRef, type MessageLinkRef } from './links';

export const MESSAGE_WINDOW_PATH = '/window/mail';
const GEOMETRY_KEY = 'kuvert.messageWindow.geometry';
const HANDOVER_PREFIX = 'kuvert.messageWindow.conv.';
const HANDOVER_TTL = 10 * 60_000;
const DEFAULT_SIZE = { w: 920, h: 820 };

function storedGeometry(): { w: number; h: number; x?: number; y?: number } {
  try {
    const g = JSON.parse(localStorage.getItem(GEOMETRY_KEY) ?? 'null') as { w?: number; h?: number; x?: number; y?: number } | null;
    if (g && g.w && g.h && g.w >= 400 && g.h >= 300) return { w: g.w, h: g.h, x: g.x, y: g.y };
  } catch {
    /* egal */
  }
  return DEFAULT_SIZE;
}

/** Alte, nie abgeholte Übergaben aufräumen */
function cleanupHandovers() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(HANDOVER_PREFIX)) continue;
      const at = Number((JSON.parse(localStorage.getItem(k) ?? '{}') as { at?: number }).at);
      if (!at || now - at > HANDOVER_TTL) localStorage.removeItem(k);
    }
  } catch {
    /* egal */
  }
}

export interface MessageWindowOptions {
  /** Ganze Unterhaltung zeigen – mit den Nachrichten der Listenzeile */
  conversation?: MessageSummary[];
  /** Rolle des Ordners (Entwürfe, Papierkorb …), solange das Fenster sie nicht selbst kennt */
  folderRole?: FolderRole;
}

/**
 * Öffnet eine Nachricht (bzw. Unterhaltung) in einem eigenen Fenster. Dieselbe
 * Nachricht noch einmal öffnen holt das vorhandene Fenster nach vorn.
 * Liefert false, wenn der Browser das Fenster blockiert hat.
 */
export function openMessageWindow(ref: MessageLinkRef, opts: MessageWindowOptions = {}): boolean {
  const enc = encodeMessageRef(ref);
  const qs = new URLSearchParams({ m: enc });
  if (opts.folderRole) qs.set('role', opts.folderRole);

  let handoverKey: string | undefined;
  if (opts.conversation) {
    cleanupHandovers();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    qs.set('c', id);
    handoverKey = HANDOVER_PREFIX + id;
    try {
      localStorage.setItem(handoverKey, JSON.stringify({ at: Date.now(), messages: opts.conversation }));
    } catch {
      /* zu groß o. Ä. – das Fenster lädt die Unterhaltung dann selbst */
    }
  }

  const g = storedGeometry();
  const w = Math.min(g.w, window.screen.availWidth);
  const h = Math.min(g.h, window.screen.availHeight);
  const left = g.x ?? Math.round(window.screenX + Math.max(0, (window.outerWidth - w) / 2));
  const top = g.y ?? Math.round(window.screenY + Math.max(0, (window.outerHeight - h) / 2));

  let win: Window | null = null;
  try {
    win = window.open(
      `${MESSAGE_WINDOW_PATH}?${qs.toString()}`,
      `kuvert-mail-${opts.conversation ? 'c' : 'm'}-${enc}`,
      `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
    );
  } catch {
    win = null;
  }
  if (!win) {
    if (handoverKey)
      try {
        localStorage.removeItem(handoverKey);
      } catch {
        /* egal */
      }
    return false;
  }
  try {
    win.focus();
  } catch {
    /* egal */
  }
  return true;
}

/* ───────────── Im Fenster ───────────── */

/** Vom Hauptfenster übergebene Nachrichten der Unterhaltung (null = keine Übergabe) */
export function takeConversationHandover(id: string): MessageSummary[] | null {
  const cacheKey = `${HANDOVER_PREFIX}${id}`;
  let json: string | null = null;
  try {
    json = sessionStorage.getItem(cacheKey);
  } catch {
    /* egal */
  }
  if (!json) {
    try {
      json = localStorage.getItem(cacheKey);
      localStorage.removeItem(cacheKey);
    } catch {
      json = null;
    }
    if (json)
      try {
        sessionStorage.setItem(cacheKey, json);
      } catch {
        /* dann eben ohne Wiederherstellung beim Neuladen */
      }
  }
  if (!json) return null;
  try {
    const msgs = (JSON.parse(json) as { messages?: MessageSummary[] }).messages;
    return Array.isArray(msgs) && msgs.length ? msgs : null;
  } catch {
    return null;
  }
}

/** Größe und Position für das nächste Lesefenster merken */
export function rememberMessageWindowGeometry() {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify({ w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY }));
  } catch {
    /* egal */
  }
}
