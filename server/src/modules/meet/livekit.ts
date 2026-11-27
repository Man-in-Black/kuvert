/**
 * Schlanke LiveKit-Anbindung ohne SDK:
 *  - Zugangs-Tokens (JWT, HS256 mit dem API-Geheimnis),
 *  - Server-API (Twirp/JSON) zum Abfragen der Teilnehmer und Schließen von Räumen,
 *  - WebSocket-Weiterleitung unter /api/meet/lk, damit Browser LiveKit über die Kuvert-Adresse
 *    erreichen (keine eigene Domain/kein eigenes Zertifikat für LiveKit nötig).
 *    Die Medien selbst laufen weiter direkt per UDP/TCP zum LiveKit-Server.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../core/errors.js';
import { meetConfig } from './config.js';

export const PROXY_PREFIX = '/api/meet/lk';

type Credentials = { url: string; apiKey: string; apiSecret: string };

/** Quellen, die ein Teilnehmer senden darf (LiveKit TrackSource) */
export type PublishSource = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';

export interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomList?: boolean;
  /** Räume anlegen und löschen (DeleteRoom) */
  roomCreate?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: PublishSource[];
}

/** Zugangs-Token für LiveKit */
export function createToken(
  creds: Credentials,
  opts: { identity?: string; name?: string; metadata?: string; ttlSec: number; video: VideoGrant },
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iss: creds.apiKey,
    nbf: now - 10,
    exp: now + opts.ttlSec,
    video: opts.video,
  };
  if (opts.identity) {
    payload.sub = opts.identity;
    payload.jti = `${opts.identity}-${now}`;
  }
  if (opts.name) payload.name = opts.name;
  if (opts.metadata) payload.metadata = opts.metadata;
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = createHmac('sha256', creds.apiSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Aufruf der LiveKit-Server-API (Twirp, JSON) */
async function roomService<T>(creds: Credentials, method: string, body: Record<string, unknown>, room?: string): Promise<T> {
  const token = createToken(creds, { ttlSec: 60, video: { roomAdmin: true, roomList: true, roomCreate: true, ...(room ? { room } : {}) } });
  let res: Response;
  try {
    res = await fetch(`${creds.url}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new AppError(502, 'livekit_unreachable', `LiveKit nicht erreichbar (${creds.url}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { msg?: string }).msg ?? text;
    } catch {
      /* kein JSON */
    }
    throw new AppError(res.status === 404 ? 404 : 502, res.status === 404 ? 'livekit_not_found' : 'livekit_error', `LiveKit: ${msg || `HTTP ${res.status}`}`, {
      status: res.status,
    });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const livekit = {
  /** Identitäten (= Kuvert-Benutzer-IDs) im Raum; leer, wenn der Raum nicht existiert */
  async participants(room: string): Promise<string[]> {
    try {
      const r = await roomService<{ participants?: { identity: string }[] }>(meetConfig.credentials(), 'ListParticipants', { room }, room);
      return (r.participants ?? []).map((p) => p.identity);
    } catch (err) {
      if (err instanceof AppError && err.code === 'livekit_not_found') return [];
      throw err;
    }
  },

  async deleteRoom(room: string): Promise<void> {
    try {
      await roomService(meetConfig.credentials(), 'DeleteRoom', { room }, room);
    } catch (err) {
      if (err instanceof AppError && err.code === 'livekit_not_found') return;
      throw err;
    }
  },

  /** Verbindung und Zugangsdaten prüfen (auch mit noch nicht gespeicherten Werten) */
  async test(creds: Credentials): Promise<number> {
    const r = await roomService<{ rooms?: unknown[] }>(creds, 'ListRooms', {});
    return r.rooms?.length ?? 0;
  },
};

/* ───────────────────────────── WebSocket-Weiterleitung ───────────────────────────── */

let proxyInstalled = false;

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Header-Block einer Antwort aus rawHeaders */
function headerBlock(statusLine: string, raw: string[]): string {
  let out = `${statusLine}\r\n`;
  for (let i = 0; i < raw.length; i += 2) out += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return `${out}\r\n`;
}

/** Leitet WebSocket-Verbindungen unter PROXY_PREFIX an den LiveKit-Server weiter */
export function installProxy(server: http.Server, log: FastifyBaseLogger) {
  if (proxyInstalled) return;
  proxyInstalled = true;

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (!url.startsWith(`${PROXY_PREFIX}/`)) {
      // Niemand sonst nimmt Upgrades an → Verbindung schließen statt hängen lassen
      if (server.listenerCount('upgrade') <= 1) rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!meetConfig.ready()) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let target: URL;
    try {
      target = new URL(meetConfig.credentials().url);
    } catch {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }

    const rest = url.slice(PROXY_PREFIX.length);
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    // Die Kuvert-Sitzung geht LiveKit nichts an
    delete headers.cookie;
    delete headers.authorization;
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname.replace(/\/+$/, '')}${rest}`,
      method: 'GET',
      headers,
    });

    upstream.on('upgrade', (res, upSocket, upHead) => {
      socket.write(headerBlock(`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`, res.rawHeaders));
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      const close = () => {
        socket.destroy();
        upSocket.destroy();
      };
      socket.on('error', close);
      upSocket.on('error', close);
      socket.on('close', close);
      upSocket.on('close', close);
      upSocket.pipe(socket).pipe(upSocket);
    });

    // Kein Upgrade (z. B. 401 bei ungültigem Token): Antwort unverändert durchreichen
    upstream.on('response', (res) => {
      socket.write(headerBlock(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}`, res.rawHeaders));
      res.pipe(socket);
    });

    upstream.on('error', (err) => {
      log.warn({ err }, 'LiveKit-Weiterleitung fehlgeschlagen');
      rejectUpgrade(socket, 502, 'Bad Gateway');
    });
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
}

/** Einfache HTTP-Weiterleitung (z. B. /rtc/validate, das der Client nach einem Verbindungsfehler abfragt) */
export async function proxyHttp(path: string): Promise<{ status: number; body: string; contentType: string }> {
  const { url } = meetConfig.credentials();
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(8_000) });
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? 'text/plain' };
  } catch (err) {
    return { status: 502, body: `LiveKit nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`, contentType: 'text/plain' };
  }
}
