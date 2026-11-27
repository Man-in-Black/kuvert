/**
 * Anrufe im Team-Chat: Audio, Video, Bildschirmfreigabe und Whiteboard über einen selbst
 * gehosteten LiveKit-Server (SFU). Kuvert stellt nur Zugangs-Tokens aus, steuert den
 * Anruf-Ablauf (Klingeln, Verpasst, Anruf-Karte im Verlauf, Einladungen, Wartebereich für Gäste)
 * und reicht die Signalisierung auf Wunsch unter /api/meet/lk an LiveKit durch.
 * Das Whiteboard (Excalidraw) synchronisieren die Browser direkt über den Datenkanal des Anrufs.
 *
 * Anrufe gibt es in Unterhaltungen des Kuvert-Chats (nicht Mattermost/Talk/Teams) und als Meetings
 * mit festem Link (z. B. im Kalendertermin). Gäste ohne Konto kommen über /join/<token>.
 * Einrichtung: Admin-Bereich → Anrufe, oder LIVEKIT_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 * Abschalten: Admin-Bereich → Module oder KUVERT_DISABLED_MODULES=meet
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { MeetAdminConfig, MeetCallState, MeetJoinResult, MeetKnockResult, MeetLinkInfo, MeetLobbyStatus, MeetMeeting, MeetTestResult } from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { defineModule, type ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { isExternalId } from '../chat/bridges/common.js';
import { meetCalls, type CallJoin } from './calls.js';
import { meetConfig, normalizeUrl, toHttp } from './config.js';
import { createToken, installProxy, livekit, PROXY_PREFIX, proxyHttp, type PublishSource } from './livekit.js';
import { meetings, migrations, toPublicMeeting } from './meetings.js';

type ConvParams = { Params: { id: string } };
type CallParams = { Params: { callId: string } };
type TokenParams = { Params: { token: string } };
type RequestParams = { Params: { requestId: string } };

/** Token-Gültigkeit für Kuvert-Benutzer: lange genug für ausgedehnte Besprechungen */
const TOKEN_TTL_SEC = 8 * 3600;
/**
 * Gäste: kurz gültig – nur zum Verbinden nötig, LiveKit verlängert es für verbundene Teilnehmende
 * selbst. Ein entfernter Gast kann sich mit einem alten Token so nicht lange wieder einwählen.
 */
const GUEST_TOKEN_TTL_SEC = 10 * 60;

let ctxRef: ModuleContext | null = null;

const chatActive = () => !!ctxRef?.registry.modules.some((m) => m.id === 'chat');

function conversationId(req: FastifyRequest<ConvParams>): string {
  const id = req.params.id;
  if (isExternalId(id)) throw new BadRequestError('Anrufe in Mattermost, Nextcloud Talk und Teams laufen im jeweiligen Dienst');
  return id;
}

function ensureAvailable() {
  if (!chatActive()) throw new AppError(503, 'meet_disabled', 'Anrufe brauchen den Team-Chat');
  meetCalls.ensureReady();
}

