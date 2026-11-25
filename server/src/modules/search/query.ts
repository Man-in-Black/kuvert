/**
 * Suchbefehle in der Eingabe (ähnlich Gmail):
 *   from:anna  to:bob@x.de  subject:rechnung  has:attachment  is:unread  is:read
 *   is:flagged  in:inbox|sent|drafts|archive|trash|junk  after:2026-01-31  before:31.12.2025
 *   "exakte Phrase"
 * Deutsche Varianten: von: an: betreff: hat:anhang ist:ungelesen ist:gelesen ist:markiert in:posteingang …
 */
import type { FolderRole } from '@kuvert/shared';
import { q } from './meili.js';

export interface ParsedQuery {
  /** Freitext für die Volltextsuche */
  text: string;
  /** Meilisearch-Filterausdrücke (UND-verknüpft) */
  filters: string[];
}

const ROLE_ALIASES: Record<string, FolderRole> = {
  inbox: 'inbox',
  posteingang: 'inbox',
  sent: 'sent',
  gesendet: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  entwuerfe: 'drafts',
  entwürfe: 'drafts',
  archive: 'archive',
  archiv: 'archive',
  trash: 'trash',
  papierkorb: 'trash',
  junk: 'junk',
  spam: 'junk',
};

function parseDate(v: string): number | null {
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) / 1000;
  m = v.match(/^(\d{4})$/);
  if (m) return Date.UTC(Number(m[1]), 0, 1) / 1000;
  return null;
}

/** Zerlegt Text in Suchbegriffe für die Felder fromTerms/toTerms */
export function terms(...values: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const lower = v.toLowerCase();
    out.add(lower);
    for (const t of lower.split(/[^\p{L}\p{N}]+/u)) if (t.length > 1) out.add(t);
    const at = lower.indexOf('@');
    if (at > 0) out.add(lower.slice(at + 1)); // Domain
  }
  return [...out];
}

export function parseQuery(input: string): ParsedQuery {
  const filters: string[] = [];
  const text: string[] = [];
  // Tokens: key:"wert mit leerzeichen" | key:wert | "phrase" | wort
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/gu;
  for (const m of input.matchAll(re)) {
    const key = (m[1] ?? m[3])?.toLowerCase();
    const value = (m[2] ?? m[4] ?? '').trim();
    if (!key) {
      if (m[5] !== undefined) text.push(`"${m[5]}"`);
      else if (m[6]) text.push(m[6]);
      continue;
    }
    const v = value.toLowerCase();
    switch (key) {
      case 'from':
      case 'von':
        if (v) filters.push(`fromTerms = ${q(v)}`);
        break;
      case 'to':
      case 'an':
      case 'cc':
        if (v) filters.push(`toTerms = ${q(v)}`);
        break;
      case 'subject':
      case 'betreff':
        if (value) text.push(value.includes(' ') ? `"${value}"` : value);
        break;
      case 'has':
      case 'hat':
        if (/^(attachment|attachments|anhang|anhänge|anhaenge)$/.test(v)) filters.push('hasAttachments = true');
        break;
      case 'is':
      case 'ist':
        if (/^(unread|ungelesen|neu)$/.test(v)) filters.push('seen = false');
        else if (/^(read|gelesen)$/.test(v)) filters.push('seen = true');
        else if (/^(flagged|starred|markiert|wichtig)$/.test(v)) filters.push('flagged = true');
        break;
      case 'in':
      case 'ordner': {
        const role = ROLE_ALIASES[v];
        if (role) filters.push(`folderRole = ${q(role)}`);
        else if (v) filters.push(`folderKey = ${q(v)}`);
        break;
      }
      case 'after':
      case 'nach':
      case 'seit': {
        const d = parseDate(value);
        if (d !== null) filters.push(`date >= ${d}`);
        break;
      }
      case 'before':
      case 'vor':
      case 'bis': {
        const d = parseDate(value);
        if (d !== null) filters.push(`date < ${d + (/^\d{4}$/.test(value) ? 0 : 86400)}`);
        break;
      }
      default:
        // Unbekannter Befehl (z. B. Uhrzeit "10:30") → als Text behandeln
        text.push(m[0]);
    }
  }
  return { text: text.join(' ').trim(), filters };
}

/** Entfernt Suchbefehle – für Anbieter ohne Index (Live-Suche) */
export function plainText(input: string): string {
  const p = parseQuery(input);
  return p.text.replace(/"/g, '').trim();
}
