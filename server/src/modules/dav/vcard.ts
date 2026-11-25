/**
 * Kleiner, robuster vCard-Parser/-Generator (vCard 2.1/3.0/4.0 lesen, 3.0 schreiben).
 * Unbekannte Eigenschaften bleiben beim Aktualisieren erhalten.
 */
import crypto from 'node:crypto';
import type { Contact, ContactInput } from '@kuvert/shared';

export interface VProp {
  group?: string;
  name: string;
  params: Record<string, string[]>;
  /** Rohwert (noch escaped) */
  raw: string;
}

/* ───────────────────────────── Parsen ───────────────────────────── */

function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim().length);
}

/** Zerlegt eine Zeile in Name, Parameter und Wert (beachtet Anführungszeichen). */
function parseLine(line: string): VProp | undefined {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined;
  const head = line.slice(0, colon);
  const raw = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = '';
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const nameFull = parts.shift() ?? '';
  const dot = nameFull.indexOf('.');
  const group = dot > 0 ? nameFull.slice(0, dot) : undefined;
  const name = (dot > 0 ? nameFull.slice(dot + 1) : nameFull).toUpperCase();
  const params: Record<string, string[]> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    // vCard 2.1: nackte Parameter ("TEL;WORK;VOICE:") gelten als TYPE
    const key = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const val = eq < 0 ? p : p.slice(eq + 1);
    const values = val
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((v) => v.replace(/^"|"$/g, ''))
      .filter(Boolean);
    (params[key] ??= []).push(...values);
  }
  return { group, name, params, raw };
}

export function unescapeValue(v: string): string {
  return v.replace(/\\([\\,;nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Strukturierten Wert (N, ADR, ORG) an unescapten Semikolons trennen */
function splitStructured(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) {
      cur += c + raw[i + 1];
      i++;
    } else if (c === ';') {
      out.push(unescapeValue(cur));
      cur = '';
    } else cur += c;
  }
  out.push(unescapeValue(cur));
  return out;
}

/** Zerlegt Text mit einer oder mehreren vCards in Eigenschaftslisten. */
export function parseVCards(text: string): VProp[][] {
  const cards: VProp[][] = [];
  let current: VProp[] | null = null;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.raw.toUpperCase() === 'VCARD') {
      current = [];
      continue;
    }
    if (p.name === 'END' && p.raw.toUpperCase() === 'VCARD') {
      if (current) cards.push(current);
      current = null;
      continue;
    }
    current?.push(p);
  }
  return cards;
}

const IGNORED_TYPES = new Set(['pref', 'internet', 'voice', 'x400', 'msg']);

function friendlyType(params: Record<string, string[]>): string | undefined {
  const types = (params.TYPE ?? []).map((t) => t.toLowerCase()).filter((t) => !IGNORED_TYPES.has(t) && !/^pref/.test(t));
  const t = types[0];
  if (!t) return undefined;
  if (t === 'cell') return 'mobile';
  return t;
}

function decodeValue(p: VProp): string {
  const enc = (p.params.ENCODING?.[0] ?? '').toUpperCase();
  if (enc === 'QUOTED-PRINTABLE') {
    const bytes: number[] = [];
    const s = p.raw.replace(/=\r?\n/g, '');
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return unescapeValue(p.raw);
}

function photoUrl(p: VProp): string | undefined {
  const raw = p.raw.trim();
  if (/^(https?:|data:)/i.test(raw)) return raw.length < 300_000 ? raw : undefined;
  const enc = (p.params.ENCODING?.[0] ?? '').toLowerCase();
  if ((enc === 'b' || enc === 'base64') && raw.length < 300_000) {
    const type = (p.params.TYPE?.[0] ?? 'jpeg').toLowerCase().replace(/^image\//, '');
    return `data:image/${type};base64,${raw.replace(/\s+/g, '')}`;
  }
  return undefined;
}

function normalizeDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^--(\d{2})-?(\d{2})/);
  if (m) return `1604-${m[1]}-${m[2]}`; // Jahr unbekannt (vCard 4 / Apple-Konvention)
  return null;
}

export function vcardToContact(props: VProp[], ctx: { id: string; accountId: string; addressBookId: string; etag?: string }): Contact {
  const get = (name: string) => props.find((p) => p.name === name);
  const all = (name: string) => props.filter((p) => p.name === name);
  const n = get('N') ? splitStructured(get('N')!.raw) : [];
  const org = get('ORG') ? splitStructured(get('ORG')!.raw) : [];
  const lastName = n[0] || undefined;
  const firstName = n[1] || undefined;
  const fn = get('FN') ? decodeValue(get('FN')!) : '';
  const emails = all('EMAIL').map((p) => ({ type: friendlyType(p.params), address: decodeValue(p).replace(/^mailto:/i, '').trim() }));
  const displayName =
    fn.trim() || [firstName, lastName].filter(Boolean).join(' ') || org[0] || emails[0]?.address || '(Ohne Namen)';
  return {
    id: ctx.id,
    accountId: ctx.accountId,
    addressBookId: ctx.addressBookId,
    displayName,
    firstName,
    lastName,
    company: org[0] || undefined,
    department: org[1] || undefined,
    jobTitle: get('TITLE') ? decodeValue(get('TITLE')!) : undefined,
    emails: emails.filter((e) => e.address),
    phones: all('TEL')
      .map((p) => ({ type: friendlyType(p.params), number: decodeValue(p).replace(/^tel:/i, '').trim() }))
      .filter((t) => t.number),
    addresses: all('ADR').map((p) => {
      const a = splitStructured(p.raw);
      return {
        type: friendlyType(p.params),
        street: [a[1], a[2]].filter(Boolean).join('\n') || undefined,
        city: a[3] || undefined,
        region: a[4] || undefined,
        postalCode: a[5] || undefined,
        country: a[6] || undefined,
      };
    }),
    birthday: get('BDAY') ? normalizeDate(decodeValue(get('BDAY')!)) : null,
    notes: get('NOTE') ? decodeValue(get('NOTE')!) : undefined,
    website: get('URL') ? decodeValue(get('URL')!) : undefined,
    photoUrl: get('PHOTO') ? photoUrl(get('PHOTO')!) : undefined,
    etag: ctx.etag,
  };
}

