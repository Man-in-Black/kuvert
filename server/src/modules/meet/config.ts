/**
 * Einstellungen der LiveKit-Anbindung: im Admin-Bereich gepflegt (kv "meet"/"admin"),
 * vorbelegt aus der Umgebung (LIVEKIT_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).
 * Das API-Geheimnis wird verschlüsselt gespeichert und nie ausgeliefert.
 */
import type { MeetAdminConfig, MeetAdminConfigInput } from '@kuvert/shared';
import { decrypt, encrypt } from '../../core/crypto.js';
import { kv } from '../../core/db.js';
import { AppError } from '../../core/errors.js';

interface StoredConfig {
  enabled: boolean;
  url: string;
  publicUrl: string;
  apiKey: string;
  secretEnc?: string | null;
  screenShare?: boolean;
  whiteboard?: boolean;
}

const env = (name: string) => (process.env[name] ?? '').trim();

function stored(): StoredConfig {
  const s = kv.get<StoredConfig>('meet', 'admin');
  return {
    // Vollständig per Umgebung vorbelegt = aktiv, bis der Admin etwas anderes speichert
    enabled: s?.enabled ?? !!(env('LIVEKIT_URL') && env('LIVEKIT_API_KEY') && env('LIVEKIT_API_SECRET')),
    url: s?.url ?? env('LIVEKIT_URL'),
    publicUrl: s?.publicUrl ?? env('LIVEKIT_PUBLIC_URL'),
    apiKey: s?.apiKey ?? env('LIVEKIT_API_KEY'),
    secretEnc: s?.secretEnc ?? (env('LIVEKIT_API_SECRET') ? encrypt(env('LIVEKIT_API_SECRET')) : null),
    screenShare: s?.screenShare ?? true,
    whiteboard: s?.whiteboard ?? true,
  };
}

/** http(s)/ws(s)-Adresse ohne abschließenden Schrägstrich */
export function normalizeUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^(https?|wss?):\/\/[^\s/]+/i.test(v)) throw new AppError(400, 'invalid_url', 'Bitte eine Adresse mit http(s):// bzw. ws(s):// angeben');
  return v;
}

/** ws(s) → http(s) für Server-Aufrufe */
export const toHttp = (url: string) => url.replace(/^ws(s?):\/\//i, 'http$1://');

export const meetConfig = {
  get(): MeetAdminConfig {
    const s = stored();
    return {
      enabled: s.enabled,
      url: s.url,
      publicUrl: s.publicUrl,
      apiKey: s.apiKey,
      secretConfigured: !!s.secretEnc,
      screenShare: s.screenShare !== false,
      whiteboard: s.whiteboard !== false,
    };
  },

  set(input: MeetAdminConfigInput) {
    const prev = stored();
    kv.set('meet', 'admin', {
      enabled: input.enabled,
      url: input.url,
      publicUrl: input.publicUrl,
      apiKey: input.apiKey,
      secretEnc: input.apiSecret ? encrypt(input.apiSecret) : (prev.secretEnc ?? null),
      screenShare: input.screenShare,
      whiteboard: input.whiteboard,
    } satisfies StoredConfig);
  },

  secret(): string | null {
    const enc = stored().secretEnc;
    if (!enc) return null;
    try {
      return decrypt(enc);
    } catch {
      return null; // APP_SECRET geändert?
    }
  },

  /** Vollständig eingerichtet? */
  ready(): boolean {
    const c = this.get();
    return c.enabled && !!c.url && !!c.apiKey && c.secretConfigured;
  },

  /** Zugangsdaten für Token und Server-API – wirft, wenn nicht eingerichtet */
  credentials(override?: { url?: string; apiKey?: string; apiSecret?: string }): { url: string; apiKey: string; apiSecret: string } {
    const c = this.get();
    const url = override?.url || c.url;
    const apiKey = override?.apiKey || c.apiKey;
    const apiSecret = override?.apiSecret || this.secret();
    if (!url || !apiKey || !apiSecret) throw new AppError(409, 'meet_not_configured', 'Die LiveKit-Anbindung ist nicht vollständig eingerichtet');
    return { url: toHttp(url), apiKey, apiSecret };
  },
};
