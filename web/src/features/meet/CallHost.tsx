/**
 * Unsichtbarer Dienst der Kuvert-Anrufe: meldet eingehende Anrufe (Annehmen/Ablehnen, Klingelton,
 * Systembenachrichtigung), verpasste Anrufe und Absagen und zeigt das Anruf-Fenster an, solange man
 * in einem Anruf ist. LiveKit und Whiteboard werden erst beim ersten Anruf geladen.
 */
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ChatConversation, ChatRing } from '@kuvert/shared';
import { useServerEvent } from '@/lib/events';
import { playBeep, pushActiveHere, showSystemNotification } from '@/features/notifications/push';
import { bumpUnseen } from '@/features/notifications/unseen';
import { chatKeys, conversationTitle, isExternal, useChatSettings, useMe, useUserMap } from '@/features/chat/api';
import { callState, declineCall, declineInvite, joinCall, joinCallById, leaveCall, useActiveCall } from './store';

const CallRoom = lazy(() => import('./CallRoom'));

/** Klingelton: alle 1,6 s ein Doppelton, bis angenommen, abgelehnt oder vorbei */
const ringers = new Map<string, number>();
function startRinging(id: string) {
  stopRinging(id);
  playBeep();
  const started = Date.now();
  ringers.set(
    id,
    window.setInterval(() => {
      if (Date.now() - started > 45_000) stopRinging(id);
      else playBeep();
    }, 1600),
  );
}
function stopRinging(id: string) {
  const t = ringers.get(id);
  if (t) window.clearInterval(t);
  ringers.delete(id);
}

