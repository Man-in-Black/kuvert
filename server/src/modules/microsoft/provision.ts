/**
 * Automatische Einrichtung der Entra-ID-App-Registrierung für Kuvert.
 *
 * Ablauf: Ein Microsoft-365-Administrator meldet sich per Gerätecode-Flow an
 * (funktioniert mit MFA und bedingtem Zugriff; Kuvert sieht nie ein Passwort).
 * Mit dem kurzlebigen Admin-Token legt Kuvert über Microsoft Graph an bzw. aktualisiert:
 *  1. die App-Registrierung (Redirect-URI, alle delegierten Graph-Berechtigungen aus MS_SCOPES),
 *  2. den Dienstprinzipal (Unternehmensanwendung),
 *  3. die Administratorzustimmung für die ganze Organisation,
 *  4. einen geheimen Clientschlüssel
 * und übernimmt Client-ID, Geheimnis und Tenant in die Dienst-Einstellungen.
 * Das Admin-Token liegt nur im Arbeitsspeicher und wird nach dem Vorgang verworfen.
 */
import crypto from 'node:crypto';
import type { MsAppAudience, MsProvisionedApp, MsProvisionStatus, MsProvisionStep } from '@kuvert/shared';
import { config } from '../../config.js';
import { audit } from '../../core/audit.js';
import { BadRequestError, HttpError } from '../../core/errors.js';
import { apiJson, type RequestOptions } from '../../core/http.js';
import type { ModuleContext } from '../../core/module.js';
import { decodeJwtPayload } from '../../core/oauth.js';
import { systemSettings } from '../../core/system-settings.js';
import { MS_CHAT_SCOPES, MS_SCOPES as MS_BASE_SCOPES } from './oauth.js';

/** Die automatisch eingerichtete App bekommt auch die Teams-Chat-Berechtigung (Admin-Zustimmung für alle) */
const MS_SCOPES = [...MS_BASE_SCOPES, ...MS_CHAT_SCOPES];

/** Öffentlicher Client "Microsoft Graph Command Line Tools" (Microsoft, in jedem Tenant verfügbar) */
const BOOTSTRAP_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const BOOTSTRAP_SCOPES = [
  'https://graph.microsoft.com/Application.ReadWrite.All',
  'https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All',
  'https://graph.microsoft.com/User.Read',
  'openid',
  'profile',
];
/** App-ID von Microsoft Graph */
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';
/** signInAudience der App je Auswahl */
const SIGN_IN_AUDIENCE: Record<MsAppAudience, string> = {
  tenant: 'AzureADMyOrg',
  orgs: 'AzureADMultipleOrgs',
  multi: 'AzureADandPersonalMicrosoftAccount',
};
const AUDIENCE_LABEL: Record<MsAppAudience, string> = {
  tenant: 'Nur diese Organisation',
  orgs: 'Mehrere Organisationen',
  multi: 'Alle Microsoft-Konten',
};
const META_KEY = 'microsoft-app';
/** Laufzeiten des Clientschlüssels in Monaten (Fallback, falls eine Richtlinie lange Laufzeiten verbietet) */
const SECRET_MONTHS = [24, 12, 6];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────── Gespeicherte Metadaten der zuletzt eingerichteten App ───────────── */

interface StoredMeta extends Omit<MsProvisionedApp, 'portalUrl'> {
  /** keyId des von Kuvert erzeugten Schlüssels (zum Entfernen beim Erneuern) */
  keyId?: string;
}

function portalUrl(appId: string): string {
  return `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/${appId}`;
}

export function provisionedApp(ctx: ModuleContext): MsProvisionedApp | null {
  const meta = ctx.kv.get<StoredMeta>('system', META_KEY);
  if (!meta) return null;
  const { keyId: _keyId, ...rest } = meta;
  return { ...rest, portalUrl: portalUrl(meta.appId) };
}

/* ───────────── Vorgänge (im Speicher) ───────────── */

interface Job {
  id: string;
  userId: string;
  state: MsProvisionStatus['state'];
  userCode?: string;
  verificationUri?: string;
  expiresAt: number;
  signedInAs?: string | null;
  steps: MsProvisionStep[];
  error?: string;
  result?: MsProvisionedApp;
  startedAt: number;
  audience: MsAppAudience;
  displayName: string;
}

