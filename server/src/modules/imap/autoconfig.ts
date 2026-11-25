/**
 * Automatische Servererkennung über die Thunderbird-ISPDB bzw. die
 * Autoconfig-Datei des Providers (config-v1.1.xml).
 */
import type { Security } from './config.js';

export interface AutoconfigResult {
  found: boolean;
  source?: string;
  values: {
    imapHost?: string;
    imapPort?: number;
    imapSecurity?: Security;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecurity?: Security;
    /** Benutzername-Schema: "email" (vollständige Adresse) oder "local" (Teil vor dem @) */
    usernameStyle?: 'email' | 'local';
  };
}

function mapSocket(t: string | undefined): Security | undefined {
  switch ((t ?? '').toUpperCase()) {
    case 'SSL':
      return 'ssl';
    case 'STARTTLS':
      return 'starttls';
    case 'PLAIN':
      return 'none';
    default:
      return undefined;
  }
}

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i'))?.[1];
}

interface ServerEntry {
  host?: string;
  port?: number;
  security?: Security;
  username?: string;
}

function parseServers(xml: string, kind: 'incomingServer' | 'outgoingServer', type: string): ServerEntry[] {
  const re = new RegExp(`<${kind}[^>]*type=["']${type}["'][^>]*>([\\s\\S]*?)</${kind}>`, 'gi');
  const out: ServerEntry[] = [];
  for (const m of xml.matchAll(re)) {
    const block = m[1]!;
    out.push({
      host: tag(block, 'hostname'),
      port: Number(tag(block, 'port')) || undefined,
      security: mapSocket(tag(block, 'socketType')),
      username: tag(block, 'username'),
    });
  }
  // SSL bevorzugen, dann STARTTLS, unverschlüsselt zuletzt
  const rank = (s: ServerEntry) => (s.security === 'ssl' ? 0 : s.security === 'starttls' ? 1 : 2);
  return out.filter((s) => s.host).sort((a, b) => rank(a) - rank(b));
}

async function fetchXml(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/xml, text/xml' } });
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.includes('clientConfig') ? text : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupAutoconfig(email: string): Promise<AutoconfigResult> {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { found: false, values: {} };
  const local = email.split('@')[0] ?? '';

  const sources = [
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  ];
  for (const url of sources) {
    const xml = await fetchXml(url);
    if (!xml) continue;
    const imap = parseServers(xml, 'incomingServer', 'imap')[0];
    const smtp = parseServers(xml, 'outgoingServer', 'smtp')[0];
    if (!imap?.host || !smtp?.host) continue;
    const resolve = (h: string) => h.replace(/%EMAILDOMAIN%/gi, domain).replace(/%EMAILLOCALPART%/gi, local);
    return {
      found: true,
      source: new URL(url).host,
      values: {
        imapHost: resolve(imap.host),
        imapPort: imap.port ?? (imap.security === 'ssl' ? 993 : 143),
        imapSecurity: imap.security ?? 'ssl',
        smtpHost: resolve(smtp.host),
        smtpPort: smtp.port ?? (smtp.security === 'ssl' ? 465 : 587),
        smtpSecurity: smtp.security ?? 'starttls',
        usernameStyle: /%EMAILLOCALPART%/i.test(imap.username ?? '') ? 'local' : 'email',
      },
    };
  }
  return { found: false, values: {} };
}