export function CallHost() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  const users = useUserMap();
  const { settings } = useChatSettings();
  const call = useActiveCall();

  const conversation = (id: string) => qc.getQueryData<ChatConversation[]>(chatKeys.conversations)?.find((c) => c.id === id);

  /** Systembenachrichtigung, wenn das Fenster nicht im Blick ist; true = Fenster sichtbar (Toast zeigen) */
  const alert = (title: string, body: string, tag: string, url: string): boolean => {
    if (document.hidden) {
      void pushActiveHere().then((push) => {
        if (!push) void showSystemNotification(title, { body, tag, requireInteraction: true }, url, () => navigate(url));
      });
      return false;
    }
    if (!document.hasFocus()) void showSystemNotification(title, { body, tag }, url, () => navigate(url));
    return true;
  };

  const ringTitle = (ring: ChatRing) => (ring.direct ? `📞 ${ring.caller} ruft an` : `📞 ${ring.caller} startet einen Anruf in ${ring.title}`);

  useServerEvent('chat.call', (e) => {
    if (isExternal(e.conversationId)) return;
    const id = e.conversationId;
    const toastId = `meet-ring-${id}`;
    const active = callState.get();

    // Anruf vorbei: Klingeln beenden; war ich drin, auflegen
    if (!e.call) {
      stopRinging(id);
      toast.dismiss(toastId);
      if (active?.conversationId === id) {
        leaveCall();
        toast(active.othersJoined ? 'Anruf beendet' : 'Keine Antwort', { id: `meet-ended-${id}` });
      }
    } else if (active?.conversationId === id) {
      // Jemand ist beigetreten bzw. hat abgelehnt
      if (e.call.participantIds.some((p) => p !== me)) callState.patch({ othersJoined: true });
      if (e.declinedBy && e.declinedBy !== me) toast(`${users.get(e.declinedBy)?.name ?? 'Jemand'} hat abgelehnt`, { id: `meet-declined-${id}-${e.declinedBy}` });
    } else if (me && e.call.participantIds.includes(me)) {
      // Auf einem anderen Gerät angenommen
      stopRinging(id);
      toast.dismiss(toastId);
    }

    if (!e.ring) return;
    const url = `/chat/${id}`;

    if (e.ring.missed) {
      const title = `Verpasster Anruf von ${e.ring.caller}`;
      const body = e.ring.direct ? 'Zum Zurückrufen öffnen' : `In ${e.ring.title}`;
      bumpUnseen('chat');
      if (alert(title, body, `chat-call-${id}`, url)) {
        toast(`📞 ${title}`, {
          id: `meet-missed-${id}`,
          description: e.ring.direct ? undefined : body,
          duration: 60_000,
          action: { label: 'Zurückrufen', onClick: () => void joinCall(id) },
          cancel: { label: 'Chat öffnen', onClick: () => navigate(url) },
        });
      }
      return;
    }

    if (!e.call || (me && e.call.participantIds.includes(me))) return;
    const title = ringTitle(e.ring);
    if (alert(title, 'Zum Annehmen öffnen', `chat-call-${id}`, `${url}?call=join`)) {
      toast(title, {
        id: toastId,
        description: 'Kuvert-Anruf',
        duration: 45_000,
        action: {
          label: 'Annehmen',
          onClick: () => {
            stopRinging(id);
            void joinCall(id);
          },
        },
        cancel: {
          label: 'Ablehnen',
          onClick: () => {
            stopRinging(id);
            declineCall(id);
          },
        },
        onDismiss: () => stopRinging(id),
        onAutoClose: () => stopRinging(id),
      });
    }
    if (settings.sound) startRinging(id);
  });

  // In einen laufenden Anruf geholt („Person hinzufügen“), auch ohne Mitglied der Unterhaltung zu sein
  useServerEvent('meet.invite', (e) => {
    const ringId = `invite-${e.callId}`;
    const toastId = `meet-invite-${e.callId}`;
    if (!e.active) {
      stopRinging(ringId);
      toast.dismiss(toastId);
      return;
    }
    if (callState.get()?.callId === e.callId) return;
    const title = `📞 ${e.caller} holt dich in einen Anruf`;
    const url = `/?meetInvite=${e.callId}`;
    if (alert(title, e.title, toastId, url)) {
      toast(title, {
        id: toastId,
        description: e.title,
        duration: 45_000,
        action: {
          label: 'Annehmen',
          onClick: () => {
            stopRinging(ringId);
            void joinCallById(e.callId);
          },
        },
        cancel: {
          label: 'Ablehnen',
          onClick: () => {
            stopRinging(ringId);
            declineInvite(e.callId);
          },
        },
        onDismiss: () => stopRinging(ringId),
        onAutoClose: () => stopRinging(ringId),
      });
    }
    if (settings.sound) startRinging(ringId);
  });

  // Aus der Benachrichtigung einer Einladung geöffnet (/?meetInvite=<Anruf>)
  const handledInvite = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const callId = params.get('meetInvite');
    if (!callId) return;
    params.delete('meetInvite');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true });
    if (handledInvite.current === callId) return;
    handledInvite.current = callId;
    toast('Anruf beitreten?', {
      id: `meet-invite-${callId}`,
      duration: 30_000,
      action: { label: 'Beitreten', onClick: () => void joinCallById(callId) },
      cancel: { label: 'Ablehnen', onClick: () => declineInvite(callId) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Aus einer Benachrichtigung geöffnet (/chat/<id>?call=join): Beitritt anbieten (Kamera/Mikrofon brauchen einen Klick)
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('call') !== 'join') return;
    const m = location.pathname.match(/\/chat\/([^/?#]+)/);
    const id = m ? decodeURIComponent(m[1]!) : null;
    params.delete('call');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true });
    if (!id || handled.current === id || isExternal(id)) return;
    handled.current = id;
    const conv = conversation(id);
    if (conv && !conv.call) {
      toast('Der Anruf ist bereits vorbei.');
      return;
    }
    toast('Anruf beitreten?', {
      id: `meet-ring-${id}`,
      description: conv ? conversationTitle(conv, me, users) : undefined,
      duration: 30_000,
      action: { label: 'Beitreten', onClick: () => void joinCall(id) },
      cancel: { label: 'Ablehnen', onClick: () => declineCall(id) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Beim Beitreten Klingeln/Hinweise dieser Unterhaltung schließen
  useEffect(() => {
    if (!call) return;
    stopRinging(`invite-${call.callId}`);
    toast.dismiss(`meet-invite-${call.callId}`);
    if (!call.conversationId) return;
    stopRinging(call.conversationId);
    toast.dismiss(`meet-ring-${call.conversationId}`);
    toast.dismiss(`meet-missed-${call.conversationId}`);
  }, [call?.callId]);

  if (!call) return null;
  const conv = call.conversationId ? conversation(call.conversationId) : undefined;
  const title = call.title || (conv ? conversationTitle(conv, me, users) : 'Anruf');
  return (
    <Suspense fallback={null}>
      <CallRoom call={call} title={title} />
    </Suspense>
  );
}
