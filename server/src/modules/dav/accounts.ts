/**
 * Kontotypen des DAV-Moduls: CalDAV/CardDAV (generisch), Nextcloud und WebDAV-Speicher.
 */
import { createClient } from 'webdav';
import type { Capability, FieldDef } from '@kuvert/shared';
import { AppError, AuthError, BadRequestError } from '../../core/errors.js';
import type { AccountContext, AccountRecord, AccountSetupResult, AccountTypeDefinition } from '../../core/module.js';
import type { ProviderSet } from '../../core/providers.js';
import { DavCalendarProvider } from './calendar.js';
import { DavContactsProvider } from './contacts.js';
import { DavSession, mapDavError } from './session.js';
import { WebDavStorage, nextcloudUserInfo } from './storage.js';

/* ───────────────────────────── Hilfen ───────────────────────────── */

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const bool = (v: unknown, def: boolean) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

function normalizeUrl(v: unknown, label = 'Server-URL'): string {
  let s = str(v);
  if (!s) throw new BadRequestError(`${label} fehlt`);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.toString().replace(/\/+$/, '');
  } catch {
    throw new BadRequestError(`${label} ist ungültig`);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'dav';
  }
}

function emailFor(username: string, explicit: string, serverUrl: string): string {
  if (explicit.includes('@')) return explicit.toLowerCase();
  if (username.includes('@')) return username.toLowerCase();
  return `${username}@${hostOf(serverUrl)}`;
}

/** Eigene Adressen für Einladungen/Teilnehmer-Erkennung */
function ownEmails(acc: AccountRecord): string[] {
  const list = [acc.email, acc.config.email, acc.config.username].filter((x): x is string => typeof x === 'string' && x.includes('@'));
  return [...new Set(list.map((x) => x.toLowerCase()))];
}

function setupError(err: unknown, what: string): never {
  const mapped = err instanceof AppError ? err : mapDavError(err, what);
  if (mapped instanceof AuthError) throw new BadRequestError(`${what}: Anmeldung fehlgeschlagen – bitte Benutzername und Passwort prüfen`);
  throw new BadRequestError(mapped.message);
}

/* ═════════════════════════════ CalDAV / CardDAV ═════════════════════════════ */

const caldavFields: FieldDef[] = [
  { key: 'name', label: 'Kontoname', type: 'text', placeholder: 'z. B. Privat-Kalender' },
  { key: 'serverUrl', label: 'Server-URL', type: 'url', required: true, placeholder: 'https://dav.example.com/', help: 'Basis-URL oder Principal-URL des CalDAV/CardDAV-Servers' },
  { key: 'username', label: 'Benutzername', type: 'text', required: true },
  { key: 'password', label: 'Passwort', type: 'password', required: true, secret: true },
  { key: 'email', label: 'E-Mail-Adresse (für Einladungen)', type: 'email', help: 'Optional – zum Erkennen der eigenen Teilnahme an Terminen' },
  { key: 'enableCalendar', label: 'Kalender und Aufgaben (CalDAV)', type: 'checkbox', default: true, group: 'Dienste' },
  { key: 'enableContacts', label: 'Kontakte (CardDAV)', type: 'checkbox', default: true, group: 'Dienste' },
];

