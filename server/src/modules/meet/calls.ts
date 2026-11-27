/**
 * Ablauf von Kuvert-Anrufen in Chat-Unterhaltungen:
 *  - Der erste Beitritt startet den Anruf: Anruf-Karte im Verlauf, Klingeln bei den anderen
 *    Mitgliedern (Echtzeit-Ereignis + Web Push).
 *  - Wer im Anruf ist, ermittelt Kuvert aus den eigenen Beitritten/Austritten und gleicht alle
 *    paar Sekunden mit LiveKit ab (Browser geschlossen, Netz weg …).
 *  - Ist niemand mehr da, endet der Anruf: Karte mit Dauer und Teilnehmern, „Verpasst“ für alle,
 *    die nicht dabei waren. Direktanrufe enden nach 45 s ohne Antwort oder bei Ablehnung.
 */
import { randomUUID } from 'node:crypto';
import type { ChatCall, ChatCallInfo, ChatRing, ChatSystemEvent, ServerEvent } from '@kuvert/shared';
import { AppError } from '../../core/errors.js';
import type { ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { kuvertCalls } from '../chat/calls.js';
import { chatStore } from '../chat/store.js';
import { pushStore } from '../notifications/push.js';
import { meetConfig } from './config.js';
import { livekit } from './livekit.js';

/** So lange klingelt es (Direktanruf endet danach ohne Antwort) */
const RING_MS = 45_000;
/** Nach dem Token-Abruf gilt man so lange als „im Anruf“, auch wenn LiveKit einen noch nicht meldet */
const JOIN_GRACE_MS = 30_000;
const POLL_MS = 8_000;

interface ActiveCall {
  id: string;
  conversationId: string;
  room: string;
  startedAt: string;
  ownerId: string;
  /** Gerade im Anruf */
  participants: Set<string>;
  /** War irgendwann dabei (für die Karte im Verlauf) */
  everJoined: Set<string>;
  /** Token abgeholt, aber (noch) nicht von LiveKit bestätigt: userId → Zeitpunkt */
  pending: Map<string, number>;
  declined: Set<string>;
  messageId: string;
  ringTimer: NodeJS.Timeout | null;
}

const calls = new Map<string, ActiveCall>();
let ctxRef: ModuleContext | null = null;
let pollTimer: NodeJS.Timeout | null = null;

const publish = (userIds: Iterable<string>, event: ServerEvent) => {
  for (const id of userIds) ctxRef?.bus.publish(id, event);
};

function view(c: ActiveCall): ChatCall {
  return { kuvert: true, startedAt: c.startedAt, ownerId: c.ownerId, participantIds: [...c.participants] };
}

function cardEvent(c: ActiveCall, endedAt: string | null): ChatSystemEvent {
  const call: ChatCallInfo = { startedAt: c.startedAt, endedAt, participantIds: [...(endedAt ? c.everJoined : c.participants)] };
  return { action: 'call', actorId: c.ownerId, call };
}

function ringInfo(c: ActiveCall, missed = false): ChatRing {
  const conv = chatStore.conversationRow(c.conversationId);
  return {
    caller: users.get(c.ownerId)?.name ?? 'Jemand',
    title: conv.name ?? '',
    direct: conv.kind === 'direct',
    ...(missed ? { missed: true } : {}),
  };
}

/** Darf diese Person für die Unterhaltung benachrichtigt werden (Chat-Einstellung, stummgeschaltet)? */
function wantsRing(userId: string, conversationId: string): boolean {
  const notify = (users.getSettings(userId).modules?.chat as { notify?: boolean } | undefined)?.notify;
  if (notify === false) return false;
  return !chatStore.member(conversationId, userId)?.muted;
}

async function pushRing(userId: string, c: ActiveCall, info: ChatRing) {
  const ctx = ctxRef;
  if (!ctx?.registry.modules.some((m) => m.id === 'notifications')) return;
  if (!pushStore.hasSubscriptions(userId)) return;
  try {
    await pushStore.send(userId, {
      ...(info.missed
        ? { title: `Verpasster Anruf von ${info.caller}`, body: info.direct ? 'Zum Zurückrufen öffnen' : `In ${info.title}` }
        : {
            title: info.direct ? `📞 ${info.caller} ruft an` : `📞 ${info.caller} startet einen Anruf in ${info.title}`,
            body: 'Zum Beitreten öffnen',
            requireInteraction: true,
          }),
      url: `/chat/${c.conversationId}${info.missed ? '' : '?call=join'}`,
      // Gleicher Tag: „Verpasst“ ersetzt auf dem Gerät die Klingel-Benachrichtigung
      tag: `chat-call-${c.conversationId}`,
    });
  } catch (err) {
    ctx.log.debug({ err }, 'Anruf-Push fehlgeschlagen');
  }
}

/** Aktuellen Stand an alle Mitglieder melden */
function broadcast(c: ActiveCall) {
  kuvertCalls.set(c.conversationId, view(c));
  publish(chatStore.memberIds(c.conversationId), { type: 'chat.call', conversationId: c.conversationId, call: view(c) });
}

function start(conversationId: string, userId: string): ActiveCall {
  const conv = chatStore.conversationRow(conversationId);
  const id = randomUUID();
  const c: ActiveCall = {
    id,
    conversationId,
    room: `kuvert-${conversationId}-${id.slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    ownerId: userId,
    participants: new Set([userId]),
    everJoined: new Set([userId]),
    pending: new Map([[userId, Date.now()]]),
    declined: new Set(),
    messageId: '',
    ringTimer: null,
  };
  calls.set(conversationId, c);

  // Anruf-Karte im Verlauf (zählt nicht als ungelesen, meldet sich über das Klingeln)
  const msg = chatStore.addSystemMessage(conversationId, cardEvent(c, null));
  c.messageId = msg.id;
  publish(chatStore.memberIds(conversationId), { type: 'chat.message', conversationId, message: msg });

  kuvertCalls.set(conversationId, view(c));
  const info = ringInfo(c);
  for (const member of chatStore.memberIds(conversationId)) {
    if (member === userId) {
      publish([member], { type: 'chat.call', conversationId, call: view(c) });
      continue;
    }
    const ring = wantsRing(member, conversationId);
    publish([member], { type: 'chat.call', conversationId, call: view(c), ...(ring ? { ring: info } : {}) });
    if (ring) void pushRing(member, c, info);
  }

  c.ringTimer = setTimeout(() => {
    c.ringTimer = null;
    // Direktanruf ohne Antwort beenden; in Gruppen läuft der Anruf weiter, solange jemand drin ist
    if (conv.kind === 'direct' && c.everJoined.size <= 1) void end(c, 'no_answer');
  }, RING_MS);
  c.ringTimer.unref();
  return c;
}

async function end(c: ActiveCall, reason: 'empty' | 'no_answer' | 'declined' | 'shutdown') {
  if (calls.get(c.conversationId) !== c) return;
  calls.delete(c.conversationId);
  kuvertCalls.delete(c.conversationId);
  if (c.ringTimer) clearTimeout(c.ringTimer);
  const endedAt = new Date().toISOString();
  const members = chatStore.memberIds(c.conversationId);

  try {
    const msg = chatStore.updateSystemMessage(c.messageId, cardEvent(c, endedAt));
    publish(members, { type: 'chat.message.updated', conversationId: c.conversationId, message: msg });
  } catch {
    /* Unterhaltung inzwischen gelöscht */
  }

  const missedInfo = ringInfo(c, true);
  // Sofort wieder vorbei (z. B. Verbindung des Anrufers gescheitert): kein „verpasst“
  const tooShort = reason === 'empty' && Date.now() - new Date(c.startedAt).getTime() < 4_000;
  for (const member of members) {
    // Verpasst: nie beigetreten, nicht abgelehnt; nicht beim Herunterfahren
    const missed = reason !== 'shutdown' && !tooShort && !c.everJoined.has(member) && !c.declined.has(member) && wantsRing(member, c.conversationId);
    publish([member], { type: 'chat.call', conversationId: c.conversationId, call: null, ...(missed ? { ring: missedInfo } : {}) });
    if (missed) void pushRing(member, c, missedInfo);
  }

  if (reason !== 'shutdown') {
    try {
      await livekit.deleteRoom(c.room);
    } catch (err) {
      ctxRef?.log.debug({ err }, 'LiveKit-Raum ließ sich nicht schließen');
    }
  }
}

/** Mit LiveKit abgleichen: wer ist wirklich (noch) im Raum? */
async function poll() {
  for (const c of [...calls.values()]) {
    let present: string[];
    try {
      present = await livekit.participants(c.room);
    } catch (err) {
      ctxRef?.log.debug({ err }, 'LiveKit-Teilnehmer nicht abrufbar');
      continue;
    }
    if (calls.get(c.conversationId) !== c) continue;
    const now = Date.now();
    const next = new Set(present);
    for (const [userId, at] of c.pending) {
      if (next.has(userId)) c.pending.delete(userId);
      else if (now - at < JOIN_GRACE_MS) next.add(userId);
      else c.pending.delete(userId);
    }
    for (const id of next) c.everJoined.add(id);
    const changed = next.size !== c.participants.size || [...next].some((id) => !c.participants.has(id));
    c.participants = next;
    if (!next.size) await end(c, 'empty');
    else if (changed) broadcast(c);
  }
}

export const meetCalls = {
  init(ctx: ModuleContext) {
    ctxRef = ctx;
    pollTimer = setInterval(() => void poll(), POLL_MS);
    pollTimer.unref();
  },

  async shutdown() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    for (const c of [...calls.values()]) await end(c, 'shutdown');
  },

  /** Anruf starten oder beitreten; liefert den LiveKit-Raum */
  join(conversationId: string, userId: string): { callId: string; room: string } {
    chatStore.requireMember(conversationId, userId);
    let c = calls.get(conversationId);
    if (!c) c = start(conversationId, userId);
    else {
      c.pending.set(userId, Date.now());
      c.declined.delete(userId);
      const isNew = !c.participants.has(userId);
      c.participants.add(userId);
      c.everJoined.add(userId);
      if (isNew) broadcast(c);
    }
    return { callId: c.id, room: c.room };
  },

  leave(conversationId: string, userId: string) {
    const c = calls.get(conversationId);
    if (!c) return;
    c.pending.delete(userId);
    if (!c.participants.delete(userId)) return;
    if (!c.participants.size) void end(c, 'empty');
    else broadcast(c);
  },

  /** Klingeln ablehnen; ein Direktanruf endet damit */
  decline(conversationId: string, userId: string) {
    chatStore.requireMember(conversationId, userId);
    const c = calls.get(conversationId);
    if (!c) return;
    c.declined.add(userId);
    const conv = chatStore.conversationRow(conversationId);
    publish([...c.participants], { type: 'chat.call', conversationId, call: view(c), declinedBy: userId });
    if (conv.kind === 'direct' && c.everJoined.size <= 1) void end(c, 'declined');
  },

  /** Laufender Anruf (für Prüfungen) */
  get(conversationId: string): { id: string; room: string } | null {
    const c = calls.get(conversationId);
    return c ? { id: c.id, room: c.room } : null;
  },

  /** Anruf sofort für alle beenden (z. B. Anbindung abgeschaltet) */
  async endAll() {
    for (const c of [...calls.values()]) await end(c, 'empty');
  },

  ensureReady() {
    if (!meetConfig.ready()) throw new AppError(503, 'meet_disabled', 'Anrufe sind nicht eingerichtet – bitte an den Administrator wenden');
  },
};