const jobs = new Map<string, Job>();

function toStatus(job: Job): MsProvisionStatus {
  return {
    id: job.id,
    state: job.state,
    userCode: job.state === 'waiting' ? job.userCode : undefined,
    verificationUri: job.state === 'waiting' ? job.verificationUri : undefined,
    expiresAt: new Date(job.expiresAt).toISOString(),
    signedInAs: job.signedInAs ?? null,
    steps: job.steps,
    error: job.error,
    result: job.result,
  };
}

function isActive(job: Job): boolean {
  return job.state === 'waiting' || job.state === 'working';
}

function cleanup() {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of jobs) if (!isActive(job) && job.startedAt < cutoff) jobs.delete(id);
}

export function getJob(id: string, userId: string): MsProvisionStatus | null {
  const job = jobs.get(id);
  return job && job.userId === userId ? toStatus(job) : null;
}

/** Neuester Vorgang des Admins (für die Wiederaufnahme nach einem Neuladen der Seite) */
export function latestJob(userId: string): MsProvisionStatus | null {
  let latest: Job | null = null;
  for (const job of jobs.values()) if (job.userId === userId && (!latest || job.startedAt > latest.startedAt)) latest = job;
  return latest ? toStatus(latest) : null;
}

export function cancelJob(id: string, userId: string): boolean {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return false;
  if (job.state === 'waiting') job.state = 'cancelled';
  return true;
}

/* ───────────── Fehlertexte ───────────── */

/** AADSTS-Meldungen ohne Trace-/Correlation-ID und Zeitstempel */
function cleanAadMessage(desc: unknown): string {
  const text = String(desc ?? '').split(/\r?\n/)[0] ?? '';
  return text.replace(/\s*Trace ID:.*$/s, '').trim() || 'Unbekannter Fehler';
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError && err.status === 403) {
    return `${msg} – das Microsoft-Konto benötigt die Rolle „Globaler Administrator“ (oder „Anwendungsadministrator“ und „Administrator für privilegierte Rollen“).`;
  }
  return msg;
}

/* ───────────── Start: Gerätecode anfordern ───────────── */

