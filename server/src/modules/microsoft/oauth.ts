/**
 * OAuth2 (Microsoft Identity Platform v2) für Microsoft 365 / Outlook.com.
 */
import { config } from '../../config.js';
import { apiJson } from '../../core/http.js';
import type { AccountSetupResult, OAuthHandler } from '../../core/module.js';
import { OAuthClient, decodeJwtPayload } from '../../core/oauth.js';

export const MS_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Mail.ReadWrite.Shared',
  'Mail.Send.Shared',
  'MailboxSettings.ReadWrite',
  'Calendars.ReadWrite',
  'Calendars.ReadWrite.Shared',
  'Contacts.ReadWrite',
  'Tasks.ReadWrite',
  'Files.ReadWrite.All',
  'OnlineMeetings.ReadWrite',
  'People.Read',
  'User.ReadBasic.All',
];

/**
 * Teams-Chat (Chat.ReadWrite) wird nur für Konten angefragt, die den Teams-Chat in Kuvert
 * verbinden (inkrementelle Zustimmung, Funktion "chat"). So bleiben bestehende Konten und
 * Organisationen, die nur Mail/Kalender freigegeben haben, unberührt.
 */
export const MS_CHAT_SCOPES = ['Chat.ReadWrite'];

/** Berechtigungen für die angefragten Zusatzfunktionen */
export function msExtraScopes(features: readonly string[] | undefined): string[] {
  return features?.includes('chat') ? MS_CHAT_SCOPES : [];
}

/** Scopes für den Token-Refresh eines Kontos (inkl. bereits erteilter Zusatzberechtigungen) */
export function msRefreshScopes(accountConfig: Record<string, unknown>): string[] | undefined {
  const features = Array.isArray(accountConfig.oauthFeatures) ? (accountConfig.oauthFeatures as unknown[]).map(String) : [];
  const extra = msExtraScopes(features);
  return extra.length ? [...MS_SCOPES, ...extra] : undefined;
}

let cached: { key: string; client: OAuthClient } | null = null;

/** OAuth-Client (wird bei geänderter Konfiguration neu erzeugt). */
export function msOAuthClient(): OAuthClient {
  const tenant = config.microsoft.tenant || 'common';
  const key = `${tenant}|${config.microsoft.clientId}|${config.microsoft.clientSecret}`;
  if (cached?.key === key) return cached.client;
  const client = new OAuthClient({
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: config.microsoft.clientId,
    clientSecret: config.microsoft.clientSecret || undefined,
    scopes: MS_SCOPES,
    extraAuthParams: { prompt: 'select_account' },
    sendScopeOnRefresh: true,
  });
  cached = { key, client };
  return client;
}

export const msOAuth: OAuthHandler = {
  getAuthorizeUrl(p) {
    return msOAuthClient().buildAuthorizeUrl({ ...p, extraScopes: msExtraScopes(p.features) });
  },

  async handleCallback({ code, redirectUri, codeVerifier, features }): Promise<AccountSetupResult> {
    const tokens = await msOAuthClient().exchangeCode(code, redirectUri, codeVerifier);
    const me = await apiJson<{ displayName?: string; mail?: string | null; userPrincipalName?: string }>(
      'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
      { token: tokens.accessToken },
    );
    const idClaims = decodeJwtPayload<{ preferred_username?: string; email?: string; tid?: string; name?: string }>(tokens.idToken);
    const email = me.mail || me.userPrincipalName || idClaims?.email || idClaims?.preferred_username;
    if (!email) throw new Error('E-Mail-Adresse des Microsoft-Kontos konnte nicht ermittelt werden');
    return {
      email,
      name: me.displayName || idClaims?.name || email,
      config: { tenantId: idClaims?.tid ?? null, userPrincipalName: me.userPrincipalName ?? null, oauthFeatures: features ?? [] },
      secrets: { tokens },
      settings: { sharedMailboxes: [] },
    };
  },
};