/** WebSocket-Adresse für den Browser: eigene LiveKit-Adresse oder über Kuvert selbst */
function browserUrl(req: FastifyRequest): string {
  const pub = meetConfig.get().publicUrl;
  if (pub) return pub.replace(/^http(s?):\/\//i, 'ws$1://');
  const proto = req.protocol === 'https' ? 'wss' : 'ws';
  return `${proto}://${req.host}${PROXY_PREFIX}`;
}

/** Zugang zu LiveKit für Kuvert-Benutzer bzw. Gäste */
function joinResult(
  req: FastifyRequest,
  j: CallJoin,
  who: { identity: string; name: string; avatarUrl?: string | null; guest: boolean; leavePath: string },
): MeetJoinResult {
  const cfg = meetConfig.get();
  const sources: PublishSource[] = ['camera', 'microphone', ...(cfg.screenShare ? (['screen_share', 'screen_share_audio'] as const) : [])];
  const token = createToken(meetConfig.credentials(), {
    identity: who.identity,
    name: who.name,
    metadata: JSON.stringify({ avatarUrl: who.avatarUrl ?? null, guest: who.guest }),
    ttlSec: who.guest ? GUEST_TOKEN_TTL_SEC : TOKEN_TTL_SEC,
    video: { room: j.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: sources },
  });
  return {
    callId: j.callId,
    conversationId: who.guest ? null : j.conversationId,
    title: j.title,
    room: j.room,
    url: browserUrl(req),
    token,
    guest: who.guest,
    canInvite: !who.guest,
    canEndForAll: !who.guest && j.host,
    guestsAllowed: cfg.guests,
    allowScreenShare: cfg.screenShare,
    allowWhiteboard: cfg.whiteboard,
    leavePath: who.leavePath,
  };
}

function memberJoin(req: FastifyRequest, j: CallJoin): MeetJoinResult {
  const user = users.get(req.user.id);
  return joinResult(req, j, {
    identity: req.user.id,
    name: user?.name ?? req.user.name,
    avatarUrl: user?.avatarUrl ?? null,
    guest: false,
    leavePath: `/meet/c/${j.callId}/leave`,
  });
}

/** Gastname: sichtbarer Text, ohne Steuerzeichen */
const guestName = z
  .string()
  .transform((v) => v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, '').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Bitte einen Namen angeben').max(60, 'Der Name ist zu lang'));

const secretQuery = z.object({ secret: z.string().min(10).max(100) });

const configSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(500).default(''),
  publicUrl: z.string().max(500).default(''),
  apiKey: z.string().max(200).default(''),
  apiSecret: z.string().max(500).optional(),
  screenShare: z.boolean().default(true),
  whiteboard: z.boolean().default(true),
  guests: z.boolean().default(true),
});

