/**
 * Ablauf von Kuvert-Anrufen:
 *  - Anrufe in Chat-Unterhaltungen: Der erste Beitritt startet den Anruf (Anruf-Karte im Verlauf,
 *    Klingeln bei den anderen Mitgliedern per Echtzeit-Ereignis und Web Push).
 *  - Meetings (fester Link, z. B. aus einem Kalendertermin): starten, sobald jemand aus Kuvert beitritt.
 *  - Wer im Anruf ist, ermittelt Kuvert aus den eigenen Beitritten/Austritten und gleicht alle paar
 *    Sekunden mit LiveKit ab (Browser geschlossen, Netz weg …).
 *  - Weitere Kuvert-Benutzer lassen sich in einen laufenden Anruf holen („Person hinzufügen“) – auch
 *    ohne Mitglied der Unterhaltung zu sein.
 *  - Gäste ohne Konto kommen über einen Link: Sie klopfen an (Wartebereich) und erhalten erst nach dem
 *    Zulassen durch jemanden aus Kuvert ein kurzlebiges Token für genau diesen Anruf. Entfernte oder
 *    unbekannte Gäste wirft der Abgleich wieder hinaus.
 *  - Ist niemand aus Kuvert mehr im Anruf, endet er (auch für verbliebene Gäste): Karte mit Dauer und
 *    Teilnehmern, „Verpasst“ für Mitglieder, die nicht dabei waren. Direktanrufe enden nach 45 s ohne
 *    Antwort oder bei Ablehnung.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatCall, ChatCallInfo, ChatRing, ChatSystemEvent, MeetCallState, MeetLinkInfo, ServerEvent } from '@kuvert/shared';
import { AppError, BadRequestError } from '../../core/errors.js';
import type { ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { kuvertCalls } from '../chat/calls.js';
import { chatStore } from '../chat/store.js';
import { pushStore } from '../notifications/push.js';
import { meetConfig } from './config.js';
import { livekit } from './livekit.js';
import { joinUrl, meetings, newLinkToken, type Meeting } from './meetings.js';

/** So lange klingelt es (Direktanruf endet danach ohne Antwort) */
const RING_MS = 45_000;
/** Nach dem Token-Abruf gilt man so lange als „im Anruf“, auch wenn LiveKit einen noch nicht meldet */
const JOIN_GRACE_MS = 30_000;
const POLL_MS = 8_000;
/** LiveKit-Identität von Gästen */
export const GUEST_PREFIX = 'guest:';
/** Anklopfen ohne Nachfrage des Gastes (Seite geschlossen) verfällt nach … */
const LOBBY_IDLE_MS = 60_000;
/** Höchstens so viele Wartende je Anruf/Meeting und insgesamt */
const LOBBY_MAX_PER_CALL = 20;
const LOBBY_MAX_TOTAL = 500;

const isGuest = (identity: string) => identity.startsWith(GUEST_PREFIX);

/**
 * LiveKit-Identität eines Kuvert-Benutzers: Benutzer-ID plus Gerätekennung. LiveKit wirft bei
 * doppelter Identität die ältere Verbindung hinaus – so kann man mit Laptop und Handy zugleich drin sein.
 */
const DEVICE_SEP = '#';
export const memberIdentity = (userId: string, device: string) => `${userId}${DEVICE_SEP}${device}`;
export const newDeviceId = () => randomBytes(6).toString('hex');
/** Benutzer-ID aus der Identität (ältere Beitritte ohne Gerätekennung bleiben, wie sie sind) */
const userOfIdentity = (identity: string) => identity.split(DEVICE_SEP)[0]!;

interface GuestInfo {
  name: string;
  /** Zugelassen, aber von LiveKit noch nicht gemeldet (Zeitpunkt), sonst null */
  pendingSince: number | null;
  requestId: string;
}

