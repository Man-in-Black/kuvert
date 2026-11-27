/**
 * Einladen-Bereich im Anruf (nur für Teilnehmende aus Kuvert): Wartebereich mit Zulassen/Ablehnen,
 * Gäste entfernen, weitere Kuvert-Benutzer dazuholen und den Gast-Link teilen.
 * Den Stand (Wartende, Gäste, Gast-Link) schickt der Server per Ereignis „meet.state“.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParticipants } from '@livekit/components-react';
import { toast } from 'sonner';
import { Copy, Link2, Link2Off, Search, UserMinus, UserPlus, X } from 'lucide-react';
import type { MeetCallState } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useServerEvent } from '@/lib/events';
import { useMe, useUserMap } from '@/features/chat/api';
import { playBeep } from '@/features/notifications/push';
import { callState, type ActiveCall } from './store';

const GUEST_PREFIX = 'guest:';

/** Stand des Anrufs für den Einladen-Bereich; meldet neue Anklopfende als Hinweis */
export function useMeetCallState(call: ActiveCall): MeetCallState | null {
  const [state, setState] = useState<MeetCallState | null>(null);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!call.canInvite) return;
    let cancelled = false;
    api<MeetCallState>(`/meet/c/${call.callId}/state`)
      .then((s) => !cancelled && setState((prev) => prev ?? s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [call.callId, call.canInvite]);

  useServerEvent('meet.state', (e) => {
    if (e.state.callId === call.callId) setState(e.state);
  });

  // Neue Anklopfende: Hinweis mit Zulassen/Ablehnen (auch bei geschlossenem Bereich bzw. kleinem Fenster)
  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.lobby.map((l) => l.id));
    const prev = known.current;
    known.current = ids;
    for (const id of prev ?? []) if (!ids.has(id)) toast.dismiss(`meet-lobby-${id}`);
    if (!prev && state.lobby.length === 0) return;
    for (const l of state.lobby) {
      if (prev?.has(l.id)) continue;
      playBeep();
      toast(`${l.name} möchte beitreten`, {
        id: `meet-lobby-${l.id}`,
        description: 'Gast ohne Kuvert-Konto',
        duration: Infinity,
        action: { label: 'Zulassen', onClick: () => void answer(l.id, true) },
        cancel: { label: 'Ablehnen', onClick: () => void answer(l.id, false) },
      });
    }
  }, [state]);

  // Beim Verlassen offene Hinweise schließen
  useEffect(
    () => () => {
      for (const id of known.current ?? []) toast.dismiss(`meet-lobby-${id}`);
    },
    [],
  );

  return state;
}

