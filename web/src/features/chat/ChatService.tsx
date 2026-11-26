/**
 * Unsichtbarer Dienst des Chats: hält die Caches über Echtzeit-Ereignisse aktuell
 * (Nachrichten, Lesestand, Tippen, Online-Status) und benachrichtigt über neue
 * Nachrichten, wenn die Unterhaltung gerade nicht sichtbar ist.
 */
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { mentionsHandle, type ChatConversation, type ChatUser } from '@kuvert/shared';
import { useServerEvent } from '@/lib/events';
import { playBeep, pushActiveHere, showSystemNotification } from '@/features/notifications/push';
import {
  activeChat,
  applyNewMessage,
  applyRead,
  chatKeys,
  conversationTitle,
  isExternal,
  patchConversations,
  typingStore,
  upsertMessage,
  isMessage,
  useChatSettings,
  useConversations,
  useMe,
  useUserMap,
} from './api';
import { bodyOf, previewOf } from './format';

export function ChatService() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const users = useUserMap();
  const { settings } = useChatSettings();
  // Liste früh laden, damit das Badge in der Navigation sofort stimmt
  useConversations();

  const notify = (conversationId: string, title: string, body: string) => {
    const url = `/chat/${conversationId}`;
    if (document.hidden) {
      // Mit Web Push auf diesem Gerät zeigt der Service Worker die Nachricht an (sonst doppelt)
      void pushActiveHere().then((push) => {
        if (!push) void showSystemNotification(title, { body, tag: `chat-${conversationId}` }, url, () => navigate(url));
      });
    } else {
      // Fenster sichtbar, aber nicht im Fokus (anderes Programm, zweiter Monitor): zusätzlich als
      // Systembenachrichtigung – den Toast allein würde man dort übersehen (wie bei Terminen)
      if (!document.hasFocus()) void showSystemNotification(title, { body, tag: `chat-${conversationId}` }, url, () => navigate(url));
      toast(title, { description: body, action: { label: 'Öffnen', onClick: () => navigate(url) }, id: `chat-${conversationId}` });
    }
    if (settings.sound) playBeep();
  };

  useServerEvent('chat.message', (e) => {
    const m = e.message;
    if (!isMessage(m)) return;
    upsertMessage(qc, m);
    if (m.senderId) typingStore.stop(e.conversationId, m.senderId);
    const viewing = activeChat.id === e.conversationId && !document.hidden;
    if (!applyNewMessage(qc, m, me, !viewing)) void qc.invalidateQueries({ queryKey: chatKeys.conversations });

    // Offene Unterhaltung in einem Fenster ohne Fokus meldet sich trotzdem – sonst bemerkt man sie nicht
    const looking = viewing && document.hasFocus();
    // Anruf-Beiträge melden sich über chat.call (Klingeln), nicht als Nachricht
    if (m.kind !== 'text' || m.call || !m.senderId || m.senderId === me || looking || !settings.notify) return;
    const conv = qc.getQueryData<ChatConversation[]>(chatKeys.conversations)?.find((c) => c.id === e.conversationId);
    // Erwähnung: verbundene Dienste melden sie selbst, im Kuvert-Chat @kürzel bzw. @all
    const mentioned = conv?.source ? !!m.mention : mentionsHandle(m.body, users.get(me ?? '')?.mention);
    // Stummgeschaltet: nur bei Erwähnung
    if (conv?.muted && !mentioned) return;
    // Gruppen/Kanäle aus Mattermost/Talk/Teams: nur bei Erwähnung (sonst würde jeder Kanal-Beitrag melden)
    if (conv?.source && conv.kind === 'group' && !mentioned) return;
    const sender = users.get(m.senderId)?.name ?? m.senderName ?? 'Neue Nachricht';
    const title = conv?.kind === 'group' ? `${sender} in ${conversationTitle(conv, me, users)}` : sender;
    notify(e.conversationId, title, previewOf(bodyOf(m), m.attachments.length) || 'Neue Nachricht');
  });

  useServerEvent('chat.message.updated', (e) => {
    upsertMessage(qc, e.message);
    patchConversations(qc, (l) => l.map((c) => (c.id === e.conversationId && c.lastMessage?.id === e.message.id ? { ...c, lastMessage: e.message } : c)));
  });

  // Abschnitte/Favoriten in Mattermost geändert
  useServerEvent('chat.categories', () => {
    void qc.invalidateQueries({ queryKey: chatKeys.categories });
  });

  // Anruf begonnen, geändert oder beendet; bei "ring" ruft mich jemand an
  useServerEvent('chat.call', (e) => {
    patchConversations(qc, (l) => l.map((c) => (c.id === e.conversationId ? { ...c, call: e.call } : c)));
    qc.setQueryData<ChatConversation>(['chat', 'conversation', e.conversationId], (c) => (c ? { ...c, call: e.call } : c));
    const toastId = `chat-call-${e.conversationId}`;
    if (!e.call) {
      toast.dismiss(toastId);
      return;
    }
    if (!e.ring || !settings.notify) return;
    const conv = qc.getQueryData<ChatConversation[]>(chatKeys.conversations)?.find((c) => c.id === e.conversationId);
    if (conv?.muted) return;
    const title = e.ring.direct ? `📞 ${e.ring.caller} ruft an` : `📞 ${e.ring.caller} startet einen Anruf in ${e.ring.title}`;
    const url = `/chat/${e.conversationId}`;
    const joinUrl = e.call.joinUrl ?? conv?.source?.webUrl ?? null;
    if (document.hidden) {
      void pushActiveHere().then((push) => {
        if (!push) void showSystemNotification(title, { body: 'Zum Beitreten öffnen', tag: toastId }, url, () => navigate(url));
      });
    } else {
      if (!document.hasFocus()) void showSystemNotification(title, { body: 'Zum Beitreten öffnen', tag: toastId }, url, () => navigate(url));
      toast(title, {
        id: toastId,
        description: `Der Anruf läuft in ${conv?.source?.label ?? 'Mattermost'}.`,
        duration: 30_000,
        action: joinUrl ? { label: 'Beitreten', onClick: () => window.open(joinUrl, '_blank', 'noopener,noreferrer') } : { label: 'Öffnen', onClick: () => navigate(url) },
        cancel: joinUrl ? { label: 'Chat öffnen', onClick: () => navigate(url) } : undefined,
      });
    }
    if (settings.sound) [0, 1600, 3200].forEach((ms) => window.setTimeout(playBeep, ms));
  });

  useServerEvent('chat.read', (e) => {
    applyRead(qc, e.conversationId, e.userId, e.seq, me);
  });

  useServerEvent('chat.typing', (e) => {
    if (e.userId !== me) typingStore.start(e.conversationId, e.userId);
  });

  useServerEvent('chat.conversation', (e) => {
    if (e.removed) {
      patchConversations(qc, (l) => l.filter((c) => c.id !== e.conversationId));
      qc.removeQueries({ queryKey: chatKeys.messages(e.conversationId) });
      if (activeChat.id === e.conversationId) {
        toast.info('Du bist nicht mehr Mitglied dieser Unterhaltung');
        navigate('/chat');
      }
      return;
    }
    void qc.invalidateQueries({ queryKey: chatKeys.conversations });
    // Neue Mitglieder könnten im Verzeichnis noch fehlen
    void qc.invalidateQueries({ queryKey: chatKeys.users });
  });

  useServerEvent('chat.presence', (e) => {
    if (isExternal(e.userId)) {
      // Personen aus Mattermost/Talk stehen in den Unterhaltungen (participants)
      patchConversations(qc, (l) =>
        l.map((c) => (c.participants?.some((p) => p.id === e.userId) ? { ...c, participants: c.participants.map((p) => (p.id === e.userId ? { ...p, online: e.online } : p)) } : c)),
      );
      return;
    }
    qc.setQueryData<ChatUser[]>(chatKeys.users, (list) => list?.map((u) => (u.id === e.userId ? { ...u, online: e.online } : u)));
  });

  // Verbindung zu Mattermost/Talk geändert oder nach Unterbrechung wieder da → Listen und offene Verläufe neu laden
  useServerEvent('chat.connection', (e) => {
    void qc.invalidateQueries({ queryKey: chatKeys.connections });
    if (e.status !== 'ok') return;
    void qc.invalidateQueries({ queryKey: chatKeys.conversations });
    void qc.invalidateQueries({ queryKey: chatKeys.categories });
    const prefix = `x~${e.connectionId}~`;
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'chat' && q.queryKey[1] === 'messages' && String(q.queryKey[2]).startsWith(prefix) });
  });

  // Nach einer Unterbrechung der Verbindung (erneutes SSE "hello") verpasste Nachrichten nachladen
  const connected = useRef(false);
  useServerEvent('hello', () => {
    if (connected.current) void qc.invalidateQueries({ queryKey: chatKeys.all });
    connected.current = true;
  });

  return null;
}
