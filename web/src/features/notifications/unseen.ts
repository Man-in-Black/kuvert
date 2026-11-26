/**
 * Zähler für Neues, das im Hintergrund ankam (Mails, Chats, Termine …): steht als „(3) “ vor dem
 * Fenstertitel. Die Desktop-App liest ihn aus dem Titel und zeigt daraus den roten Punkt im
 * Infobereich. Sobald Kuvert wieder vorn ist, wird er zurückgesetzt.
 *
 * Welche Arten mitzählen, stellt jedes Gerät selbst ein (Einstellungen → Benachrichtigungen);
 * Module mit eigenen Arten melden sie über registerUnseenCategory() an.
 */
import { useSyncExternalStore } from 'react';
import { desktop } from '@/lib/desktop';

export interface UnseenCategory {
  id: string;
  label: string;
  /** Nur anzeigen, wenn dieses Feature aktiv ist */
  feature?: string;
  order: number;
}

const categories: UnseenCategory[] = [
  { id: 'mail', label: 'Neue E-Mails', order: 10 },
  { id: 'chat', label: 'Chat-Nachrichten', order: 20 },
  { id: 'calendar', label: 'Terminerinnerungen', order: 30 },
];

export function registerUnseenCategory(c: UnseenCategory) {
  if (!categories.some((x) => x.id === c.id)) categories.push(c);
}

export const unseenCategories = (): UnseenCategory[] => [...categories].sort((a, b) => a.order - b.order);

/* ───────────── Einstellung je Gerät: abgeschaltete Arten ───────────── */

const OFF_KEY = 'kuvert.unseen.off';
const listeners = new Set<() => void>();

function loadOff(): string[] {
  try {
    const raw = localStorage.getItem(OFF_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let off: string[] = loadOff();

export const unseenEnabled = (id: string) => !off.includes(id);

export function setUnseenEnabled(id: string, on: boolean) {
  off = on ? off.filter((x) => x !== id) : [...new Set([...off, id])];
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify(off));
  } catch {
    /* dann nur bis zum Neuladen */
  }
  listeners.forEach((l) => l());
}

/** Abgeschaltete Arten (für die Einstellungen) */
export function useUnseenOff(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => off,
  );
}

/* ───────────── Zähler ───────────── */

const TITLE_PREFIX = /^\(\d+\)\s*/;
let unseen = 0;

/** Kuvert im Hintergrund? In der Desktop-App zählt auch ein Fenster ohne Fokus (hinter anderen Programmen). */
export const inBackground = () => document.hidden || (!!desktop && !document.hasFocus());

/** `n` neue Dinge der Art `category` – nur wirksam, solange Kuvert im Hintergrund ist und die Art mitzählt */
export function bumpUnseen(category: string, n = 1) {
  if (n <= 0 || !inBackground() || !unseenEnabled(category)) return;
  unseen += n;
  document.title = `(${unseen}) ${document.title.replace(TITLE_PREFIX, '')}`;
}

function reset() {
  if (inBackground() || !unseen) return;
  unseen = 0;
  document.title = document.title.replace(TITLE_PREFIX, '');
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('focus', reset);
}