async function answer(requestId: string, admit: boolean) {
  try {
    await api(`/meet/lobby/${requestId}/${admit ? 'admit' : 'deny'}`, { method: 'POST' });
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function PeoplePanel({ call, state }: { call: ActiveCall; state: MeetCallState | null }) {
  const participants = useParticipants();
  const users = useUserMap();
  const me = useMe();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const inCall = new Set(participants.map((p) => p.identity));
  const invited = new Set(state?.invitedIds ?? []);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...users.values()]
      .filter((u) => u.id !== me && !u.disabled && !inCall.has(u.id) && !invited.has(u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, me, query, participants, state?.invitedIds]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const createLink = () => run('link', () => api(`/meet/c/${call.callId}/guest-link`, { method: 'POST' }));
  const revokeLink = () => run('revoke', () => api(`/meet/c/${call.callId}/guest-link`, { method: 'DELETE' }));
  const copyLink = async () => {
    if (!state?.guestLink) return;
    try {
      await navigator.clipboard.writeText(state.guestLink);
      toast.success('Link kopiert');
    } catch {
      toast.error('Kopieren nicht möglich – bitte den Link markieren und kopieren');
    }
  };

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-[#181b21] text-sm ring-1 ring-white/10 xl:w-80">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-semibold">Personen</span>
        <button
          type="button"
          onClick={() => callState.patch({ people: false })}
          className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
          title="Schließen"
          aria-label="Personen schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Wartebereich */}
        {!!state?.lobby.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-warning">Wartebereich</h3>
            <ul className="space-y-1.5">
              {state.lobby.map((l) => (
                <li key={l.id} className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    {l.name} <span className="text-white/50">(Gast)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void answer(l.id, true)}
                    className="rounded-md bg-success px-2 py-1 text-xs font-semibold text-white hover:brightness-110"
                  >
                    Zulassen
                  </button>
                  <button
                    type="button"
                    onClick={() => void answer(l.id, false)}
                    className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                  >
                    Ablehnen
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Im Anruf */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Im Anruf ({participants.length})</h3>
          <ul className="space-y-1">
            {participants.map((p) => {
              const guest = p.identity.startsWith(GUEST_PREFIX);
              return (
                <li key={p.identity} className="flex items-center gap-2 rounded-lg px-2 py-1">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name || p.identity}
                    {p.isLocal && <span className="text-white/50"> (du)</span>}
                  </span>
                  {guest && (
                    <button
                      type="button"
                      disabled={busy === p.identity}
                      onClick={() =>
                        void run(p.identity, () => api(`/meet/c/${call.callId}/guests/remove`, { method: 'POST', body: { identity: p.identity } }))
                      }
                      className="rounded-md p-1 text-white/60 hover:bg-danger/20 hover:text-danger"
                      title="Gast entfernen"
                      aria-label={`${p.name} entfernen`}
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
            {(state?.invitedIds ?? []).map((id) => (
              <li key={id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-white/60">
                <span className="min-w-0 flex-1 truncate">{users.get(id)?.name ?? 'Unbekannt'}</span>
                <span className="text-xs">klingelt …</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Kuvert-Benutzer dazuholen */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Person hinzufügen</h3>
          <label className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5 ring-1 ring-white/10 focus-within:ring-primary">
            <Search className="h-4 w-4 shrink-0 text-white/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name suchen …"
              aria-label="Person suchen"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-white/40"
            />
          </label>
          <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
            {candidates.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  disabled={busy === u.id}
                  onClick={() => void run(u.id, () => api(`/meet/c/${call.callId}/invite`, { method: 'POST', body: { userIds: [u.id] } }))}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <UserPlus className="h-4 w-4 shrink-0 text-white/60" />
                </button>
              </li>
            ))}
            {!candidates.length && <li className="px-2 py-1 text-xs text-white/50">{query ? 'Niemand gefunden' : 'Alle sind schon dabei'}</li>}
          </ul>
        </section>

        {/* Gäste */}
        {call.guestsAllowed && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Gäste einladen</h3>
            {state?.guestLink ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <input
                    readOnly
                    value={state.guestLink}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Gast-Link"
                    className="min-w-0 flex-1 rounded-lg bg-white/5 px-2 py-1.5 text-xs ring-1 ring-white/10"
                  />
                  <button
                    type="button"
                    onClick={() => void copyLink()}
                    className="flex items-center gap-1 rounded-lg bg-primary px-2 py-1.5 text-xs font-semibold text-white hover:brightness-110"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Kopieren
                  </button>
                </div>
                {state.guestLinkRevocable && (
                  <button
                    type="button"
                    disabled={busy === 'revoke'}
                    onClick={() => void revokeLink()}
                    className="flex items-center gap-1 text-xs text-white/60 hover:text-danger"
                  >
                    <Link2Off className="h-3.5 w-3.5" />
                    Link widerrufen
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                disabled={busy === 'link'}
                onClick={() => void createLink()}
                className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/20 disabled:opacity-50"
              >
                <Link2 className="h-4 w-4" />
                Gast-Link erstellen
              </button>
            )}
            <p className="mt-2 text-xs text-white/50">
              Gäste brauchen kein Konto. Sie klopfen an und kommen erst herein, wenn jemand aus Kuvert sie zulässt
              {state?.guestLinkRevocable ? '; der Link gilt bis zum Ende des Anrufs.' : '.'}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}

/** Kleines Zeichen am Personen-Knopf, solange jemand wartet */
export function lobbyWaiting(state: MeetCallState | null): boolean {
  return !!state?.lobby.length;
}

