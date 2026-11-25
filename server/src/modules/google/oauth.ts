/**
 * OAuth2 für Google-Konten (Authorization Code + PKCE, Offline-Zugriff).
 */
import { config } from '../../config.js';
import { apiJson } from '../../core/http.js';
import type { AccountSetupResult, OAuthHandler } from '../../core/module.js';
import { decodeJwtPayload, OAuthClient } from '../../core/oauth.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/meetings.space.created',
];

export function googleOAuthClient(): OAuthClient {
  return new OAuthClient({
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    scopes: GOOGLE_SCOPES,
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    sendScopeOnRefresh: false,
  });
}

interface GoogleIdToken {
  email?: string;
  name?: string;
  picture?: string;
}

export const googleOAuth: OAuthHandler = {
  getAuthorizeUrl(p) {
    return googleOAuthClient().buildAuthorizeUrl(p);
  },

  async handleCallback({ code, redirectUri, codeVerifier }): Promise<AccountSetupResult> {
    const tokens = await googleOAuthClient().exchangeCode(code, redirectUri, codeVerifier);
    let { email, name, picture } = decodeJwtPayload<GoogleIdToken>(tokens.idToken) ?? {};
    if (!email) {
      const info = await apiJson<GoogleIdToken>('https://openidconnect.googleapis.com/v1/userinfo', { token: tokens.accessToken });
      email = info.email;
      name ??= info.name;
      picture ??= info.picture;
    }
    if (!email) throw new Error('Google hat keine E-Mail-Adresse geliefert');
    return {
      email,
      name: name || email,
      config: { picture: picture ?? null },
      secrets: { tokens },
      color: '#ea4335',
    };
  },
};