async function setupCaldav(values: Record<string, unknown>): Promise<AccountSetupResult> {
  const serverUrl = normalizeUrl(values.serverUrl);
  const username = str(values.username);
  const password = str(values.password);
  if (!username) throw new BadRequestError('Benutzername fehlt');
  if (!password) throw new BadRequestError('Passwort fehlt');
  let enableCalendar = bool(values.enableCalendar, true);
  let enableContacts = bool(values.enableContacts, true);
  if (!enableCalendar && !enableContacts) throw new BadRequestError('Bitte mindestens Kalender oder Kontakte aktivieren');

  const session = new DavSession(() => ({ serverUrl, username, password }));
  const errors: string[] = [];
  let anyOk = false;
  if (enableCalendar) {
    try {
      const c = await session.caldav();
      await c.fetchCalendars();
      anyOk = true;
    } catch (err) {
      const mapped = mapDavError(err, 'CalDAV');
      if (mapped instanceof AuthError) setupError(mapped, 'CalDAV');
      errors.push(`Kalender: ${mapped.message}`);
      enableCalendar = false;
    }
  }
  if (enableContacts) {
    try {
      const c = await session.carddav();
      await c.fetchAddressBooks();
      anyOk = true;
    } catch (err) {
      const mapped = mapDavError(err, 'CardDAV');
      if (mapped instanceof AuthError) setupError(mapped, 'CardDAV');
      errors.push(`Kontakte: ${mapped.message}`);
      enableContacts = false;
    }
  }
  if (!anyOk) throw new BadRequestError(`Verbindung fehlgeschlagen – ${errors.join('; ')}`);

  const email = emailFor(username, str(values.email), serverUrl);
  return {
    email,
    name: str(values.name) || `${hostOf(serverUrl)} (${username})`,
    config: { name: str(values.name), serverUrl, username, email: str(values.email), enableCalendar, enableContacts },
    secrets: { password },
  };
}

function caldavCapabilities(acc: AccountRecord): Capability[] {
  const caps: Capability[] = [];
  if (acc.config.enableCalendar !== false) caps.push('calendar', 'tasks');
  if (acc.config.enableContacts !== false) caps.push('contacts');
  return caps;
}

function caldavProviders(ctx: AccountContext): ProviderSet {
  const session = new DavSession(() => ({
    serverUrl: ctx.account.config.serverUrl,
    username: ctx.account.config.username,
    password: ctx.account.secrets.password,
  }));
  const set: ProviderSet = {};
  const cfg = ctx.account.config;
  if (cfg.enableCalendar !== false) {
    const cal = new DavCalendarProvider(ctx, session, () => ownEmails(ctx.account));
    set.calendar = cal;
    set.tasks = cal;
  }
  if (cfg.enableContacts !== false) set.contacts = new DavContactsProvider(ctx, session);
  return set;
}

export const caldavAccountType: AccountTypeDefinition = {
  type: 'caldav',
  label: 'CalDAV / CardDAV',
  description: 'Kalender, Aufgaben und Kontakte von einem beliebigen DAV-Server (z. B. Radicale, Baïkal, iCloud, mailbox.org)',
  icon: 'calendar',
  capabilities: ['calendar', 'contacts', 'tasks'],
  auth: 'form',
  fields: caldavFields,
  setup: setupCaldav,
  getCapabilities: caldavCapabilities,
  createProviders: caldavProviders,
};

/* ═════════════════════════════ Nextcloud ═════════════════════════════ */

const nextcloudFields: FieldDef[] = [
  { key: 'name', label: 'Kontoname', type: 'text', placeholder: 'z. B. Firmen-Cloud' },
  { key: 'serverUrl', label: 'Nextcloud-Adresse', type: 'url', required: true, placeholder: 'https://cloud.example.com' },
  { key: 'username', label: 'Benutzername', type: 'text', required: true },
  {
    key: 'appPassword',
    label: 'App-Passwort',
    type: 'password',
    required: true,
    secret: true,
    help: 'App-Passwort aus Nextcloud → Einstellungen → Sicherheit',
  },
];

function nextcloudBase(v: unknown): string {
  let url = normalizeUrl(v, 'Nextcloud-Adresse');
  // Häufig eingefügte Unterpfade entfernen
  url = url.replace(/\/(index\.php|remote\.php|apps|ocs|login)(\/.*)?$/i, '');
  return url.replace(/\/+$/, '');
}

