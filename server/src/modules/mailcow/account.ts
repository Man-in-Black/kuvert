/**
 * Kontotyp "mailcow": ein Formular, alles eingerichtet – Mail über IMAP/SMTP des
 * mailcow-Servers, Kalender/Aufgaben/Kontakte über SOGo (CalDAV/CardDAV).
 * Nutzt die Provider der Module "imap" und "dav".
 */
import type { Capability, FieldDef } from '@kuvert/shared';
import { AuthError, BadRequestError } from '../../core/errors.js';
import type { AccountContext, AccountRecord, AccountSetupResult, AccountTypeDefinition } from '../../core/module.js';
import type { ProviderSet } from '../../core/providers.js';
import { setupImap, normalize as normalizeImap } from '../imap/config.js';
import { ImapMailProvider } from '../imap/provider.js';
import { DavCalendarProvider } from '../dav/calendar.js';
import { DavContactsProvider } from '../dav/contacts.js';
import { DavSession, mapDavError } from '../dav/session.js';
import { instances } from './store.js';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const bool = (v: unknown, def: boolean) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

export const sogoDavUrl = (host: string) => `https://${host}/SOGo/dav/`;

function cleanHost(v: string): string {
  return v
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

/** Formularfelder – die Instanzauswahl wird bei jedem Abruf neu aufgebaut */
function fields(): FieldDef[] {
  const list = instances.list();
  const f: FieldDef[] = [
    { key: 'name', label: 'Ihr Name (Absendername)', type: 'text', required: true, placeholder: 'Max Mustermann' },
    { key: 'email', label: 'E-Mail-Adresse (mailcow-Postfach)', type: 'email', required: true, placeholder: 'max@example.com' },
    { key: 'password', label: 'Passwort des Postfachs', type: 'password', required: true, secret: true, help: 'Bei aktivierter 2FA in mailcow ein App-Passwort verwenden' },
  ];
  if (list.length) {
    f.push({
      key: 'instanceId',
      label: 'mailcow-Server',
      type: 'select',
      default: list[0]!.id,
      options: [...list.map((i) => ({ value: i.id, label: `${i.name} (${i.hostname})` })), { value: '', label: 'Anderer Server …' }],
    });
    f.push({ key: 'hostname', label: 'Hostname des mailcow-Servers', type: 'text', placeholder: 'mail.example.com', showIf: { key: 'instanceId', equals: '' } });
  } else {
    f.push({ key: 'hostname', label: 'Hostname des mailcow-Servers', type: 'text', required: true, placeholder: 'mail.example.com' });
  }
  f.push({ key: 'enableDav', label: 'Kalender, Aufgaben & Kontakte über SOGo einbinden', type: 'checkbox', default: true, group: 'Optionen' });
  return f;
}

export interface MailcowSetupInput {
  name?: string;
  email: string;
  password: string;
  instanceId?: string;
  hostname?: string;
  enableDav?: boolean;
}

/**
 * Baut die Kontokonfiguration. Mit verify=true werden IMAP/SMTP (und SOGo) geprüft –
 * das beweist zugleich, dass der Benutzer das Postfach besitzt.
 */
export async function buildMailcowSetup(values: Record<string, unknown>, opts: { verify: boolean }): Promise<AccountSetupResult> {
  const email = str(values.email).toLowerCase();
  const password = str(values.password) || str(values.imapPassword);
  if (!password) throw new BadRequestError('Passwort fehlt');
  const instanceId = str(values.instanceId);
  let host = '';
  if (instanceId) host = instances.get(instanceId).hostname;
  else host = cleanHost(str(values.hostname));
  if (!host) throw new BadRequestError('Bitte mailcow-Server auswählen oder Hostname angeben');
  const matched = instanceId || instances.findByHost(host)?.id || '';

  const imapValues: Record<string, unknown> = {
    name: str(values.name) || email,
    email,
    imapHost: host,
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUser: email,
    imapPassword: password,
    smtpHost: host,
    smtpPort: 587,
    smtpSecurity: 'starttls',
    appendSent: true,
  };
  const imap = opts.verify ? await setupImap(imapValues) : (() => {
    const n = normalizeImap(imapValues);
    return { email: n.config.email, name: n.config.name, config: { ...n.config }, secrets: { ...n.secrets } } as AccountSetupResult;
  })();

  let enableDav = bool(values.enableDav, true);
  const serverUrl = sogoDavUrl(host);
  if (enableDav && opts.verify) {
    try {
      const session = new DavSession(() => ({ serverUrl, username: email, password }));
      await (await session.caldav()).fetchCalendars();
    } catch (err) {
      // SOGo für das Postfach deaktiviert oder nicht erreichbar → nur Mail einrichten
      const mapped = mapDavError(err, 'SOGo');
      if (!(mapped instanceof AuthError) && !/nicht erreichbar|not found|404/i.test(mapped.message)) throw new BadRequestError(mapped.message);
      enableDav = false;
    }
  }

  return {
    email,
    name: imap.name,
    config: {
      ...(imap.config ?? {}),
      instanceId: matched,
      hostname: host,
      enableDav,
      serverUrl,
      username: email,
      enableCalendar: enableDav,
      enableContacts: enableDav,
    },
    secrets: { imapPassword: password },
  };
}

function capabilities(acc: AccountRecord): Capability[] {
  const caps: Capability[] = ['mail'];
  if (acc.config.enableDav !== false) caps.push('calendar', 'tasks', 'contacts');
  return caps;
}

function providers(ctx: AccountContext): ProviderSet {
  const set: ProviderSet = { mail: new ImapMailProvider(ctx) };
  if (ctx.account.config.enableDav !== false) {
    const session = new DavSession(() => ({
      serverUrl: ctx.account.config.serverUrl || sogoDavUrl(ctx.account.config.hostname),
      username: ctx.account.config.username || ctx.account.email,
      password: ctx.account.secrets.imapPassword,
    }));
    const cal = new DavCalendarProvider(ctx, session, () => [ctx.account.email.toLowerCase()]);
    set.calendar = cal;
    set.tasks = cal;
    set.contacts = new DavContactsProvider(ctx, session);
  }
  return set;
}

export const mailcowAccountType: AccountTypeDefinition = {
  type: 'mailcow',
  label: 'mailcow',
  description: 'Postfach auf einem mailcow-Server: E-Mail, Kalender, Aufgaben und Kontakte (SOGo) in einem Schritt',
  icon: 'mail',
  capabilities: ['mail', 'calendar', 'tasks', 'contacts'],
  auth: 'form',
  get fields() {
    return fields();
  },
  setup: (values) => buildMailcowSetup(values, { verify: true }),
  getCapabilities: capabilities,
  createProviders: providers,
};