export async function startProvisioning(
  ctx: ModuleContext,
  opts: { userId: string; adminEmail?: string; audience: MsAppAudience; displayName: string },
): Promise<MsProvisionStatus> {
  cleanup();
  // Nur ein Vorgang gleichzeitig: laufende Einrichtung abwarten, offene Anmeldungen verwerfen
  for (const job of jobs.values()) {
    if (job.state === 'working') throw new BadRequestError('Es läuft bereits eine Einrichtung – bitte kurz warten.');
  }
  for (const job of jobs.values()) if (job.state === 'waiting') job.state = 'cancelled';

  // Domain der Admin-Adresse als Tenant: Anmeldung nur in genau dieser Organisation
  const authority = opts.adminEmail?.split('@')[1]?.trim().toLowerCase() || 'organizations';
  const base = `https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/v2.0`;
  const res = await fetch(`${base}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: BOOTSTRAP_CLIENT_ID, scope: BOOTSTRAP_SCOPES.join(' ') }),
  }).catch((err: Error) => {
    throw new HttpError(502, `Microsoft ist nicht erreichbar: ${err.message}`);
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !json.device_code) {
    const msg = cleanAadMessage(json.error_description ?? json.error ?? res.status);
    if (/AADSTS90002|AADSTS900023/.test(msg)) throw new BadRequestError(`Zur Domain „${authority}“ wurde keine Microsoft-365-Organisation gefunden.`);
    throw new BadRequestError(`Microsoft meldet: ${msg}`);
  }

  const job: Job = {
    id: crypto.randomUUID(),
    userId: opts.userId,
    state: 'waiting',
    userCode: String(json.user_code),
    verificationUri: String(json.verification_uri ?? 'https://microsoft.com/devicelogin'),
    expiresAt: Date.now() + Number(json.expires_in ?? 900) * 1000,
    steps: [],
    startedAt: Date.now(),
    audience: opts.audience,
    displayName: opts.displayName,
  };
  jobs.set(job.id, job);

  void waitForSignIn(ctx, job, { tokenUrl: `${base}/token`, deviceCode: String(json.device_code), interval: Number(json.interval ?? 5) }).catch((err) => {
    job.state = 'failed';
    job.error = errorText(err);
    ctx.log.error({ err }, 'Microsoft-App-Einrichtung fehlgeschlagen');
  });
  return toStatus(job);
}

/* ───────────── Warten auf die Anmeldung, dann einrichten ───────────── */

async function waitForSignIn(ctx: ModuleContext, job: Job, dc: { tokenUrl: string; deviceCode: string; interval: number }) {
  let interval = Math.max(dc.interval, 2);
  let tokens: { accessToken: string; idToken?: string } | null = null;

  while (job.state === 'waiting' && !tokens) {
    await sleep(interval * 1000);
    if (job.state !== 'waiting') return;
    if (Date.now() > job.expiresAt) {
      job.state = 'expired';
      job.error = 'Der Anmeldecode ist abgelaufen – bitte die Einrichtung neu starten.';
      return;
    }
    let res: Response;
    try {
      res = await fetch(dc.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: BOOTSTRAP_CLIENT_ID, device_code: dc.deviceCode }),
      });
    } catch {
      continue; // Netzwerkfehler → beim nächsten Intervall erneut
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.ok && json.access_token) {
      tokens = { accessToken: json.access_token, idToken: json.id_token };
      break;
    }
    switch (json.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'authorization_declined':
        job.state = 'failed';
        job.error = 'Die Anmeldung wurde bei Microsoft abgelehnt.';
        return;
      case 'expired_token':
        job.state = 'expired';
        job.error = 'Der Anmeldecode ist abgelaufen – bitte die Einrichtung neu starten.';
        return;
      default:
        job.state = 'failed';
        job.error = `Anmeldung fehlgeschlagen: ${cleanAadMessage(json.error_description ?? json.error ?? res.status)}`;
        return;
    }
  }
  if (!tokens || job.state !== 'waiting') return;

  const claims =
    decodeJwtPayload<{ tid?: string; preferred_username?: string; upn?: string }>(tokens.idToken) ??
    decodeJwtPayload<{ tid?: string; preferred_username?: string; upn?: string }>(tokens.accessToken);
  job.signedInAs = claims?.preferred_username ?? claims?.upn ?? null;
  job.state = 'working';
  try {
    job.result = await provision(ctx, job, tokens.accessToken, claims?.tid);
    job.state = 'done';
  } catch (err) {
    const running = job.steps.find((s) => s.status === 'running');
    if (running) running.status = 'failed';
    job.state = 'failed';
    job.error = errorText(err);
    ctx.log.warn({ err }, 'Microsoft-App-Einrichtung fehlgeschlagen');
  }
}

/* ───────────── Graph-Aufrufe ───────────── */

interface GraphApp {
  id: string;
  appId: string;
  displayName: string;
  signInAudience?: string;
  web?: { homePageUrl?: string | null; logoutUrl?: string | null; redirectUris?: string[]; implicitGrantSettings?: Record<string, boolean> };
  api?: Record<string, unknown> & { requestedAccessTokenVersion?: number | null };
  requiredResourceAccess?: { resourceAppId: string; resourceAccess: { id: string; type: string }[] }[];
}

type Graph = <T = any>(path: string, opts?: RequestOptions) => Promise<T>;

function graphClient(token: string): Graph {
  return (path, opts = {}) => apiJson(`${GRAPH}${path}`, { ...opts, token, noAuthError: true });
}

/**
 * Im Entra-Portal festgelegte Liste erlaubter Mandanten (Vorschau-Funktion, nur über Graph beta lesbar).
 * Liefert die Mandanten-IDs, null ohne Einschränkung, undefined wenn nicht ermittelbar.
 */
async function readAllowedTenants(token: string, objectId: string): Promise<string[] | null | undefined> {
  try {
    const res = await apiJson<{ signInAudienceRestrictions?: { '@odata.type'?: string; allowedTenantIds?: string[] } | null }>(
      withOData(`${GRAPH_BETA}/applications/${objectId}`, { $select: 'signInAudienceRestrictions' }),
      { token, noAuthError: true },
    );
    const r = res.signInAudienceRestrictions;
    if (!r || !/allowedTenantsAudience$/i.test(r['@odata.type'] ?? '')) return null;
    return r.allowedTenantIds ?? [];
  } catch {
    return undefined;
  }
}

const odata = (v: string) => v.replace(/'/g, "''");

/** OData-Abfrageparameter mit %20 statt "+" für Leerzeichen (sicher für $filter) */
function withOData(path: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${path}?${qs}`;
}

/**
 * Neu angelegte Objekte sind in Entra ID erst nach einigen Sekunden überall sichtbar.
 * 404 bzw. "existiert nicht"-Fehler werden daher eine Weile wiederholt.
 */
async function replicated<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const transient =
        err instanceof HttpError &&
        (err.status === 404 || (err.status === 400 && /does not exist|not present|valid application|not found/i.test(err.message)));
      if (!transient || i >= attempts - 1) throw err;
      await sleep(Math.min(2000 * (i + 1), 8000));
    }
  }
}