interface ActiveCall {
  id: string;
  /** c:<Unterhaltung> oder m:<Meeting> */
  key: string;
  conversationId: string | null;
  meetingId: string | null;
  /** Titel bei Meetings (Unterhaltungen: aus dem Chat) */
  title: string;
  room: string;
  startedAt: string;
  ownerId: string;
  /** Kuvert-Benutzer gerade im Anruf */
  participants: Set<string>;
  /** War irgendwann dabei (für die Karte im Verlauf) */
  everJoined: Set<string>;
  /** Token abgeholt, aber (noch) nicht von LiveKit bestätigt: userId → Zeitpunkt */
  pending: Map<string, number>;
  declined: Set<string>;
  /** Eingeladene Kuvert-Benutzer, die nicht Mitglied der Unterhaltung sind bzw. ins Meeting geholt wurden */
  invited: Set<string>;
  /** Zugelassene Gäste: LiveKit-Identität → Info */
  guests: Map<string, GuestInfo>;
  everGuests: Set<string>;
  /** Entfernte Gäste: tauchen sie wieder auf, fliegen sie erneut */
  removed: Set<string>;
  /** Gast-Link dieses Anrufs (nur Unterhaltungen; Meetings haben ihren festen Link) */
  guestToken: string | null;
  messageId: string;
  ringTimer: NodeJS.Timeout | null;
}

interface LobbyRequest {
  id: string;
  /** Anruf-Schlüssel (c:… bzw. m:…) */
  key: string;
  name: string;
  secret: string;
  at: number;
  lastSeen: number;
  status: 'waiting' | 'admitted' | 'denied' | 'ended';
  guestIdentity?: string;
  callId?: string;
  /** Über den Gast-Link eines Anrufs gekommen (fällt beim Widerruf weg) */
  viaCallLink: boolean;
}

const calls = new Map<string, ActiveCall>();
const byId = new Map<string, ActiveCall>();
/** Gast-Link eines laufenden Anrufs → Anruf-ID */
const callLinks = new Map<string, string>();
const lobby = new Map<string, LobbyRequest>();

let ctxRef: ModuleContext | null = null;
let pollTimer: NodeJS.Timeout | null = null;

const convKey = (conversationId: string) => `c:${conversationId}`;
const meetingKey = (meetingId: string) => `m:${meetingId}`;

const publish = (userIds: Iterable<string>, event: ServerEvent) => {
  for (const id of userIds) ctxRef?.bus.publish(id, event);
};

const userName = (id: string) => users.get(id)?.name ?? 'Jemand';

function view(c: ActiveCall): ChatCall {
  return { kuvert: true, startedAt: c.startedAt, ownerId: c.ownerId, participantIds: [...c.participants] };
}

function cardEvent(c: ActiveCall, endedAt: string | null): ChatSystemEvent {
  const call: ChatCallInfo = {
    startedAt: c.startedAt,
    endedAt,
    participantIds: [...(endedAt ? c.everJoined : c.participants)],
    ...(c.everGuests.size ? { guestCount: c.everGuests.size } : {}),
  };
  return { action: 'call', actorId: c.ownerId, call };
}

function ringInfo(c: ActiveCall, missed = false): ChatRing {
  const conv = chatStore.conversationRow(c.conversationId!);
  return {
    caller: userName(c.ownerId),
    title: conv.name ?? '',
    direct: conv.kind === 'direct',
    ...(missed ? { missed: true } : {}),
  };
}

/** Anzeigename des Anrufs für eine Person (Einladung, Gastseite) */
function callTitle(c: ActiveCall, forUserId?: string): string {
  if (c.meetingId) return c.title;
  const conv = chatStore.conversationRow(c.conversationId!);
  if (conv.name) return conv.name;
  // Direktnachricht: die andere Person bzw. die beiden Beteiligten
  const names = chatStore
    .memberIds(c.conversationId!)
    .filter((id) => id !== forUserId)
    .map(userName);
  return names.length ? `Anruf mit ${names.join(' und ')}` : 'Anruf';
}

/** Darf diese Person für die Unterhaltung benachrichtigt werden (Chat-Einstellung, stummgeschaltet)? */
function wantsRing(userId: string, conversationId: string | null): boolean {
  const notify = (users.getSettings(userId).modules?.chat as { notify?: boolean } | undefined)?.notify;
  if (notify === false) return false;
  return conversationId ? !chatStore.member(conversationId, userId)?.muted : true;
}

