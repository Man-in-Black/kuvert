/**
 * Nachrichten, die gerade (auf Wunsch des Benutzers) per KI-Triage eingeordnet werden –
 * für die „wird eingeordnet …“-Animation in Liste, Leseansicht und Unterhaltung.
 * Freigegeben wird per Ereignis "mail.triage", sobald die Warteschlange leer ist
 * (Fehlschlag/Stopp, siehe TriageService) oder spätestens nach MAX_AGE_MS.
 */
import { useSyncExternalStore } from 'react';
import type { MessageSummary, TriageRunResult } from '@kuvert/shared';
import { api } from '@/lib/api';
import { refKey, type MessageRef } from './api';

const MAX_AGE_MS = 10 * 60_000;

const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function markTriagePending(refs: MessageRef[]) {
  const now = Date.now();
  for (const r of refs) pending.set(refKey(r), now);
  if (refs.length) emit();
}

/** Ohne Argument: alle freigeben */
export function clearTriagePending(refs?: MessageRef[]) {
  if (!refs) {
    if (!pending.size) return;
    pending.clear();
  } else {
    let changed = false;
    for (const r of refs) changed = pending.delete(refKey(r)) || changed;
    if (!changed) return;
  }
  emit();
}

function isPending(r: Pick<MessageSummary, 'accountId' | 'folderId' | 'id'>): boolean {
  const started = pending.get(refKey(r));
  return started !== undefined && Date.now() - started < MAX_AGE_MS;
}

export const hasTriagePending = () => [...pending.values()].some((t) => Date.now() - t < MAX_AGE_MS);

/** Rendert neu, sobald sich die Menge der laufenden Einordnungen ändert */
export function useTriagePending() {
  useSyncExternalStore(subscribe, () => version);
  return {
    isPending,
    anyPending: (messages: Pick<MessageSummary, 'accountId' | 'folderId' | 'id'>[]) => messages.some(isPending),
    hasAny: hasTriagePending(),
  };
}

type TriageTarget = Pick<MessageSummary, 'accountId' | 'folderId' | 'id' | 'messageIdHeader'>;

/**
 * Nachrichten (neu) mit KI einordnen lassen und bis zum Ergebnis als „in Arbeit“ zeigen.
 * Bei einem Fehler endet die Animation sofort und der Fehler wird weitergereicht.
 */
export async function runTriageWithFeedback(messages: TriageTarget[]): Promise<TriageRunResult> {
  const targets = messages.map((m) => ({ accountId: m.accountId, folderId: m.folderId, id: m.id, messageIdHeader: m.messageIdHeader }));
  markTriagePending(targets);
  const total: TriageRunResult = { queued: 0, skipped: 0 };
  try {
    // Der Server nimmt höchstens 200 Nachrichten je Anfrage
    for (let i = 0; i < targets.length; i += 200) {
      const r = await api<TriageRunResult>('/triage/run-many', { method: 'POST', body: { items: targets.slice(i, i + 200) } });
      total.queued += r.queued;
      total.skipped += r.skipped;
    }
    return total;
  } catch (err) {
    clearTriagePending(targets);
    throw err;
  }
}
