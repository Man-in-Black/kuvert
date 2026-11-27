/**
 * Anrufe im Team-Chat: Audio, Video, Bildschirmfreigabe und Whiteboard über einen selbst
 * gehosteten LiveKit-Server (SFU). Kuvert stellt nur Zugangs-Tokens aus, steuert den
 * Anruf-Ablauf (Klingeln, Verpasst, Anruf-Karte im Verlauf) und reicht die
 * Signalisierung auf Wunsch unter /api/meet/lk an LiveKit durch.
 * Das Whiteboard (Excalidraw) synchronisieren die Browser direkt über den Datenkanal des Anrufs.
 *
 * Nur für Unterhaltungen des Kuvert-Chats (nicht Mattermost/Talk/Teams) – braucht das Modul „chat“.
 * Einrichtung: Admin-Bereich → Anrufe, oder LIVEKIT_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 * Abschalten: Admin-Bereich → Module oder KUVERT_DISABLED_MODULES=meet
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { MeetAdminConfig, MeetJoinResult, MeetTestResult } from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { defineModule, type ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { isExternalId } from '../chat/bridges/common.js';
import { meetCalls } from './calls.js';
import { meetConfig, normalizeUrl, toHttp } from './config.js';
import { createToken, installProxy, livekit, PROXY_PREFIX, proxyHttp, type PublishSource } from './livekit.js';

type ConvParams = { Params: { id: string } };

/** Token-Gültigkeit: lange genug für ausgedehnte Besprechungen */
const TOKEN_TTL_SEC = 8 * 3600;

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

const configSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(500).default(''),
  publicUrl: z.string().max(500).default(''),
  apiKey: z.string().max(200).default(''),
  apiSecret: z.string().max(500).optional(),
  screenShare: z.boolean().default(true),
  whiteboard: z.boolean().default(true),
});

export default defineModule({
  id: 'meet',
  name: 'Anrufe (LiveKit)',
  description: 'Audio- und Videoanrufe mit Bildschirmfreigabe und Whiteboard im Team-Chat',
  /** Feature-Flags nur bei vollständiger Einrichtung und aktivem Chat */
  get features() {
    try {
      if (!meetConfig.ready() || (ctxRef && !chatActive())) return [];
      const c = meetConfig.get();
      return ['meet', ...(c.screenShare ? ['meetScreenShare'] : []), ...(c.whiteboard ? ['meetWhiteboard'] : [])];
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

    /** Anruf starten bzw. beitreten → Zugang für LiveKit */
    app.post<ConvParams>('/calls/:id/join', async (req): Promise<MeetJoinResult> => {
      ensureAvailable();
      const id = conversationId(req);
      const { callId, room } = meetCalls.join(id, req.user.id);
      const cfg = meetConfig.get();
      const sources: PublishSource[] = ['camera', 'microphone', ...(cfg.screenShare ? (['screen_share', 'screen_share_audio'] as const) : [])];
      const user = users.get(req.user.id);
      const token = createToken(meetConfig.credentials(), {
        identity: req.user.id,
        name: user?.name ?? req.user.name,
        metadata: JSON.stringify({ avatarUrl: user?.avatarUrl ?? null }),
        ttlSec: TOKEN_TTL_SEC,
        video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: sources },
      });
      return { callId, conversationId: id, room, url: browserUrl(req), token };
    });

    app.post<ConvParams>('/calls/:id/leave', async (req) => {
      meetCalls.leave(conversationId(req), req.user.id);
      return { ok: true };
    });

    app.post<ConvParams>('/calls/:id/decline', async (req) => {
      meetCalls.decline(conversationId(req), req.user.id);
      return { ok: true };
    });

    /** HTTP-Teil der Weiterleitung (der Client prüft nach Verbindungsfehlern /rtc/validate).
     *  Nicht protokollieren: die URL enthält das LiveKit-Token. */
    app.get('/lk/*', { logLevel: 'silent' }, async (req, reply) => {
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
      };
      const wasReady = meetConfig.ready();
      meetConfig.set(input);
      // Abgeschaltet → laufende Anrufe beenden
      if (wasReady && !meetConfig.ready()) await meetCalls.endAll();
      audit.log('meet.config_updated', {
        req,
        details: { enabled: input.enabled, url: input.url, publicUrl: input.publicUrl, apiKey: input.apiKey, secretChanged: !!input.apiSecret },
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