function addStep(job: Job, label: string) {
  const step: MsProvisionStep = { label, status: 'running' };
  job.steps.push(step);
  return {
    done(detail?: string) {
      step.status = 'done';
      step.detail = detail;
    },
    warn(detail: string) {
      step.status = 'warning';
      step.detail = detail;
    },
  };
}

async function provision(ctx: ModuleContext, job: Job, token: string, tenantId: string | undefined): Promise<MsProvisionedApp> {
  if (!tenantId) throw new Error('Tenant-ID konnte aus der Anmeldung nicht ermittelt werden.');
  const g = graphClient(token);
  const redirectUri = config.oauthRedirectUri;
  /** Tatsächlich verwendeter Kontotyp (kann von der Auswahl abweichen, s. erlaubte Mandanten) */
  let effective: MsAppAudience = job.audience;
  let allowedTenants: number | null = null;

  /* 1. Berechtigungen von Microsoft Graph nachschlagen (Name → ID) */
  let step = addStep(job, 'Microsoft-Graph-Berechtigungen nachschlagen');
  const graphSp = await g<{ id: string; oauth2PermissionScopes: { id: string; value: string }[] }>(
    withOData(`/servicePrincipals(appId='${GRAPH_APP_ID}')`, { $select: 'id,oauth2PermissionScopes' }),
  );
  const scopeIds = new Map(graphSp.oauth2PermissionScopes.map((p) => [p.value.toLowerCase(), p.id]));
  const missing = MS_SCOPES.filter((n) => !scopeIds.has(n.toLowerCase()));
  if (missing.length) throw new Error(`Microsoft Graph kennt folgende Berechtigungen nicht: ${missing.join(', ')}`);
  const graphAccess = MS_SCOPES.map((n) => ({ id: scopeIds.get(n.toLowerCase())!, type: 'Scope' }));
  const org = await g<{ value: { displayName?: string }[] }>(withOData('/organization', { $select: 'displayName' })).catch(() => null);
  const tenantName = org?.value?.[0]?.displayName ?? null;
  step.done(`${MS_SCOPES.length} delegierte Berechtigungen${tenantName ? ` · Organisation „${tenantName}“` : ''}`);

  /* 2. App-Registrierung anlegen oder aktualisieren */
  step = addStep(job, 'App-Registrierung anlegen');
  const prev = ctx.kv.get<StoredMeta>('system', META_KEY);
  let app: GraphApp | null = null;
  if (prev?.tenantId === tenantId) {
    app = await g<GraphApp>(`/applications/${prev.objectId}`).catch((err) => {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    });
  }
  if (!app) {
    // Gleichnamige App mit unserer Redirect-URI wiederverwenden (z. B. nach Neuinstallation)
    const found = await g<{ value: GraphApp[] }>(withOData('/applications', { $filter: `displayName eq '${odata(job.displayName)}'` }));
    app = found.value.find((a) => a.web?.redirectUris?.includes(redirectUri)) ?? null;
  }

  let created = false;
  let audienceNote = '';
  if (app?.signInAudience === SIGN_IN_AUDIENCE.orgs) {
    // Im Entra-Portal auf bestimmte Mandanten beschränkt → Einschränkung und Kontotyp beibehalten,
    // sonst würde das Ändern von signInAudience die Liste erlaubter Mandanten verwerfen.
    const allowed = await readAllowedTenants(token, app.id);
    if (allowed) {
      effective = 'orgs';
      allowedTenants = allowed.filter((id) => id.toLowerCase() !== tenantId.toLowerCase()).length;
      audienceNote = `im Entra-Portal festgelegte erlaubte Mandanten beibehalten (${allowedTenants} weitere Organisation${allowedTenants === 1 ? '' : 'en'})`;
    } else if (allowed === undefined && job.audience !== 'orgs') {
      effective = 'orgs';
      audienceNote = 'erlaubte Mandanten konnten nicht geprüft werden – Kontotyp „Mehrere Organisationen“ unverändert gelassen';
    }
    if (audienceNote && job.audience !== effective) audienceNote += ` · Auswahl „${AUDIENCE_LABEL[job.audience]}“ nicht übernommen (im Entra-Portal unter „Authentifizierung“ änderbar)`;
  }
  const audience = SIGN_IN_AUDIENCE[effective];

  if (app) {
    const otherResources = (app.requiredResourceAccess ?? []).filter((r) => r.resourceAppId !== GRAPH_APP_ID);
    const existing = app.requiredResourceAccess?.find((r) => r.resourceAppId === GRAPH_APP_ID)?.resourceAccess ?? [];
    const merged = [...existing, ...graphAccess.filter((a) => !existing.some((e) => e.id === a.id && e.type === a.type))];
    const patch: Record<string, unknown> = {
      web: {
        homePageUrl: app.web?.homePageUrl ?? null,
        logoutUrl: app.web?.logoutUrl ?? null,
        implicitGrantSettings: app.web?.implicitGrantSettings,
        redirectUris: [...new Set([...(app.web?.redirectUris ?? []), redirectUri])],
      },
      requiredResourceAccess: [...otherResources, { resourceAppId: GRAPH_APP_ID, resourceAccess: merged }],
    };
    if (app.signInAudience !== audience) {
      patch.signInAudience = audience;
      // Private Microsoft-Konten setzen Zugriffstoken v2 voraus
      if (effective === 'multi' && app.api?.requestedAccessTokenVersion !== 2) patch.api = { ...app.api, requestedAccessTokenVersion: 2 };
    }
    await g(`/applications/${app.id}`, { method: 'PATCH', body: patch });
    const detail = `Vorhandene App „${app.displayName}“ aktualisiert (App-ID ${app.appId})`;
    if (audienceNote && job.audience !== effective) step.warn(`${detail} · ${audienceNote}`);
    else step.done(audienceNote ? `${detail} · ${audienceNote}` : detail);
  } else {
    app = await g<GraphApp>('/applications', {
      method: 'POST',
      retries: 0,
      body: {
        displayName: job.displayName,
        signInAudience: audience,
        notes: `Automatisch angelegt von Kuvert (${config.publicUrl}).`,
        web: {
          redirectUris: [redirectUri],
          implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
        },
        api: { requestedAccessTokenVersion: 2 },
        requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: graphAccess }],
      },
    });
    created = true;
    step.done(`„${app.displayName}“ angelegt (App-ID ${app.appId})`);
  }
  const theApp = app;

  /* 3. Dienstprinzipal (Unternehmensanwendung) */
  step = addStep(job, 'Unternehmensanwendung anlegen');
  const sp = await replicated(async () => {
    const list = await g<{ value: { id: string }[] }>(withOData('/servicePrincipals', { $filter: `appId eq '${theApp.appId}'`, $select: 'id' }));
    if (list.value[0]) return { id: list.value[0].id, created: false };
    const createdSp = await g<{ id: string }>('/servicePrincipals', {
      method: 'POST',
      retries: 0,
      body: { appId: theApp.appId, tags: ['WindowsAzureActiveDirectoryIntegratedApp'] },
    });
    return { id: createdSp.id, created: true };
  });
  step.done(sp.created ? 'Angelegt' : 'Bereits vorhanden');

  /* 4. Administratorzustimmung für alle Benutzer der Organisation */
  step = addStep(job, 'Administratorzustimmung für die Organisation erteilen');
  let consentGranted = false;
  try {
    const grants = await replicated(() =>
      g<{ value: { id: string; consentType: string; resourceId: string; scope?: string }[] }>(
        withOData('/oauth2PermissionGrants', { $filter: `clientId eq '${sp.id}'` }),
      ),
    );
    const grant = grants.value.find((x) => x.consentType === 'AllPrincipals' && x.resourceId === graphSp.id);
    if (grant) {
      const scopes = new Set([...(grant.scope ?? '').split(' ').filter(Boolean), ...MS_SCOPES]);
      await g(`/oauth2PermissionGrants/${grant.id}`, { method: 'PATCH', body: { scope: [...scopes].join(' ') } });
    } else {
      await replicated(() =>
        g('/oauth2PermissionGrants', {
          method: 'POST',
          retries: 0,
          body: { clientId: sp.id, consentType: 'AllPrincipals', resourceId: graphSp.id, scope: MS_SCOPES.join(' ') },
        }),
      );
    }
    consentGranted = true;
    step.done('Benutzer der Organisation müssen nicht einzeln zustimmen');
  } catch (err) {
    step.warn(
      `Nicht möglich (${errorText(err)}). Kuvert funktioniert trotzdem – die Zustimmung kann im Entra-Portal unter „API-Berechtigungen → Administratorzustimmung erteilen“ nachgeholt werden.`,
    );
  }

  /* 5. Geheimen Clientschlüssel erzeugen */
  step = addStep(job, 'Geheimen Clientschlüssel erzeugen');
  const secret = await addSecret(g, theApp.id);
  step.done(`Gültig bis ${new Date(secret.endDateTime).toLocaleDateString('de-DE')}`);

  /* 6. In Kuvert übernehmen */
  step = addStep(job, 'Zugangsdaten in Kuvert speichern');
  const tenant = effective === 'tenant' ? tenantId : effective === 'orgs' ? 'organizations' : 'common';
  const previousClientId = config.microsoft.clientId;
  systemSettings.update({ microsoft: { clientId: theApp.appId, clientSecret: secret.secretText, tenant } });
  for (const acc of ctx.accounts.listAllEnabled()) if (acc.type === 'microsoft') await ctx.accounts.invalidate(acc.id);

  // Den beim letzten Mal von Kuvert erzeugten Schlüssel entfernen (wird nicht mehr verwendet)
  let removedOld = false;
  if (prev?.keyId && prev.objectId === theApp.id && prev.keyId !== secret.keyId) {
    removedOld = await g(`/applications/${theApp.id}/removePassword`, { method: 'POST', body: { keyId: prev.keyId } })
      .then(() => true)
      .catch(() => false);
  }

  const now = new Date().toISOString();
  const meta: StoredMeta = {
    appId: theApp.appId,
    objectId: theApp.id,
    displayName: theApp.displayName,
    tenantId,
    tenantName,
    audience: effective,
    allowedTenants,
    secretExpiresAt: secret.endDateTime,
    keyId: secret.keyId,
    consentGranted,
    provisionedAt: now,
    provisionedBy: job.signedInAs ?? null,
  };
  ctx.kv.set('system', META_KEY, meta);
  const clientChanged = !!previousClientId && previousClientId !== theApp.appId;
  step.done(
    [
      `Client-ID, Geheimnis und Mandant (${tenant}) hinterlegt`,
      removedOld ? 'alter Schlüssel entfernt' : '',
      clientChanged ? 'bereits verbundene Microsoft-Konten müssen neu verbunden werden' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  audit.log('admin.microsoft_app_provisioned', {
    actorId: job.userId,
    details: { appId: theApp.appId, tenantId, audience: effective, allowedTenants, created, consentGranted, microsoftAdmin: job.signedInAs ?? null },
  });
  const { keyId: _keyId, ...publicMeta } = meta;
  return { ...publicMeta, portalUrl: portalUrl(theApp.appId) };
}

async function addSecret(g: Graph, objectId: string): Promise<{ secretText: string; keyId: string; endDateTime: string }> {
  let lastErr: unknown;
  for (const months of SECRET_MONTHS) {
    const end = new Date();
    end.setMonth(end.getMonth() + months);
    try {
      return await replicated(() =>
        g(`/applications/${objectId}/addPassword`, {
          method: 'POST',
          retries: 0,
          body: { passwordCredential: { displayName: `Kuvert ${new Date().toISOString().slice(0, 10)}`, endDateTime: end.toISOString() } },
        }),
      );
    } catch (err) {
      lastErr = err;
      // 400 = z. B. Richtlinie für maximale Laufzeit → kürzere Laufzeit versuchen
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
    }
  }
  throw lastErr;
}