export default defineModule({
  id: 'meet',
  name: 'Anrufe (LiveKit)',
  description: 'Audio- und Videoanrufe mit Bildschirmfreigabe und Whiteboard im Team-Chat, auch mit Gästen',
  migrations,
  /** Feature-Flags nur bei vollständiger Einrichtung und aktivem Chat */
  get features() {
    try {
      if (!meetConfig.ready() || (ctxRef && !chatActive())) return [];
      const c = meetConfig.get();
      return ['meet', ...(c.screenShare ? ['meetScreenShare'] : []), ...(c.whiteboard ? ['meetWhiteboard'] : []), ...(c.guests ? ['meetGuests'] : [])];
    } catch {
      return [];
    }
  },

  init(ctx) {
    ctxRef = ctx;
    meetCalls.init(ctx);
  },

  async shutdown() {
    await meetCalls.shutdown();
  },

  routes(app, ctx) {
    ctxRef = ctx;
    installProxy(app.server, ctx.log);

    /* ═════════════════════════════ Anrufe ═════════════════════════════ */

    /** Anruf in einer Unterhaltung starten bzw. beitreten → Zugang für LiveKit */
    app.post<ConvParams>('/calls/:id/join', async (req): Promise<MeetJoinResult> => {
      ensureAvailable();
      return memberJoin(req, meetCalls.joinConversation(conversationId(req), req.user.id));
    });

    /** Austritt über die Unterhaltung (ältere Clients) */
    app.post<ConvParams>('/calls/:id/leave', async (req) => {
      meetCalls.leaveConversation(conversationId(req), req.user.id);
      return { ok: true };
    });

    app.post<ConvParams>('/calls/:id/decline', async (req) => {
      meetCalls.decline(conversationId(req), req.user.id);
      return { ok: true };
    });

    /** Laufendem Anruf beitreten, in den man geholt wurde („Person hinzufügen“) */
    app.post<CallParams>('/c/:callId/join', async (req): Promise<MeetJoinResult> => {
      ensureAvailable();
      return memberJoin(req, meetCalls.joinById(req.params.callId, req.user.id));
    });

    app.post<CallParams>('/c/:callId/leave', async (req) => {
      meetCalls.leave(req.params.callId, req.user.id);
      return { ok: true };
    });

    /** Anruf für alle beenden (wer ihn gestartet hat bzw. das Meeting angelegt hat) */
    app.post<CallParams>('/c/:callId/end', async (req) => {
      await meetCalls.endForAll(req.params.callId, req.user.id);
      return { ok: true };
    });

    app.post<CallParams>('/c/:callId/decline-invite', async (req) => {
      meetCalls.declineInvite(req.params.callId, req.user.id);
      return { ok: true };
    });

    /** Stand für den Einladen-Bereich (Wartebereich, Gäste, Gast-Link) */
    app.get<CallParams>('/c/:callId/state', async (req): Promise<MeetCallState> => meetCalls.state(req.params.callId, req.user.id));

    /** Weitere Kuvert-Benutzer dazuholen */
    app.post<CallParams>('/c/:callId/invite', async (req) => {
      ensureAvailable();
      const b = parse(z.object({ userIds: z.array(z.string().max(100)).min(1).max(50) }), req.body);
      meetCalls.invite(req.params.callId, req.user.id, b.userIds);
      return { ok: true };
    });

    /** Gast-Link des Anrufs anlegen bzw. abrufen */
    app.post<CallParams>('/c/:callId/guest-link', async (req) => {
      ensureAvailable();
      return { url: meetCalls.guestLink(req.params.callId, req.user.id) };
    });

    app.delete<CallParams>('/c/:callId/guest-link', async (req) => {
      meetCalls.revokeGuestLink(req.params.callId, req.user.id);
      return { ok: true };
    });

    app.post<CallParams>('/c/:callId/guests/remove', async (req) => {
      const b = parse(z.object({ identity: z.string().max(100) }), req.body);
      await meetCalls.removeGuest(req.params.callId, req.user.id, b.identity);
      return { ok: true };
    });

    /** Anklopfenden Gast zulassen / abweisen */
    app.post<RequestParams>('/lobby/:requestId/admit', async (req) => {
      meetCalls.answer(req.params.requestId, req.user.id, true);
      return { ok: true };
    });

    app.post<RequestParams>('/lobby/:requestId/deny', async (req) => {
      meetCalls.answer(req.params.requestId, req.user.id, false);
      return { ok: true };
    });

    /* ═════════════════════════════ Meetings (fester Link) ═════════════════════════════ */

    app.get('/meetings', async (req): Promise<MeetMeeting[]> => meetings.listForOwner(req.user.id).map(toPublicMeeting));

    app.post('/meetings', async (req): Promise<MeetMeeting> => {
      ensureAvailable();
      const b = parse(z.object({ title: z.string().trim().max(200).default('') }), req.body ?? {});
      const m = meetings.create(req.user.id, b.title || 'Kuvert-Anruf');
      audit.log('meet.meeting_created', { req, details: { meetingId: m.id, title: m.title } });
      return toPublicMeeting(m);
    });

    app.delete<{ Params: { id: string } }>('/meetings/:id', async (req) => {
      const m = meetings.require(req.params.id);
      if (m.ownerId !== req.user.id && !req.user.isAdmin) throw new AppError(403, 'forbidden', 'Nur wer das Meeting angelegt hat, kann es löschen');
      meetings.delete(m.id);
      return { ok: true };
    });

    /** Angemeldet über einen Einladungslink beitreten (direkt, ohne Wartebereich) */
    app.post<TokenParams>('/links/:token/join', async (req): Promise<MeetJoinResult> => {
      ensureAvailable();
      return memberJoin(req, meetCalls.joinByLink(req.params.token, req.user.id));
    });

    /* ═════════════════════════════ Gäste (ohne Anmeldung) ═════════════════════════════ */

    /** Infos zum Link für die Gastseite */
    app.get<TokenParams>(
      '/links/:token',
      { config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req): Promise<MeetLinkInfo> => {
        ensureAvailable();
        return meetCalls.linkInfo(req.params.token);
      },
    );

    /** Anklopfen: Gast wartet, bis jemand aus Kuvert ihn zulässt */
    app.post<TokenParams>(
      '/links/:token/knock',
      { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req): Promise<MeetKnockResult> => {
        ensureAvailable();
        const b = parse(z.object({ name: guestName }), req.body);
        return meetCalls.knock(req.params.token, b.name);
      },
    );

    /** Stand des Anklopfens; nach dem Zulassen mit Zugang zum Anruf */
    app.get<RequestParams & { Querystring: { secret: string } }>(
      '/lobby/:requestId',
      { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req): Promise<MeetLobbyStatus> => {
        ensureAvailable();
        const q = parse(secretQuery, req.query);
        const s = meetCalls.lobbyStatus(req.params.requestId, q.secret);
        if (s.status !== 'admitted') return { status: s.status };
        const leavePath = `/meet/lobby/${req.params.requestId}/leave?secret=${encodeURIComponent(q.secret)}`;
        return {
          status: 'admitted',
          join: joinResult(req, { callId: s.callId, room: s.room, conversationId: null, title: s.title, host: false }, {
            identity: s.identity,
            name: `${s.name} (Gast)`,
            guest: true,
            leavePath,
          }),
        };
      },
    );

    /** Gast geht bzw. bricht das Warten ab */
    app.post<RequestParams & { Querystring: { secret: string } }>(
      '/lobby/:requestId/leave',
      { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => {
        const q = parse(secretQuery, req.query);
        meetCalls.guestLeave(req.params.requestId, q.secret);
        return { ok: true };
      },
    );

    /** HTTP-Teil der Weiterleitung (der Client prüft nach Verbindungsfehlern /rtc/validate) – auch für Gäste,
     *  LiveKit prüft das Token selbst. Nicht protokollieren: die URL enthält das LiveKit-Token. */
    app.get('/lk/*', { logLevel: 'silent', config: { public: true } }, async (req, reply) => {
      ensureAvailable();
      const rest = req.url.slice(PROXY_PREFIX.length);
      const r = await proxyHttp(rest);
      return reply.status(r.status).type(r.contentType).send(r.body);
    });

    /* ═════════════════════════════ Admin ═════════════════════════════ */

    app.get('/admin/config', async (req): Promise<MeetAdminConfig> => {
      requireAdmin(req);
      return meetConfig.get();
    });

    app.put('/admin/config', async (req): Promise<MeetAdminConfig> => {
      requireAdmin(req);
      const b = parse(configSchema, req.body);
      const input = {
        enabled: b.enabled,
        url: normalizeUrl(b.url),
        publicUrl: normalizeUrl(b.publicUrl),
        apiKey: b.apiKey.trim(),
        apiSecret: b.apiSecret?.trim() || undefined,
        screenShare: b.screenShare,
        whiteboard: b.whiteboard,
        guests: b.guests,
      };
      const wasReady = meetConfig.ready();
      const hadGuests = meetConfig.get().guests;
      meetConfig.set(input);
      // Abgeschaltet → laufende Anrufe beenden; Gäste abgeschaltet → Links und Wartebereiche schließen
      if (wasReady && !meetConfig.ready()) await meetCalls.endAll();
      else if (hadGuests && !input.guests) meetCalls.closeGuestAccess();
      audit.log('meet.config_updated', {
        req,
        details: { enabled: input.enabled, url: input.url, publicUrl: input.publicUrl, apiKey: input.apiKey, guests: input.guests, secretChanged: !!input.apiSecret },
      });
      return meetConfig.get();
    });

    /** Verbindung und Zugangsdaten prüfen (auch mit noch nicht gespeicherten Werten) */
    app.post('/admin/test', async (req): Promise<MeetTestResult> => {
      requireAdmin(req);
      const b = parse(z.object({ url: z.string().max(500).optional(), apiKey: z.string().max(200).optional(), apiSecret: z.string().max(500).optional() }), req.body ?? {});
      const url = b.url?.trim() ? toHttp(normalizeUrl(b.url)) : undefined;
      try {
        const creds = meetConfig.credentials({ url, apiKey: b.apiKey?.trim() || undefined, apiSecret: b.apiSecret?.trim() || undefined });
        const rooms = await livekit.test(creds);
        return { ok: true, message: rooms === 1 ? 'Verbunden – 1 aktiver Raum' : `Verbunden – ${rooms} aktive Räume` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    });
  },
});
