/**
 * IMAP/SMTP-Konfiguration: Formularfelder, Normalisierung, Verbindungsoptionen
 * und die Einrichtung (inkl. Verbindungstest).
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import type { FieldDef } from '@kuvert/shared';
import { AppError, AuthError, BadRequestError } from '../../core/errors.js';
import type { AccountSetupResult } from '../../core/module.js';

export type Security = 'ssl' | 'starttls' | 'none';

export interface ImapConfig {
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
  smtpUser: string;
  aliases: string;
  appendSent: boolean;
  allowSelfSigned: boolean;
}

export interface ImapSecrets {
  imapPassword: string;
  smtpPassword?: string;
}

const securityOptions = [
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'Keine (unsicher)' },
];

export const imapFields: FieldDef[] = [
  { key: 'name', label: 'Ihr Name (Absendername)', type: 'text', required: true, group: 'Allgemein', placeholder: 'Max Mustermann' },
  { key: 'email', label: 'E-Mail-Adresse', type: 'email', required: true, group: 'Allgemein', placeholder: 'max@example.com' },
  { key: 'imapHost', label: 'IMAP-Server', type: 'text', required: true, group: 'IMAP', placeholder: 'imap.example.com' },
  { key: 'imapPort', label: 'Port', type: 'number', required: true, default: 993, group: 'IMAP' },
  { key: 'imapSecurity', label: 'Verschlüsselung', type: 'select', default: 'ssl', options: securityOptions, group: 'IMAP' },
  { key: 'imapUser', label: 'Benutzername', type: 'text', group: 'IMAP', help: 'Leer = E-Mail-Adresse' },
  { key: 'imapPassword', label: 'Passwort', type: 'password', required: true, secret: true, group: 'IMAP' },
  { key: 'smtpHost', label: 'SMTP-Server', type: 'text', required: true, group: 'SMTP', placeholder: 'smtp.example.com' },
  { key: 'smtpPort', label: 'Port', type: 'number', required: true, default: 587, group: 'SMTP' },
  { key: 'smtpSecurity', label: 'Verschlüsselung', type: 'select', default: 'starttls', options: securityOptions, group: 'SMTP' },
  { key: 'smtpUser', label: 'Benutzername', type: 'text', group: 'SMTP', help: 'Leer = IMAP-Benutzername' },
  { key: 'smtpPassword', label: 'Passwort', type: 'password', secret: true, group: 'SMTP', help: 'Leer = IMAP-Passwort' },
  {
    key: 'aliases',
    label: 'Weitere Absenderadressen',
    type: 'textarea',
    group: 'Optionen',
    placeholder: 'Vertrieb <vertrieb@example.com>\ninfo@example.com',
    help: 'Eine Adresse pro Zeile oder durch Komma getrennt',
  },
  {
    key: 'appendSent',
    label: 'Gesendete Nachrichten im Ordner „Gesendet“ ablegen',
    type: 'checkbox',
    default: true,
    group: 'Optionen',
    help: 'Deaktivieren, wenn der Server das selbst erledigt (z. B. Gmail, Office 365)',
  },
  { key: 'allowSelfSigned', label: 'Selbstsignierte Zertifikate erlauben', type: 'checkbox', default: false, group: 'Optionen' },
];

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const bool = (v: unknown, def: boolean) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');
const sec = (v: unknown, def: Security): Security => (v === 'ssl' || v === 'starttls' || v === 'none' ? v : def);

/** Prüft und normalisiert die Formularwerte. */
export function normalize(values: Record<string, unknown>): { config: ImapConfig; secrets: ImapSecrets } {
  const email = str(values.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestError('Bitte eine gültige E-Mail-Adresse angeben');
  const imapHost = str(values.imapHost);
  const smtpHost = str(values.smtpHost);
  if (!imapHost) throw new BadRequestError('IMAP-Server fehlt');
  if (!smtpHost) throw new BadRequestError('SMTP-Server fehlt');
  const imapPassword = str(values.imapPassword);
  if (!imapPassword) throw new BadRequestError('Passwort fehlt');
  const imapPort = Number(values.imapPort) || 993;
  const smtpPort = Number(values.smtpPort) || 587;
  const imapUser = str(values.imapUser) || email;
  const config: ImapConfig = {
    name: str(values.name) || email,
    email,
    imapHost,
    imapPort,
    imapSecurity: sec(values.imapSecurity, imapPort === 993 ? 'ssl' : 'starttls'),
    imapUser,
    smtpHost,
    smtpPort,
    smtpSecurity: sec(values.smtpSecurity, smtpPort === 465 ? 'ssl' : 'starttls'),
    smtpUser: str(values.smtpUser),
    aliases: str(values.aliases),
    appendSent: bool(values.appendSent, true),
    allowSelfSigned: bool(values.allowSelfSigned, false),
  };
  const secrets: ImapSecrets = { imapPassword };
  const smtpPassword = str(values.smtpPassword);
  if (smtpPassword) secrets.smtpPassword = smtpPassword;
  return { config, secrets };
}

export function imapOptions(config: ImapConfig, secrets: ImapSecrets): ImapFlowOptions {
  return {
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecurity === 'ssl',
    doSTARTTLS: config.imapSecurity === 'starttls' ? true : config.imapSecurity === 'none' ? false : undefined,
    auth: { user: config.imapUser || config.email, pass: secrets.imapPassword },
    tls: { rejectUnauthorized: !config.allowSelfSigned },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
    clientInfo: { name: 'Kuvert', vendor: 'Kuvert' },
  };
}

export function smtpTransport(config: ImapConfig, secrets: ImapSecrets): Transporter {
  return createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecurity === 'ssl',
    requireTLS: config.smtpSecurity === 'starttls',
    ignoreTLS: config.smtpSecurity === 'none',
    auth: {
      user: config.smtpUser || config.imapUser || config.email,
      pass: secrets.smtpPassword || secrets.imapPassword,
    },
    tls: { rejectUnauthorized: !config.allowSelfSigned },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

/** Wandelt imapflow-/Netzwerkfehler in verständliche Fehler um. */
export function mapImapError(err: unknown, host?: string): Error {
  if (err instanceof AppError) return err;
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string; serverResponseCode?: string };
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new AuthError('IMAP-Anmeldung fehlgeschlagen – Benutzername oder Passwort falsch');
  }
  const code = e?.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return new AppError(502, 'imap_unreachable', `IMAP-Server ${host ?? ''} nicht gefunden`);
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'NoConnection', 'EConnectionClosed'].includes(code)) {
    return new AppError(502, 'imap_unreachable', `Verbindung zum IMAP-Server ${host ?? ''} fehlgeschlagen (${code})`);
  }
  if (/certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY/i.test(`${code} ${e?.message ?? ''}`)) {
    return new AppError(502, 'imap_tls', `TLS-Zertifikat des Servers ungültig: ${e?.message ?? code}`);
  }
  const text = e?.responseText || e?.message || String(err);
  return new AppError(502, 'imap_error', `IMAP-Fehler: ${text}`);
}

/** Einrichtung: Werte prüfen, IMAP-Login und SMTP-Verbindung testen. */
export async function setupImap(values: Record<string, unknown>): Promise<AccountSetupResult> {
  const { config, secrets } = normalize(values);

  const client = new ImapFlow(imapOptions(config, secrets));
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    const mapped = mapImapError(err, config.imapHost);
    if (mapped instanceof AuthError) throw new BadRequestError('IMAP-Anmeldung fehlgeschlagen – bitte Benutzername und Passwort prüfen');
    throw new BadRequestError(mapped.message);
  } finally {
    await client.logout().catch(() => client.close());
  }

  const transport = smtpTransport(config, secrets);
  try {
    await transport.verify();
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    if (e.code === 'EAUTH' || e.responseCode === 535) {
      throw new BadRequestError('SMTP-Anmeldung fehlgeschlagen – bitte SMTP-Benutzername und -Passwort prüfen');
    }
    throw new BadRequestError(`SMTP-Verbindung fehlgeschlagen: ${e.message ?? String(err)}`);
  } finally {
    transport.close();
  }

  return {
    email: config.email,
    name: config.name,
    config: { ...config },
    secrets: { ...secrets },
  };
}
