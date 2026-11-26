/**
 * Hilfsfunktionen für das IMAP-Modul: Ordnerrollen, Body-Struktur, Vorschautext,
 * Header-Manipulation und ein kleiner LRU-Cache.
 */
import type { MessageStructureObject } from 'imapflow';
import type { EmailAddress, FolderRole, SmimeKind } from '@kuvert/shared';
import { headerLines, smimeFromContentType, splitHeaderBody } from '../../core/mime.js';

/* ───────────────────────────── Ordnerrollen ───────────────────────────── */

const SPECIAL_USE: Record<string, FolderRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};

const NAME_HINTS: [RegExp, FolderRole][] = [
  [/^(sent|sent items|sent mail|sent messages|gesendet|gesendete (objekte|elemente|nachrichten)|envoy[ée]s)$/i, 'sent'],
  [/^(drafts?|entw[üu]rfe|brouillons)$/i, 'drafts'],
  [/^(trash|deleted|deleted items|deleted messages|papierkorb|gel[öo]schte (objekte|elemente)|bin|corbeille)$/i, 'trash'],
  [/^(junk|junk e-?mail|spam|bulk mail|unerw[üu]nscht)$/i, 'junk'],
  [/^(archives?|archiv)$/i, 'archive'],
];

export function detectRole(path: string, name: string, specialUse?: string): FolderRole {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  if (specialUse) {
    const r = SPECIAL_USE[specialUse.toLowerCase()];
    if (r) return r;
  }
  for (const [re, role] of NAME_HINTS) if (re.test(name.trim())) return role;
  return 'other';
}

const ROLE_ORDER: Record<FolderRole, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5, outbox: 6, other: 10 };
export function roleOrder(role: FolderRole): number {
  return ROLE_ORDER[role] ?? 10;
}

/* ───────────────────────────── Adressen ───────────────────────────── */

export function toAddress(a?: { name?: string; address?: string }): EmailAddress | undefined {
  if (!a?.address) return undefined;
  return { name: a.name || undefined, address: a.address };
}

export function toAddressList(list?: { name?: string; address?: string }[]): EmailAddress[] {
  return (list ?? []).map(toAddress).filter((a): a is EmailAddress => !!a);
}

/** Parst "Name <a@b>, c@d" (auch zeilenweise) */
export function parseAliasList(input: unknown): EmailAddress[] {
  if (typeof input !== 'string') return [];
  const out: EmailAddress[] = [];
  for (const part of input.split(/[,;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*)<([^>]+)>$/);
    if (m) out.push({ name: m[1]!.trim().replace(/^"|"$/g, '') || undefined, address: m[2]!.trim() });
    else if (s.includes('@')) out.push({ address: s });
  }
  return out;
}

/* ───────────────────────────── Body-Struktur ───────────────────────────── */

/** S/MIME-Art anhand der obersten MIME-Ebene (Typ + Parameter wie smime-type/protocol) */
export function smimeOf(node?: MessageStructureObject): SmimeKind | undefined {
  if (!node?.type) return undefined;
  const params = Object.entries(node.parameters ?? {}).map(([k, v]) => `; ${k}=${v}`);
  const top = smimeFromContentType(node.type + params.join(''));
  if (top) return top;
  // Verteiler/Relays („X via Y“) packen verschlüsselte Mails teils in multipart/mixed
  // (z. B. mit Fußzeile) – der Container smime.p7m liegt dann eine Ebene tiefer
  return node.childNodes?.some(wrapsEncrypted) ? 'encrypted' : undefined;
}

function wrapsEncrypted(node: MessageStructureObject): boolean {
  const type = (node.type ?? '').toLowerCase();
  if (type === 'message/rfc822') return false; // weitergeleitete Mail ist nicht diese Mail
  if (node.childNodes?.length) return node.childNodes.some(wrapsEncrypted);
  const name = (node.dispositionParameters?.filename || node.parameters?.name || '').toLowerCase();
  if (type.includes('pkcs7-mime')) return !(node.parameters?.['smime-type'] ?? '').toLowerCase().includes('signed');
  return name === 'smime.p7m';
}

export function hasAttachments(node?: MessageStructureObject): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments);
  const type = (node.type ?? '').toLowerCase();
  // Signatur einer signierten Mail (smime.p7s) ist kein Anhang im Sinne des Benutzers
  if (type.includes('pkcs7-signature')) return false;
  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment') return true;
  if (type.includes('pkcs7-mime') || type === 'message/rfc822') return true;
  const named = !!(node.dispositionParameters?.filename || node.parameters?.name);
  if (named && disposition !== 'inline' && !type.startsWith('text/')) return true;
  return false;
}

/** Dateinamen aller echten Anhänge aus der MIME-Struktur */
export function attachmentNames(node?: MessageStructureObject, out: string[] = []): string[] {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const c of node.childNodes) attachmentNames(c, out);
    return out;
  }
  const disposition = (node.disposition ?? '').toLowerCase();
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (name && disposition !== 'inline' && !/smime\.p7[ms]$/i.test(name)) out.push(name);
  return out;
}

export interface TextPart {
  key: string;
  type: string;
  encoding: string;
  charset: string;
}

/** Erster sinnvoller Textteil (text/plain bevorzugt) für die Vorschau. */
export function findTextPart(root?: MessageStructureObject): TextPart | undefined {
  if (!root) return undefined;
  const candidates: TextPart[] = [];
  const walk = (node: MessageStructureObject) => {
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk);
      return;
    }
    const type = (node.type ?? '').toLowerCase();
    if ((type === 'text/plain' || type === 'text/html') && (node.disposition ?? '').toLowerCase() !== 'attachment') {
      candidates.push({
        key: node.part ?? '1',
        type,
        encoding: (node.encoding ?? '7bit').toLowerCase(),
        charset: (node.parameters?.charset ?? 'utf-8').toLowerCase(),
      });
    }
  };
  walk(root);
  return candidates.find((c) => c.type === 'text/plain') ?? candidates[0];
}

function decodeQuotedPrintable(s: string): Buffer {
  const cleaned = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Dekodiert einen (ggf. abgeschnittenen) Teil zu einem kurzen Vorschautext. */
export function previewFromPart(data: Buffer, part: TextPart): string {
  let bytes: Buffer;
  if (part.encoding === 'base64') {
    const b64 = data.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    bytes = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
  } else if (part.encoding === 'quoted-printable') {
    bytes = decodeQuotedPrintable(data.toString('latin1'));
  } else {
    bytes = data;
  }
  let text: string;
  try {
    text = new TextDecoder(part.charset, { fatal: false }).decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  if (part.type === 'text/html') {
    text = text
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  // Zitate und Signaturtrenner überspringen, Leerraum verdichten
  return text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('>'))
    .join(' ')
    .replace(/�/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/* ───────────────────────────── Header ───────────────────────────── */

/** Entfernt Header (z. B. Bcc) aus einer RFC822-Nachricht. */
export function stripHeaders(raw: Buffer, names: string[]): Buffer {
  const lower = names.map((n) => n.toLowerCase() + ':');
  const { headers, body } = splitHeaderBody(raw);
  const kept = headerLines(headers).filter((line) => !lower.some((n) => line.toLowerCase().startsWith(n)));
  return Buffer.concat([Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'utf8'), body]);
}

/* ───────────────────────────── LRU-Cache ───────────────────────────── */

export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  deleteWhere(pred: (key: string) => boolean) {
    for (const k of [...this.map.keys()]) if (pred(k)) this.map.delete(k);
  }

  clear() {
    this.map.clear();
  }
}
