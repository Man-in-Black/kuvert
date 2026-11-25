import crypto from 'node:crypto';
import { AuthError, HttpError } from './errors.js';
import type { AccountContext } from './module.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix-Zeit in ms */
  expiresAt: number;
  scope?: string;
  idToken?: string;
}

export interface OAuthClientOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Zusätzliche Parameter für die Autorisierungs-URL (z. B. prompt, access_type) */
  extraAuthParams?: Record<string, string>;
  /** Scopes beim Refresh mitsenden (Microsoft: ja, Google: nein) */
  sendScopeOnRefresh?: boolean;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function decodeJwtPayload<T = Record<string, any>>(jwt: string | undefined): T | undefined {
  if (!jwt) return undefined;
  const part = jwt.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Generischer OAuth2-Client (Authorization Code + PKCE + Refresh Token). */
export class OAuthClient {
  constructor(public readonly opts: OAuthClientOptions) {}

  /** extraScopes: zusätzlich angefragte Berechtigungen (inkrementelle Zustimmung, z. B. Teams-Chat) */
  buildAuthorizeUrl(p: { state: string; redirectUri: string; codeChallenge: string; loginHint?: string; extraScopes?: string[] }): string {
    const u = new URL(this.opts.authorizeUrl);
    u.searchParams.set('client_id', this.opts.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', [...new Set([...this.opts.scopes, ...(p.extraScopes ?? [])])].join(' '));
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    for (const [k, v] of Object.entries(this.opts.extraAuthParams ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
    const body = new URLSearchParams({ client_id: this.opts.clientId, ...params });
    if (this.opts.clientSecret) body.set('client_secret', this.opts.clientSecret);
    const res = await fetch(this.opts.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const msg = json.error_description ?? json.error ?? `${res.status}`;
      if (json.error === 'invalid_grant' || json.error === 'interaction_required' || res.status === 401) {
        throw new AuthError(`Token ungültig: ${msg}`, json);
      }
      throw new HttpError(res.status, `Token-Anfrage fehlgeschlagen: ${msg}`, json);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000,
      scope: json.scope,
      idToken: json.id_token,
    };
  }

  exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
  }

  /** scopes: abweichende Berechtigungen für diesen Refresh (nur mit sendScopeOnRefresh) */
  refresh(refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
    if (this.opts.sendScopeOnRefresh) params.scope = (scopes ?? this.opts.scopes).join(' ');
    return this.tokenRequest(params);
  }
}

/**
 * Liefert für ein Konto stets ein gültiges Access-Token. Tokens liegen in
 * `account.secrets.tokens`; Refresh erfolgt automatisch (mit Sperre gegen Parallelität).
 */
export function createTokenManager(ctx: AccountContext, client: () => OAuthClient, refreshScopes?: () => string[] | undefined) {
  let inflight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const tokens = ctx.account.secrets.tokens as OAuthTokens | undefined;
    if (!tokens?.refreshToken) throw new AuthError('Kein Refresh-Token vorhanden – bitte Konto neu verbinden');
    const fresh = await client().refresh(tokens.refreshToken, refreshScopes?.());
    const merged: OAuthTokens = { ...tokens, ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
    ctx.setSecrets({ tokens: merged });
    return merged.accessToken;
  }

  return {
    async getAccessToken(forceRefresh = false): Promise<string> {
      const tokens = ctx.account.secrets.tokens as OAuthTokens | undefined;
      if (!forceRefresh && tokens?.accessToken && tokens.expiresAt > Date.now()) return tokens.accessToken;
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      return inflight;
    },
  };
}