async function sendPush(userId: string, payload: Parameters<typeof pushStore.send>[1]) {
  const ctx = ctxRef;
  if (!ctx?.registry.modules.some((m) => m.id === 'notifications')) return;
  if (!pushStore.hasSubscriptions(userId)) return;
  try {
    await pushStore.send(userId, payload);
  } catch (err) {
    ctx.log.debug({ err }, 'Anruf-Push fehlgeschlagen');
  }
}

function pushRing(userId: string, c: ActiveCall, info: ChatRing) {
  void sendPush(userId, {
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
}

/* ───────────── Stand für die Kuvert-Teilnehmenden ───────────── */

function guestLinkOf(c: ActiveCall): string | null {
  if (!meetConfig.get().guests) return null;
  if (c.meetingId) {
    const m = meetings.get(c.meetingId);
    return m ? joinUrl(m.token) : null;
  }
  return c.guestToken ? joinUrl(c.guestToken) : null;
}

function stateOf(c: ActiveCall): MeetCallState {
  return {
    callId: c.id,
    guestLink: guestLinkOf(c),
    guestLinkRevocable: !c.meetingId && !!c.guestToken,
    lobby: [...lobby.values()]
      .filter((r) => r.key === c.key && r.status === 'waiting')
      .sort((a, b) => a.at - b.at)
      .map((r) => ({ id: r.id, name: r.name, at: new Date(r.at).toISOString() })),
    guests: [...c.guests].map(([identity, g]) => ({ identity, name: g.name })),
    invitedIds: [...c.invited].filter((id) => !c.participants.has(id)),
  };
}

function publishState(c: ActiveCall) {
  publish(c.participants, { type: 'meet.state', state: stateOf(c) });
}

/** Aktuellen Stand an alle melden (Unterhaltung: Mitglieder; immer: Teilnehmende) */
function broadcast(c: ActiveCall) {
  if (c.conversationId) {
    kuvertCalls.set(c.conversationId, view(c));
    publish(chatStore.memberIds(c.conversationId), { type: 'chat.call', conversationId: c.conversationId, call: view(c) });
  }
  publishState(c);
}

/* ───────────── Start und Ende ───────────── */

function create(opts: { key: string; conversationId: string | null; meetingId: string | null; title: string; ownerId: string }): ActiveCall {
  const id = randomUUID();
  const base = opts.conversationId ?? opts.meetingId ?? 'x';
  const c: ActiveCall = {
    id,
    key: opts.key,
    conversationId: opts.conversationId,
    meetingId: opts.meetingId,
    title: opts.title,
    room: `kuvert-${base}-${id.slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    ownerId: opts.ownerId,
    participants: new Set([opts.ownerId]),
    everJoined: new Set([opts.ownerId]),
    pending: new Map([[opts.ownerId, Date.now()]]),
    declined: new Set(),
    invited: new Set(),
    guests: new Map(),
    everGuests: new Set(),
    removed: new Set(),
    guestToken: null,
    messageId: '',
    ringTimer: null,
  };
  calls.set(c.key, c);
  byId.set(c.id, c);
  return c;
}

function startConversationCall(conversationId: string, userId: string): ActiveCall {
  const conv = chatStore.conversationRow(conversationId);
  const c = create({ key: convKey(conversationId), conversationId, meetingId: null, title: '', ownerId: userId });

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
    if (ring) pushRing(member, c, info);
  }

  c.ringTimer = setTimeout(() => {
    c.ringTimer = null;
    // Direktanruf ohne Antwort beenden; in Gruppen läuft der Anruf weiter, solange jemand drin ist.
    // Wer schon Gäste oder weitere Personen eingeladen hat, wartet auf diese – kein Abbruch.
    if (conv.kind === 'direct' && c.everJoined.size <= 1 && !c.everGuests.size && !c.guestToken && !c.invited.size) void end(c, 'no_answer');
  }, RING_MS);
  c.ringTimer.unref();
  publishState(c);
  return c;
}

function startMeetingCall(m: Meeting, userId: string): ActiveCall {
  const c = create({ key: meetingKey(m.id), conversationId: null, meetingId: m.id, title: m.title, ownerId: userId });
  publishState(c);
  return c;
}

async function end(c: ActiveCall, reason: 'empty' | 'no_answer' | 'declined' | 'ended' | 'shutdown') {
  if (calls.get(c.key) !== c) return;
  calls.delete(c.key);
  byId.delete(c.id);
  if (c.conversationId) kuvertCalls.delete(c.conversationId);
  if (c.ringTimer) clearTimeout(c.ringTimer);
  if (c.guestToken) callLinks.delete(c.guestToken);

  // Wartebereich: Gäste dieses Anrufs sind fertig; bei Meetings warten Anklopfende weiter auf den nächsten Beitritt
  for (const r of lobby.values()) {
    if (r.key !== c.key) continue;
    if (r.status === 'admitted' || (r.status === 'waiting' && r.viaCallLink)) r.status = 'ended';
  }

  // Eingeladene, die nicht beigetreten sind: Klingeln beenden
  const title = callTitle(c);
  for (const id of c.invited) {
    if (!c.participants.has(id)) publish([id], { type: 'meet.invite', callId: c.id, title, caller: userName(c.ownerId), active: false });
  }

  if (c.conversationId) {
    const conversationId = c.conversationId;
    const endedAt = new Date().toISOString();
    const members = chatStore.memberIds(conversationId);
    try {
      const msg = chatStore.updateSystemMessage(c.messageId, cardEvent(c, endedAt));
      publish(members, { type: 'chat.message.updated', conversationId, message: msg });
    } catch {
      /* Unterhaltung inzwischen gelöscht */
    }

    const missedInfo = ringInfo(c, true);
    // Sofort wieder vorbei (z. B. Verbindung des Anrufers gescheitert): kein „verpasst“
    const tooShort = reason === 'empty' && Date.now() - new Date(c.startedAt).getTime() < 4_000;
    for (const member of members) {
      // Verpasst: nie beigetreten, nicht abgelehnt; nicht beim Herunterfahren
      const missed =
        reason !== 'shutdown' && !tooShort && !c.everJoined.has(member) && !c.declined.has(member) && wantsRing(member, conversationId);
      publish([member], { type: 'chat.call', conversationId, call: null, ...(missed ? { ring: missedInfo } : {}) });
      if (missed) pushRing(member, c, missedInfo);
    }
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
/** Abgelaufene spontane Meetings höchstens alle 10 Minuten aufräumen */
let lastCleanup = 0;

async function poll() {
  const now = Date.now();
  if (now - lastCleanup > 10 * 60_000) {
    lastCleanup = now;
    try {
      const n = meetings.deleteExpired((id) => calls.has(meetingKey(id)));
      if (n) ctxRef?.log.info({ count: n }, 'Abgelaufene spontane Meetings entfernt');
    } catch (err) {
      ctxRef?.log.warn({ err }, 'Aufräumen der Meetings fehlgeschlagen');
    }
  }
  // Verwaiste Anklopf-Anfragen (Seite geschlossen) und erledigte aufräumen
  const touched = new Set<string>();
  for (const [id, r] of lobby) {
    const idle = now - r.lastSeen > LOBBY_IDLE_MS;
    if ((r.status === 'waiting' && idle) || (r.status !== 'waiting' && idle && r.status !== 'admitted') || now - r.lastSeen > 12 * 3600_000) {
      lobby.delete(id);
      if (r.status === 'waiting') touched.add(r.key);
    }
  }
  for (const key of touched) {
    const c = calls.get(key);
    if (c) publishState(c);
  }

  for (const c of [...calls.values()]) {
    let present: string[];
    try {
      present = await livekit.participants(c.room);
    } catch (err) {
      ctxRef?.log.debug({ err }, 'LiveKit-Teilnehmer nicht abrufbar');
      continue;
    }
    if (calls.get(c.key) !== c) continue;
    const t = Date.now();

    // Kuvert-Benutzer
    const next = new Set(present.filter((id) => !isGuest(id)).map(userOfIdentity));
    for (const [userId, at] of c.pending) {
      if (next.has(userId)) c.pending.delete(userId);
      else if (t - at < JOIN_GRACE_MS) next.add(userId);
      else c.pending.delete(userId);
    }
    for (const id of next) c.everJoined.add(id);
    let changed = next.size !== c.participants.size || [...next].some((id) => !c.participants.has(id));
    const joinedNow = [...next].filter((id) => !c.participants.has(id));
    c.participants = next;

    // Gäste: unbekannte/entfernte hinauswerfen, gegangene austragen
    const guestsHere = new Set(present.filter(isGuest));
    for (const identity of guestsHere) {
      if (!c.guests.has(identity)) {
        void livekit.removeParticipant(c.room, identity).catch(() => undefined);
        continue;
      }
      const g = c.guests.get(identity)!;
      if (g.pendingSince !== null) g.pendingSince = null;
    }
    for (const [identity, g] of c.guests) {
      if (guestsHere.has(identity)) continue;
      if (g.pendingSince !== null && t - g.pendingSince < JOIN_GRACE_MS) continue;
      c.guests.delete(identity);
      const r = lobby.get(g.requestId);
      if (r) r.status = 'ended';
      changed = true;
    }

    if (!next.size) await end(c, 'empty');
    else if (changed) {
      broadcast(c);
      // Neu Hinzugekommene brauchen den vollen Stand (Wartebereich, Gäste)
      if (joinedNow.length) publish(joinedNow, { type: 'meet.state', state: stateOf(c) });
    }
  }
}

/* ───────────── Prüfungen ───────────── */

function requireCall(callId: string): ActiveCall {
  const c = byId.get(callId);
  if (!c) throw new AppError(410, 'call_ended', 'Der Anruf ist bereits vorbei');
  return c;
}

/** Nur wer selbst (aus Kuvert) im Anruf ist, darf einladen, zulassen und Gäste entfernen */
function requireParticipant(c: ActiveCall, userId: string) {
  if (!c.participants.has(userId)) throw new AppError(403, 'not_in_call', 'Nur wer im Anruf ist, kann das tun');
}

function requireGuestsAllowed() {
  if (!meetConfig.get().guests) throw new AppError(403, 'meet_guests_disabled', 'Gäste sind für Anrufe nicht freigeschaltet');
}

const secretOk = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function requireRequest(requestId: string, secret: string): LobbyRequest {
  const r = lobby.get(requestId);
  if (!r || !secretOk(r.secret, secret)) throw new AppError(404, 'not_found', 'Anfrage nicht gefunden oder abgelaufen');
  return r;
}

/** Einladungslink auflösen: Gast-Link eines laufenden Anrufs oder Meeting-Link */
function resolveLink(token: string): { call: ActiveCall | null; meeting: Meeting | null; key: string } | null {
  const callId = callLinks.get(token);
  if (callId) {
    const c = byId.get(callId);
    return c ? { call: c, meeting: null, key: c.key } : null;
  }
  const m = meetings.byToken(token);
  if (!m) return null;
  return { call: calls.get(meetingKey(m.id)) ?? null, meeting: m, key: meetingKey(m.id) };
}

function enter(c: ActiveCall, userId: string) {
  c.pending.set(userId, Date.now());
  c.declined.delete(userId);
  const isNew = !c.participants.has(userId);
  c.participants.add(userId);
  c.everJoined.add(userId);
  if (isNew) {
    broadcast(c);
    // Eingeladene: auf anderen Geräten nicht mehr klingeln lassen
    if (c.invited.has(userId)) publish([userId], { type: 'meet.invite', callId: c.id, title: callTitle(c, userId), caller: userName(c.ownerId), active: false });
  } else publish([userId], { type: 'meet.state', state: stateOf(c) });
}

export interface CallJoin {
  callId: string;
  room: string;
  conversationId: string | null;
  title: string;
  /** Darf den Anruf für alle beenden (wer ihn gestartet bzw. das Meeting angelegt hat) */
  host: boolean;
}

/** Gastgeber: wer den Anruf gestartet hat bzw. bei Meetings auch, wer das Meeting angelegt hat */
function isHost(c: ActiveCall, userId: string): boolean {
  if (c.ownerId === userId) return true;
  return !!c.meetingId && meetings.get(c.meetingId)?.ownerId === userId;
}

const joinInfo = (c: ActiveCall, userId: string): CallJoin => ({
  callId: c.id,
  room: c.room,
  conversationId: c.conversationId,
  title: c.meetingId ? c.title : c.conversationId && chatStore.member(c.conversationId, userId) ? '' : callTitle(c, userId),
  host: isHost(c, userId),
});

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

  /** Anruf in einer Unterhaltung starten oder beitreten (Mitglieder und Eingeladene) */
  joinConversation(conversationId: string, userId: string): CallJoin {
    let c = calls.get(convKey(conversationId));
    if (c?.invited.has(userId)) {
      enter(c, userId);
      return joinInfo(c, userId);
    }
    chatStore.requireMember(conversationId, userId);
    if (!c) c = startConversationCall(conversationId, userId);
    else enter(c, userId);
    return joinInfo(c, userId);
  },

  /** Laufendem Anruf per ID beitreten (Einladung „Person hinzufügen“) */
  joinById(callId: string, userId: string): CallJoin {
    const c = requireCall(callId);
    const member = c.conversationId ? !!chatStore.member(c.conversationId, userId) : false;
    if (!member && !c.invited.has(userId) && !c.participants.has(userId)) throw new AppError(403, 'not_invited', 'Du bist zu diesem Anruf nicht eingeladen');
    enter(c, userId);
    return joinInfo(c, userId);
  },

  /** Angemeldet über einen Einladungslink: direkt als Kuvert-Benutzer hinein */
  joinByLink(token: string, userId: string): CallJoin {
    const link = resolveLink(token);
    if (!link) throw new AppError(404, 'not_found', 'Der Link ist ungültig oder abgelaufen');
    if (link.call) {
      if (!link.call.participants.has(userId)) link.call.invited.add(userId);
      enter(link.call, userId);
      return joinInfo(link.call, userId);
    }
    if (!link.meeting) throw new AppError(410, 'call_ended', 'Der Anruf ist bereits vorbei');
    const c = startMeetingCall(link.meeting, userId);
    return joinInfo(c, userId);
  },

  async leave(callId: string, userId: string, device?: string) {
    const c = byId.get(callId);
    if (!c) return;
    c.pending.delete(userId);
    if (!c.participants.has(userId)) return;
    if (device) {
      // Mit einem weiteren Gerät noch im Anruf? Dann bleibt man Teilnehmer, der Anruf läuft weiter
      const own = memberIdentity(userId, device);
      try {
        const present = await livekit.participants(c.room);
        if (byId.get(callId) !== c) return;
        if (present.some((id) => id !== own && !isGuest(id) && userOfIdentity(id) === userId)) return;
      } catch {
        /* LiveKit nicht erreichbar: wie bisher austragen */
      }
    }
    if (!c.participants.delete(userId)) return;
    if (!c.participants.size) void end(c, 'empty');
    else broadcast(c);
  },

  /** Anruf für alle beenden (nur Gastgeber) – auch Gäste fliegen hinaus, der LiveKit-Raum wird geschlossen */
  async endForAll(callId: string, userId: string) {
    const c = requireCall(callId);
    if (!isHost(c, userId)) throw new AppError(403, 'not_host', 'Nur wer den Anruf gestartet hat, kann ihn für alle beenden');
    ctxRef?.log.info({ callId: c.id, by: userId }, 'Anruf für alle beendet');
    await end(c, 'ended');
  },

  /** Austritt über die Unterhaltung (ältere Clients) */
  leaveConversation(conversationId: string, userId: string) {
    const c = calls.get(convKey(conversationId));
    if (c) void this.leave(c.id, userId);
  },

  /** Klingeln ablehnen; ein Direktanruf endet damit */
  decline(conversationId: string, userId: string) {
    chatStore.requireMember(conversationId, userId);
    const c = calls.get(convKey(conversationId));
    if (!c) return;
    c.declined.add(userId);
    const conv = chatStore.conversationRow(conversationId);
    publish([...c.participants], { type: 'chat.call', conversationId, call: view(c), declinedBy: userId });
    if (conv.kind === 'direct' && c.everJoined.size <= 1 && !c.invited.size && !c.everGuests.size) void end(c, 'declined');
  },

  /** Einladung („Person hinzufügen“) ablehnen */
  declineInvite(callId: string, userId: string) {
    const c = byId.get(callId);
    if (!c || !c.invited.delete(userId)) return;
    publish([userId], { type: 'meet.invite', callId: c.id, title: callTitle(c, userId), caller: userName(c.ownerId), active: false });
    publishState(c);
  },

  /** Weitere Kuvert-Benutzer in den laufenden Anruf holen */
  invite(callId: string, byUserId: string, userIds: string[]) {
    const c = requireCall(callId);
    requireParticipant(c, byUserId);
    const caller = userName(byUserId);
    for (const id of new Set(userIds)) {
      const u = users.get(id);
      if (!u || users.require(id).disabled || c.participants.has(id)) continue;
      c.invited.add(id);
      const title = callTitle(c, id);
      publish([id], { type: 'meet.invite', callId: c.id, title, caller, active: true });
      if (wantsRing(id, null)) {
        void sendPush(id, {
          title: `📞 ${caller} holt dich in einen Anruf`,
          body: title,
          requireInteraction: true,
          url: `/?meetInvite=${c.id}`,
          tag: `meet-invite-${c.id}`,
        });
      }
    }
    publishState(c);
  },

  /** Stand für den Einladen-Bereich */
  state(callId: string, userId: string): MeetCallState {
    const c = requireCall(callId);
    requireParticipant(c, userId);
    return stateOf(c);
  },

  /** Gast-Link des Anrufs anlegen (bzw. vorhandenen liefern) */
  guestLink(callId: string, userId: string): string {
    requireGuestsAllowed();
    const c = requireCall(callId);
    requireParticipant(c, userId);
    if (!c.meetingId && !c.guestToken) {
      c.guestToken = newLinkToken();
      callLinks.set(c.guestToken, c.id);
      publishState(c);
    }
    return guestLinkOf(c)!;
  },

  /** Gast-Link widerrufen: Wer noch anklopft, wird abgewiesen; zugelassene Gäste bleiben */
  revokeGuestLink(callId: string, userId: string) {
    const c = requireCall(callId);
    requireParticipant(c, userId);
    if (c.meetingId || !c.guestToken) return;
    callLinks.delete(c.guestToken);
    c.guestToken = null;
    for (const r of lobby.values()) if (r.key === c.key && r.status === 'waiting' && r.viaCallLink) r.status = 'denied';
    publishState(c);
  },

  /** Anklopfenden Gast zulassen bzw. abweisen */
  answer(requestId: string, userId: string, admit: boolean) {
    const r = lobby.get(requestId);
    if (!r || r.status !== 'waiting') throw new AppError(404, 'not_found', 'Die Anfrage ist nicht mehr offen');
    const c = calls.get(r.key);
    if (!c) throw new AppError(410, 'call_ended', 'Der Anruf ist bereits vorbei');
    requireParticipant(c, userId);
    if (admit) {
      requireGuestsAllowed();
      const identity = `${GUEST_PREFIX}${randomUUID()}`;
      r.status = 'admitted';
      r.guestIdentity = identity;
      r.callId = c.id;
      c.guests.set(identity, { name: r.name, pendingSince: Date.now(), requestId: r.id });
      c.everGuests.add(identity);
      ctxRef?.log.info({ callId: c.id, by: userId }, 'Gast im Anruf zugelassen');
    } else {
      r.status = 'denied';
    }
    publishState(c);
  },

  /** Gast aus dem Anruf entfernen */
  async removeGuest(callId: string, userId: string, identity: string) {
    const c = requireCall(callId);
    requireParticipant(c, userId);
    if (!isGuest(identity)) throw new BadRequestError('Nur Gäste lassen sich entfernen');
    const g = c.guests.get(identity);
    c.guests.delete(identity);
    c.removed.add(identity);
    if (g) {
      const r = lobby.get(g.requestId);
      if (r) r.status = 'ended';
    }
    publishState(c);
    await livekit.removeParticipant(c.room, identity);
  },

  /* ───────────── Öffentlich (Gäste) ───────────── */

  linkInfo(token: string): MeetLinkInfo {
    const link = resolveLink(token);
    if (!link) throw new AppError(404, 'not_found', 'Der Link ist ungültig oder abgelaufen');
    if (link.meeting) {
      return {
        kind: 'meeting',
        title: link.meeting.title,
        host: userName(link.meeting.ownerId),
        active: !!link.call,
        guestsAllowed: meetConfig.get().guests,
      };
    }
    const c = link.call!;
    return { kind: 'call', title: callTitle(c), host: userName(c.ownerId), active: true, guestsAllowed: meetConfig.get().guests };
  },

  /** Gast klopft an */
  knock(token: string, name: string): { requestId: string; secret: string } {
    requireGuestsAllowed();
    const link = resolveLink(token);
    if (!link) throw new AppError(404, 'not_found', 'Der Link ist ungültig oder abgelaufen');
    const waiting = [...lobby.values()].filter((r) => r.status === 'waiting');
    if (waiting.length >= LOBBY_MAX_TOTAL || waiting.filter((r) => r.key === link.key).length >= LOBBY_MAX_PER_CALL) {
      throw new AppError(429, 'lobby_full', 'Gerade warten zu viele Personen – bitte später erneut versuchen');
    }
    const now = Date.now();
    const r: LobbyRequest = {
      id: randomUUID(),
      key: link.key,
      name,
      secret: newLinkToken(),
      at: now,
      lastSeen: now,
      status: 'waiting',
      viaCallLink: !link.meeting,
    };
    lobby.set(r.id, r);
    if (link.call) publishState(link.call);
    return { requestId: r.id, secret: r.secret };
  },

  /** Gast fragt nach dem Stand; bei Zulassung liefert er die Angaben für das Token */
  lobbyStatus(
    requestId: string,
    secret: string,
  ): { status: 'waiting' | 'denied' | 'ended' } | { status: 'admitted'; callId: string; room: string; identity: string; name: string; title: string } {
    const r = requireRequest(requestId, secret);
    r.lastSeen = Date.now();
    if (r.status !== 'admitted') {
      // Meeting ohne laufenden Anruf bzw. widerrufener Link: weiter warten oder vorbei
      if (r.status === 'waiting' && r.viaCallLink && !calls.has(r.key)) r.status = 'ended';
      return { status: r.status };
    }
    const c = byId.get(r.callId!);
    if (!c || !r.guestIdentity || !c.guests.has(r.guestIdentity)) {
      r.status = 'ended';
      return { status: 'ended' };
    }
    return { status: 'admitted', callId: c.id, room: c.room, identity: r.guestIdentity, name: r.name, title: callTitle(c) };
  },

  /** Gast verlässt den Anruf bzw. bricht das Warten ab */
  guestLeave(requestId: string, secret: string) {
    const r = requireRequest(requestId, secret);
    const wasWaiting = r.status === 'waiting';
    r.status = 'ended';
    const c = r.callId ? byId.get(r.callId) : calls.get(r.key);
    if (!c) return;
    if (r.guestIdentity) c.guests.delete(r.guestIdentity);
    if (wasWaiting || r.guestIdentity) publishState(c);
  },

  /** Laufender Anruf einer Unterhaltung (für Prüfungen) */
  get(conversationId: string): { id: string; room: string } | null {
    const c = calls.get(convKey(conversationId));
    return c ? { id: c.id, room: c.room } : null;
  },

  /** Anrufe sofort für alle beenden (z. B. Anbindung abgeschaltet) */
  async endAll() {
    for (const c of [...calls.values()]) await end(c, 'empty');
  },

  /** Gäste abgeschaltet: Gast-Links und Wartebereiche sofort schließen (zugelassene Gäste bleiben) */
  closeGuestAccess() {
    for (const c of calls.values()) {
      if (c.guestToken) callLinks.delete(c.guestToken);
      c.guestToken = null;
    }
    for (const r of lobby.values()) if (r.status === 'waiting') r.status = 'denied';
    for (const c of calls.values()) publishState(c);
  },

  ensureReady() {
    if (!meetConfig.ready()) throw new AppError(503, 'meet_disabled', 'Anrufe sind nicht eingerichtet – bitte an den Administrator wenden');
  },
};
