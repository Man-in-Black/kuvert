/**
 * Zustand des eigenen Kuvert-Anrufs (höchstens einer gleichzeitig): wird beim Beitreten gesetzt,
 * von <CallHost> bzw. der Gastseite angezeigt und beim Auflegen geleert. Bewusst außerhalb von
 * React Query, damit Chat, Kalender und Anruf-Fenster ohne Umwege darauf zugreifen.
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { MeetJoinResult, MeetMeeting } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';

export interface ActiveCall extends MeetJoinResult {
  /** Mit Kamera beitreten */
  video: boolean;
  /** Klein in der Ecke statt im Vollbild */
  minimized: boolean;
  /** Whiteboard geöffnet */
  whiteboard: boolean;
  /** Einladen-Bereich (Personen, Gäste, Wartebereich) geöffnet */
  people: boolean;
  /** Jemand anderes war schon im Anruf (sonst endet er mit „Keine Antwort“) */
  othersJoined: boolean;
  joinedAt: number;
}

let state: ActiveCall | null = null;
/** Beitritt läuft (Doppelklicks abfangen) */
let joining = false;
const listeners = new Set<() => void>();

function set(next: ActiveCall | null) {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useActiveCall(): ActiveCall | null {
  return useSyncExternalStore(subscribe, () => state);
}

export const callState = {
  get: () => state,
  patch(p: Partial<ActiveCall>) {
    if (state) set({ ...state, ...p });
  },
};

/** Zugang übernehmen und Anruf-Fenster öffnen */
export function startCall(r: MeetJoinResult, opts: { video?: boolean } = {}) {
  set({ ...r, video: !!opts.video, minimized: false, whiteboard: false, people: false, othersJoined: false, joinedAt: Date.now() });
}

async function join(path: string, opts: { video?: boolean }, sameCall: (c: ActiveCall) => boolean): Promise<boolean> {
  if (state && sameCall(state)) {
    callState.patch({ minimized: false });
    return true;
  }
  if (joining) return false;
  if (state) {
    toast.error('Du bist bereits in einem Anruf – bitte zuerst auflegen.');
    return false;
  }
  joining = true;
  try {
    startCall(await api<MeetJoinResult>(path, { method: 'POST' }), opts);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  } finally {
    joining = false;
  }
}

/** Anruf in einer Kuvert-Unterhaltung starten oder beitreten */
export function joinCall(conversationId: string, opts: { video?: boolean } = {}): Promise<boolean> {
  return join(`/meet/calls/${encodeURIComponent(conversationId)}/join`, opts, (c) => c.conversationId === conversationId);
}

/** Laufendem Anruf beitreten, in den man geholt wurde */
export function joinCallById(callId: string, opts: { video?: boolean } = {}): Promise<boolean> {
  return join(`/meet/c/${encodeURIComponent(callId)}/join`, opts, (c) => c.callId === callId);
}

/** Über einen Einladungs- bzw. Meeting-Link beitreten (angemeldet) */
export function joinByLink(token: string, opts: { video?: boolean } = {}): Promise<boolean> {
  return join(`/meet/links/${encodeURIComponent(token)}/join`, opts, () => false);
}

/**
 * Spontanmeeting: Meeting mit eigenem Link anlegen (ohne Termin, verfällt nach einigen Tagen),
 * sofort beitreten und den Einladen-Bereich öffnen – dort Gast-Link kopieren oder Kollegen dazuholen.
 */
export async function startAdhocMeeting(opts: { video?: boolean } = {}): Promise<void> {
  if (state) {
    toast.error('Du bist bereits in einem Anruf – bitte zuerst auflegen.');
    return;
  }
  let meeting: MeetMeeting;
  try {
    meeting = await api<MeetMeeting>('/meet/meetings', { method: 'POST', body: { adhoc: true } });
  } catch (err) {
    toast.error(errorMessage(err));
    return;
  }
  const token = meeting.url.split('/join/')[1] ?? '';
  if (await joinByLink(token, opts)) {
    callState.patch({ people: true });
    toast.success('Spontanmeeting gestartet', { description: 'Rechts unter „Personen“ Kollegen dazuholen oder den Gast-Link kopieren.' });
  }
}

/** Auflegen (lokal sofort, Server im Hintergrund) */
export function leaveCall() {
  const c = state;
  if (!c) return;
  set(null);
  void api(c.leavePath, { method: 'POST' }).catch(() => undefined);
}

/** Anruf für alle beenden (nur wer ihn gestartet hat) */
export async function endCallForAll(): Promise<void> {
  const c = state;
  if (!c) return;
  try {
    await api(`/meet/c/${encodeURIComponent(c.callId)}/end`, { method: 'POST' });
    if (state?.callId === c.callId) set(null);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** Klingeln ablehnen */
export function declineCall(conversationId: string) {
  void api(`/meet/calls/${encodeURIComponent(conversationId)}/decline`, { method: 'POST' }).catch(() => undefined);
}

/** Einladung („Person hinzufügen“) ablehnen */
export function declineInvite(callId: string) {
  void api(`/meet/c/${encodeURIComponent(callId)}/decline-invite`, { method: 'POST' }).catch(() => undefined);
}

/** Beim Schließen des Fensters abmelden, damit die anderen nicht auf das Abgleich-Intervall warten */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!state) return;
    try {
      // sendBeacon kann keine eigenen Header – fetch mit keepalive schon (CSRF-Header nötig)
      void fetch(`/api${state.leavePath}`, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'kuvert' },
      });
    } catch {
      /* egal */
    }
  });
}