async function setupNextcloud(values: Record<string, unknown>): Promise<AccountSetupResult> {
  const serverUrl = nextcloudBase(values.serverUrl);
  const username = str(values.username);
  const appPassword = str(values.appPassword);
  if (!username) throw new BadRequestError('Benutzername fehlt');
  if (!appPassword) throw new BadRequestError('App-Passwort fehlt');
  let info: { id: string; displayName?: string; email?: string };
  try {
    info = await nextcloudUserInfo(serverUrl, username, appPassword);
  } catch (err) {
    setupError(err, 'Nextcloud');
  }
  const email = info.email?.includes('@') ? info.email.toLowerCase() : emailFor(username, '', serverUrl);
  return {
    email,
    name: str(values.name) || `Nextcloud (${hostOf(serverUrl)})`,
    config: { name: str(values.name), serverUrl, username, userId: info.id, email: info.email ?? '', displayName: info.displayName ?? '' },
    secrets: { appPassword },
  };
}

function nextcloudProviders(ctx: AccountContext): ProviderSet {
  const cfg = () => ctx.account.config;
  const session = new DavSession(() => ({
    serverUrl: `${cfg().serverUrl}/remote.php/dav`,
    username: cfg().username,
    password: ctx.account.secrets.appPassword,
  }));
  const cal = new DavCalendarProvider(ctx, session, () => ownEmails(ctx.account));
  const userId = String(cfg().userId || cfg().username);
  return {
    calendar: cal,
    tasks: cal,
    contacts: new DavContactsProvider(ctx, session),
    storage: new WebDavStorage(ctx, {
      rootUrl: `${cfg().serverUrl}/remote.php/dav/files/${encodeURIComponent(userId)}`,
      username: cfg().username,
      password: ctx.account.secrets.appPassword,
      nextcloud: { serverUrl: cfg().serverUrl, userId },
    }),
  };
}

export const nextcloudAccountType: AccountTypeDefinition = {
  type: 'nextcloud',
  label: 'Nextcloud',
  description: 'Kalender, Aufgaben, Kontakte und Dateien (inkl. Freigabelinks) aus Nextcloud',
  icon: 'cloud',
  capabilities: ['calendar', 'contacts', 'tasks', 'storage'],
  auth: 'form',
  fields: nextcloudFields,
  setup: setupNextcloud,
  createProviders: nextcloudProviders,
};

/* ═════════════════════════════ WebDAV-Speicher ═════════════════════════════ */

const webdavFields: FieldDef[] = [
  { key: 'name', label: 'Kontoname', type: 'text', placeholder: 'z. B. NAS' },
  { key: 'serverUrl', label: 'WebDAV-URL', type: 'url', required: true, placeholder: 'https://nas.example.com/webdav' },
  { key: 'username', label: 'Benutzername', type: 'text', required: true },
  { key: 'password', label: 'Passwort', type: 'password', required: true, secret: true },
];

async function setupWebdav(values: Record<string, unknown>): Promise<AccountSetupResult> {
  const serverUrl = normalizeUrl(values.serverUrl, 'WebDAV-URL');
  const username = str(values.username);
  const password = str(values.password);
  if (!username) throw new BadRequestError('Benutzername fehlt');
  if (!password) throw new BadRequestError('Passwort fehlt');
  try {
    await createClient(serverUrl, { username, password }).getDirectoryContents('/');
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401) throw new BadRequestError('WebDAV: Anmeldung fehlgeschlagen – bitte Benutzername und Passwort prüfen');
    throw new BadRequestError(`WebDAV-Verbindung fehlgeschlagen: ${(err as Error).message}`);
  }
  return {
    email: emailFor(username, '', serverUrl),
    name: str(values.name) || `WebDAV (${hostOf(serverUrl)})`,
    config: { name: str(values.name), serverUrl, username },
    secrets: { password },
  };
}

export const webdavAccountType: AccountTypeDefinition = {
  type: 'webdav',
  label: 'WebDAV-Speicher',
  description: 'Dateien von einem beliebigen WebDAV-Server (NAS, ownCloud, Hosting …)',
  icon: 'hard-drive',
  capabilities: ['storage'],
  auth: 'form',
  fields: webdavFields,
  setup: setupWebdav,
  createProviders: (ctx) => ({
    storage: new WebDavStorage(ctx, {
      rootUrl: ctx.account.config.serverUrl,
      username: ctx.account.config.username,
      password: ctx.account.secrets.password,
    }),
  }),
};
