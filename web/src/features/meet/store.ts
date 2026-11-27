/**
 * Zustand des eigenen Kuvert-Anrufs (höchstens einer gleichzeitig): wird beim Beitreten gesetzt,
 * von <CallHost> angezeigt und beim Auflegen geleert. Bewusst außerhalb von React Query,
 * damit Chat und Anruf-Fenster ohne Umwege darauf zugreifen.
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { MeetJoinResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';

export interface ActiveCall extends MeetJoinResult {
  /** Mit Kamera beitreten */
  video: boolean;
  /** Klein in der Ecke statt im Vollbild */
  minimized: boolean;
  /** Whiteboard geöffnet */
  whiteboard: boolean;
  /** Jemand anderes war schon im Anruf (sonst endet er mit „Keine Antwort“) */
  othersJoined: boolean;
  joinedAt: number;
}

let state: ActiveCall | null = null;
/** Beitritt läuft (Doppelklicks abfangen) */
let joining: string | null = null;
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

/** Anruf in einer Kuvert-Unterhaltung starten oder beitreten */
export async function joinCall(conversationId: string, opts: { video?: boolean } = {}): Promise<void> {
  if (state?.conversationId === conversationId) {
    callState.patch({ minimized: false });
    return;
  }
  if (joining) return;
  if (state) {
    toast.error('Du bist bereits in einem Anruf – bitte zuerst auflegen.');
    return;
  }
  joining = conversationId;
  try {
    const r = await api<MeetJoinResult>(`/meet/calls/${encodeURIComponent(conversationId)}/join`, { method: 'POST' });
    set({ ...r, video: !!opts.video, minimized: false, whiteboard: false, othersJoined: false, joinedAt: Date.now() });
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    joining = null;
  }
}

/** Auflegen (lokal sofort, Server im Hintergrund) */
export function leaveCall() {
  const c = state;
  if (!c) return;
  set(null);
  void api(`/meet/calls/${encodeURIComponent(c.conversationId)}/leave`, { method: 'POST' }).catch(() => undefined);
}

/** Klingeln ablehnen */
export function declineCall(conversationId: string) {
  void api(`/meet/calls/${encodeURIComponent(conversationId)}/decline`, { method: 'POST' }).catch(() => undefined);
}

/** Beim Schließen des Fensters abmelden, damit die anderen nicht auf das Abgleich-Intervall warten */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!state) return;
    try {
      // sendBeacon kann keine eigenen Header – fetch mit keepalive schon (CSRF-Header nötig)
      void fetch(`/api/meet/calls/${encodeURIComponent(state.conversationId)}/leave`, {
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