export function vcardUid(props: VProp[]): string | undefined {
  const p = props.find((x) => x.name === 'UID');
  return p ? unescapeValue(p.raw) : undefined;
}

/* ───────────────────────────── Erzeugen ───────────────────────────── */

export function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

const structured = (parts: (string | undefined)[]) => parts.map((p) => escapeValue(p ?? '')).join(';');

/** Faltet Zeilen auf max. 75 Oktette (UTF-8-sicher). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (curLen + len > limit) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const TYPE_OUT: Record<string, string> = { mobile: 'CELL', work: 'WORK', home: 'HOME', fax: 'FAX', other: 'OTHER', main: 'MAIN', pager: 'PAGER' };
function typeParam(type: string | undefined, extra?: string): string {
  const t = type ? TYPE_OUT[type.toLowerCase()] ?? type.toUpperCase().replace(/[^A-Z0-9-]/g, '') : undefined;
  const list = [extra, t].filter(Boolean);
  return list.length ? `;TYPE=${list.join(',')}` : '';
}

/** Eigenschaften, die aus ContactInput erzeugt werden (werden beim Update ersetzt) */
const MANAGED = new Set(['VERSION', 'PRODID', 'REV', 'FN', 'N', 'ORG', 'TITLE', 'EMAIL', 'TEL', 'ADR', 'BDAY', 'NOTE', 'URL', 'UID']);

function managedLines(input: ContactInput, uid: string): string[] {
  const lines: string[] = [];
  const displayName =
    input.displayName?.trim() ||
    [input.firstName, input.lastName].filter(Boolean).join(' ') ||
    input.company ||
    input.emails?.[0]?.address ||
    'Kontakt';
  lines.push(`UID:${escapeValue(uid)}`);
  lines.push(`FN:${escapeValue(displayName)}`);
  lines.push(`N:${structured([input.lastName, input.firstName, '', '', ''])}`);
  if (input.company || input.department) lines.push(`ORG:${structured([input.company, input.department].filter((x, i) => i === 0 || x))}`);
  if (input.jobTitle) lines.push(`TITLE:${escapeValue(input.jobTitle)}`);
  for (const e of input.emails ?? []) if (e.address?.trim()) lines.push(`EMAIL${typeParam(e.type, 'INTERNET')}:${escapeValue(e.address.trim())}`);
  for (const t of input.phones ?? []) if (t.number?.trim()) lines.push(`TEL${typeParam(t.type)}:${escapeValue(t.number.trim())}`);
  for (const a of input.addresses ?? []) {
    if (![a.street, a.city, a.postalCode, a.region, a.country].some(Boolean)) continue;
    lines.push(`ADR${typeParam(a.type)}:${structured(['', '', a.street, a.city, a.region, a.postalCode, a.country])}`);
  }
  if (input.birthday) {
    const d = normalizeDate(input.birthday);
    if (d) lines.push(d.startsWith('1604-') ? `BDAY;X-APPLE-OMIT-YEAR=1604:${d}` : `BDAY;VALUE=date:${d}`);
  }
  if (input.notes) lines.push(`NOTE:${escapeValue(input.notes)}`);
  if (input.website) lines.push(`URL:${escapeValue(input.website)}`);
  if (input.photoUrl && /^https?:/i.test(input.photoUrl)) lines.push(`PHOTO;VALUE=uri:${input.photoUrl}`);
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  return lines;
}

function serializeProp(p: VProp): string {
  const params = Object.entries(p.params)
    .map(([k, vals]) => `;${k}=${vals.map((v) => (/[;:,]/.test(v) ? `"${v}"` : v)).join(',')}`)
    .join('');
  return `${p.group ? `${p.group}.` : ''}${p.name}${params}:${p.raw}`;
}

export function newContactUid(): string {
  return crypto.randomUUID();
}

/** Erzeugt eine vCard 3.0. Mit `existing` bleiben unbekannte Eigenschaften (X-…, PHOTO …) erhalten. */
export function buildVCard(input: ContactInput, opts: { uid: string; existing?: VProp[] }): string {
  const kept = (opts.existing ?? []).filter((p) => !MANAGED.has(p.name) && !(p.name === 'PHOTO' && input.photoUrl && /^https?:/i.test(input.photoUrl)));
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Kuvert//Kuvert Webmail//DE', ...managedLines(input, opts.uid), ...kept.map(serializeProp), 'END:VCARD'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
