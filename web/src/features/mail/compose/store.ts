/**
 * Globaler Zustand der geöffneten Verfassen-Fenster (mehrere Entwürfe möglich).
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { AttachmentInfo, MessageDetail, OutgoingAttachment, OutgoingMessage, UserSettings } from '@kuvert/shared';
import type { MessageRef } from '../api';
import { isComposeWindow, openComposeWindow } from './window';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'edit';

export interface ComposerAttachment extends OutgoingAttachment {
  key: string;
  size?: number;
  /** 0–100 während des Uploads */
  progress?: number;
  error?: string;
}

export interface ComposerInit {
  mode: ComposeMode;
  accountId?: string;
  /** Bevorzugte Absenderadresse */
  identityAddress?: string;
  message?: Partial<OutgoingMessage>;
  /** Zitierter Originaltext (außerhalb des Editors, wird beim Senden angehängt) */
  quoteHtml?: string;
  original?: MessageDetail;
  originalRef?: MessageRef;
  /** Anhänge der Originalnachricht, die übernommen werden sollen */
  copyAttachments?: { ref: MessageRef; attachments: AttachmentInfo[] };
  /** Bereits vorhandene Anhänge (Upload-IDs) */
  attachments?: ComposerAttachment[];
  draftRef?: { folderId: string; messageId: string };
  /** Keine Standardsignatur einfügen (z. B. wiederhergestellte Nachricht) */
  skipSignature?: boolean;
  /** Bereits gewählte Signatur übernehmen (Wechsel ins eigene Fenster) */
  signature?: { id: string | null; raw: string | null; manual: boolean };
  /** Im Nur-Text-Modus öffnen */
  plainText?: boolean;
  /** Inhalt enthält ungespeicherte Änderungen */
  dirty?: boolean;
}

export interface ComposerEntry {
  key: string;
  init: ComposerInit;
  minimized: boolean;
  title: string;
}

let entries: ComposerEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let counter = 0;

/** Bevorzugte Darstellung (aus den Benutzereinstellungen, vom ComposerHost gesetzt) */
let preferWindow = false;
export function setComposerPreference(mode: UserSettings['composeWindow']) {
  preferWindow = mode === 'popup';
}

const smallScreen = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

/**
 * Öffnet ein Verfassen-Fenster – je nach Einstellung im Hauptfenster oder als
 * eigenes Browserfenster. Liefert den Schlüssel bzw. null beim Popup.
 * `inline` erzwingt das Hauptfenster (z. B. ohne Benutzeraktion, wo Popups blockiert würden).
 */
export function openComposer(init: ComposerInit, opts: { inline?: boolean } = {}): string | null {
  if (preferWindow && !opts.inline && !isComposeWindow() && !smallScreen()) {
    if (openComposeWindow(init)) return null;
    toast.warning('Eigenes Fenster wurde vom Browser blockiert', {
      description: 'Bitte Popups für Kuvert erlauben. Die Nachricht wird im Hauptfenster geöffnet.',
    });
  }
  const key = `c${Date.now()}-${counter++}`;
  entries = [
    ...entries.map((e) => ({ ...e, minimized: true })),
    { key, init, minimized: false, title: init.message?.subject || 'Neue Nachricht' },
  ];
  emit();
  return key;
}

export function closeComposer(key: string) {
  entries = entries.filter((e) => e.key !== key);
  emit();
}

export function setComposerMinimized(key: string, minimized: boolean) {
  entries = entries.map((e) => (e.key === key ? { ...e, minimized } : minimized ? e : { ...e, minimized: true }));
  emit();
}

export function setComposerTitle(key: string, title: string) {
  const e = entries.find((x) => x.key === key);
  if (!e || e.title === title) return;
  entries = entries.map((x) => (x.key === key ? { ...x, title } : x));
  emit();
}

export function getComposers(): ComposerEntry[] {
  return entries;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useComposers(): ComposerEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}

/* ───────────── Position und Größe (verschobenes Fenster) ───────────── */

export interface ComposerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const COMPOSER_MIN = { w: 440, h: 340 };
const RECT_KEY = 'kuvert.composer.rect';

function loadRect(): ComposerRect | null {
  try {
    const r = JSON.parse(localStorage.getItem(RECT_KEY) ?? 'null') as ComposerRect | null;
    return r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? r : null;
  } catch {
    return null;
  }
}

/** null = angedockt unten rechts (Standard) */
let rect: ComposerRect | null = loadRect();

export function getComposerRect(): ComposerRect | null {
  return rect;
}

export function setComposerRect(r: ComposerRect | null) {
  rect = r;
  try {
    if (r) localStorage.setItem(RECT_KEY, JSON.stringify(r));
    else localStorage.removeItem(RECT_KEY);
  } catch {
    /* egal */
  }
  emit();
}

export function useComposerRect(): ComposerRect | null {
  return useSyncExternalStore(subscribe, () => rect);
}

/** Vollständig im sichtbaren Bereich halten (Größe bleibt, sofern sie passt) */
export function clampRect(r: ComposerRect): ComposerRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.round(Math.min(Math.max(r.w, COMPOSER_MIN.w), vw));
  const h = Math.round(Math.min(Math.max(r.h, COMPOSER_MIN.h), vh));
  return {
    x: Math.round(Math.min(Math.max(r.x, 0), vw - w)),
    y: Math.round(Math.min(Math.max(r.y, 0), vh - h)),
    w,
    h,
  };
}
