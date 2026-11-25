/**
 * MIME-Hilfsfunktionen: Nachrichten bauen (nodemailer) und parsen (mailparser).
 * Wird von IMAP, S/MIME, Gmail-Raw usw. gemeinsam genutzt.
 */
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser, type AddressObject } from 'mailparser';
import { convert } from 'html-to-text';
import ICAL from 'ical.js';
import type { AttachmentInfo, EmailAddress, InviteInfo, MessageDetail, SmimeKind } from '@kuvert/shared';
import type { ResolvedOutgoingMessage } from './providers.js';

export function formatAddress(a: EmailAddress): string {
  if (!a.name) return a.address;
  return `"${a.name.replace(/["\\]/g, '')}" <${a.address}>`;
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  });
}

/**
 * Vollständiger Klartext aus HTML für Beschreibungsfelder (z. B. Termine):
 * ohne harte Zeilenumbrüche, Outlook-Abstände (&nbsp;-Absätze) bereinigt.
 */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      // Outlook setzt Absätze ohne Abstand und fügt Leerzeilen als eigene &nbsp;-Absätze ein
      { selector: 'p', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    ],
  })
    .replace(/^[ \t\u00a0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Baut eine vollständige RFC822-Nachricht (CRLF) aus einer aufbereiteten Nachricht. */
export async function buildMime(msg: ResolvedOutgoingMessage, opts: { messageId?: string; date?: Date } = {}): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (msg.importance === 'high') {
    headers['X-Priority'] = '1 (Highest)';
    headers['Importance'] = 'High';
  } else if (msg.importance === 'low') {
    headers['X-Priority'] = '5 (Lowest)';
    headers['Importance'] = 'Low';
  }
  if (msg.requestReadReceipt) headers['Disposition-Notification-To'] = formatAddress(msg.from);
  headers['X-Mailer'] = 'Kuvert';

  const composer = new MailComposer({
    from: formatAddress(msg.from),
    to: msg.to.map(formatAddress),
    cc: msg.cc.map(formatAddress),
    bcc: msg.bcc.map(formatAddress),
    replyTo: msg.replyTo.length ? msg.replyTo.map(formatAddress) : undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text ?? (msg.html ? htmlToText(msg.html) : ''),
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    messageId: opts.messageId,
    date: opts.date ?? new Date(),
    headers,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.data,
      contentType: a.contentType,
      cid: a.inline ? a.contentId : undefined,
      contentDisposition: a.inline ? ('inline' as const) : ('attachment' as const),
    })),
  });
  // keepBcc: Bcc-Header wird für Entwürfe/Gesendet-Ablage benötigt; SMTP-Transport entfernt ihn selbst
  const node = composer.compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  return new Promise<Buffer>((resolve, reject) => node.build((err, buf) => (err ? reject(err) : resolve(buf))));
}

/** Trennt Header-Block und Body einer MIME-Entität. */
export function splitHeaderBody(raw: Buffer): { headers: string; body: Buffer } {
  let idx = raw.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx < 0) {
    idx = raw.indexOf('\n\n');
    sepLen = 2;
  }
  if (idx < 0) return { headers: raw.toString('utf8'), body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, idx).toString('utf8'), body: raw.subarray(idx + sepLen) };
}

/** Zerlegt einen Header-Block in einzelne (ggf. gefaltete) Header-Zeilen. */
export function headerLines(headers: string): string[] {
  const lines: string[] = [];
  for (const line of headers.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += '\r\n' + line;
    else if (line) lines.push(line);
  }
  return lines;
}

function addressList(obj: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!obj) return [];
  const arr = Array.isArray(obj) ? obj : [obj];
  const out: EmailAddress[] = [];
  for (const o of arr) {
    for (const v of o.value) {
      if (v.address) out.push({ name: v.name || undefined, address: v.address });
      for (const g of v.group ?? []) if (g.address) out.push({ name: g.name || undefined, address: g.address });
    }
  }
  return out;
}

export interface ParsedAttachment {
  info: AttachmentInfo;
  content: Buffer;
}

export interface ParsedRaw {
  detail: Omit<MessageDetail, 'id' | 'accountId' | 'folderId' | 'seen' | 'flagged'>;
  attachments: ParsedAttachment[];
}

/** Teil eines Dateinamens: verbotene Zeichen raus, Leerraum zusammenfassen, kürzen. */
function filenamePart(s: string, max: number): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.length > max ? `${cleaned.slice(0, max).trimEnd()}…` : cleaned).replace(/[. ]+$/, '');
}

/**
 * Dateiname für eine .eml-Datei aus Betreff und Absender, z. B.
 * „Angebot März - Max Mustermann.eml“. Liest nur den Header-Block.
 */
export async function emlFilename(raw: Buffer, fallback = 'nachricht'): Promise<string> {
  try {
    const p = await simpleParser(`${splitHeaderBody(raw).headers}\r\n\r\n`);
    const sender = addressList(p.from)[0];
    const subject = filenamePart(p.subject ?? '', 100);
    const from = filenamePart(sender?.name || sender?.address || '', 50);
    const name = subject && from ? `${subject} - ${from}` : subject || (from ? `Nachricht von ${from}` : '');
    return `${name || fallback}.eml`;
  } catch {
    return `${fallback}.eml`;
  }
}

/** Alle im HTML per cid: referenzierten Content-IDs (kleingeschrieben, ohne spitze Klammern). */
export function referencedCids(html: string): Set<string> {
  const set = new Set<string>();
  for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) {
    let v = m[1]!;
    try {
      v = decodeURIComponent(v);
    } catch {
      /* kein gültiges Percent-Encoding */
    }
    set.add(v.replace(/^<|>$/g, '').toLowerCase());
  }
  return set;
}

/** Parst eine RFC822-Nachricht. Anhänge erhalten IDs "att-<index>". */
export async function parseRawMessage(raw: Buffer): Promise<ParsedRaw> {
  const p = await simpleParser(raw, { skipImageLinks: true });
  // Eingebettete Nachrichten ohne Dateinamen nach Betreff/Absender benennen
  const embeddedNames = await Promise.all(
    p.attachments.map((a) => (!a.filename && a.contentType === 'message/rfc822' ? emlFilename(a.content) : undefined)),
  );
  const html = typeof p.html === 'string' ? p.html : undefined;
  const referenced = html ? referencedCids(html) : new Set<string>();
  const attachments: ParsedAttachment[] = p.attachments.map((a, i) => {
    const contentId = a.contentId ? a.contentId.replace(/^<|>$/g, '') : undefined;
    return {
      info: {
        id: `att-${i}`,
        filename: a.filename ?? embeddedNames[i] ?? `anhang-${i + 1}`,
        contentType: a.contentType,
        size: a.size,
        // Auch als „attachment“ deklarierte, aber im HTML eingebettete Bilder gelten als inline
        inline: a.contentDisposition === 'inline' || a.related === true || (!!contentId && referenced.has(contentId.toLowerCase())),
        contentId,
      },
      content: a.content,
    };
  });

  const headers: Record<string, string> = {};
  for (const [k, v] of p.headers) {
    if (typeof v === 'string') headers[k] = v;
    else if (v && typeof v === 'object' && 'text' in (v as object)) headers[k] = String((v as { text: string }).text);
    else if (v && typeof v === 'object' && 'value' in (v as object)) headers[k] = String((v as { value: unknown }).value);
  }

  const ics = findIcs(attachments);
  const text = p.text ?? (html ? htmlToText(html) : undefined);
  const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : undefined;

  return {
    detail: {
      subject: p.subject ?? '',
      from: addressList(p.from)[0],
      to: addressList(p.to),
      cc: addressList(p.cc),
      bcc: addressList(p.bcc),
      replyTo: addressList(p.replyTo),
      date: (p.date ?? new Date()).toISOString(),
      preview: (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      html,
      text,
      hasAttachments: attachments.some((a) => !a.info.inline),
      attachments: attachments.map((a) => a.info),
      messageIdHeader: p.messageId,
      inReplyTo: p.inReplyTo,
      references: refs,
      headers,
      importance: detectImportance(headers),
      listUnsubscribe: headers['list-unsubscribe'],
      invite: ics ? parseInvite(ics.content.toString('utf8')) : undefined,
    },
    attachments,
  };
}

function detectImportance(h: Record<string, string>): 'low' | 'normal' | 'high' {
  const imp = (h['importance'] ?? h['priority'] ?? '').toLowerCase();
  const xp = (h['x-priority'] ?? '').trim();
  if (imp === 'high' || imp === 'urgent' || xp.startsWith('1') || xp.startsWith('2')) return 'high';
  if (imp === 'low' || imp === 'non-urgent' || xp.startsWith('4') || xp.startsWith('5')) return 'low';
  return 'normal';
}

/** Liest die wichtigsten Daten einer iCalendar-Einladung (METHOD:REQUEST …). */
export function parseInvite(icsText: string): InviteInfo | undefined {
  try {
    const comp = new ICAL.Component(ICAL.parse(icsText));
    const vevent = comp.getFirstSubcomponent('vevent');
    if (!vevent) return undefined;
    const ev = new ICAL.Event(vevent);
    const organizer = vevent.getFirstPropertyValue('organizer');
    const orgAddr = typeof organizer === 'string' ? organizer.replace(/^mailto:/i, '') : undefined;
    const orgName = vevent.getFirstProperty('organizer')?.getParameter('cn');
    return {
      method: String(comp.getFirstPropertyValue('method') ?? '') || undefined,
      uid: ev.uid,
      summary: ev.summary,
      location: ev.location || undefined,
      start: ev.startDate?.toJSDate().toISOString(),
      end: ev.endDate?.toJSDate().toISOString(),
      organizer: orgAddr ? { address: orgAddr, name: typeof orgName === 'string' ? orgName : undefined } : undefined,
      canRespond: String(comp.getFirstPropertyValue('method') ?? '').toUpperCase() === 'REQUEST' && !!orgAddr,
    };
  } catch {
    return undefined;
  }
}

/** iCalendar-Teil einer Nachricht (text/calendar, application/ics oder *.ics) */
export function findIcs(attachments: ParsedAttachment[]): ParsedAttachment | undefined {
  const isIcs = (a: ParsedAttachment) => {
    const ct = a.info.contentType.toLowerCase();
    return ct === 'text/calendar' || ct === 'application/ics' || (ct === 'application/octet-stream' && /\.ics$/i.test(a.info.filename));
  };
  // text/calendar (iMIP, meist Teil von multipart/alternative) vor angehängten .ics-Dateien
  return attachments.find((a) => a.info.contentType.toLowerCase() === 'text/calendar') ?? attachments.find(isIcs);
}

export type InviteReplyResponse = 'accept' | 'tentative' | 'decline';

/**
 * Baut eine iTIP-Antwort (METHOD:REPLY, RFC 5546) auf eine Einladung.
 * ownAddresses: Adressen des Kontos; die passende Teilnehmerzeile wird beantwortet.
 * Steht keine davon in der Einladung (z. B. Verteilerliste), wird fallbackAddress verwendet.
 */
export function buildInviteReply(
  icsText: string,
  ownAddresses: string[],
  fallbackAddress: string,
  response: InviteReplyResponse,
  comment?: string,
): { ics: string; organizer: EmailAddress; attendee: string; summary: string } {
  const src = new ICAL.Component(ICAL.parse(icsText));
  const events = src.getAllSubcomponents('vevent');
  // Bei Serien mit Ausnahmen: Hauptereignis (ohne RECURRENCE-ID) beantworten
  const vevent = events.find((e) => !e.getFirstProperty('recurrence-id')) ?? events[0];
  if (!vevent) throw new Error('Einladung enthält keinen Termin');
  const orgProp = vevent.getFirstProperty('organizer');
  const orgValue = orgProp?.getFirstValue();
  const orgAddr = typeof orgValue === 'string' ? orgValue.replace(/^mailto:/i, '') : '';
  if (!orgAddr) throw new Error('Einladung enthält keinen Organisator');
  const orgName = orgProp?.getParameter('cn');

  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const mailtoOf = (p: InstanceType<typeof ICAL.Property>) => {
    const v = p.getFirstValue();
    return typeof v === 'string' ? v.replace(/^mailto:/i, '').toLowerCase() : '';
  };
  const match = vevent.getAllProperties('attendee').find((p) => own.has(mailtoOf(p)));
  const attendeeAddr = match ? mailtoOf(match) : fallbackAddress;
  const partstat = { accept: 'ACCEPTED', tentative: 'TENTATIVE', decline: 'DECLINED' }[response];

  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.addPropertyWithValue('prodid', '-//Kuvert//DE');
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('method', 'REPLY');
  const clone = <T extends { toJSON(): unknown }>(x: T) => JSON.parse(JSON.stringify(x.toJSON()));
  for (const tz of src.getAllSubcomponents('vtimezone')) cal.addSubcomponent(new ICAL.Component(clone(tz)));

  const out = new ICAL.Component('vevent');
  for (const name of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'summary']) {
    const p = vevent.getFirstProperty(name);
    if (p) out.addProperty(new ICAL.Property(clone(p)));
  }
  out.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  out.addProperty(new ICAL.Property(clone(orgProp!)));
  const att = new ICAL.Property('attendee');
  att.setValue(`mailto:${attendeeAddr}`);
  const cn = match?.getParameter('cn');
  if (typeof cn === 'string' && cn) att.setParameter('cn', cn);
  att.setParameter('partstat', partstat);
  out.addProperty(att);
  if (comment?.trim()) out.addPropertyWithValue('comment', comment.trim());
  cal.addSubcomponent(out);

  const summary = String(vevent.getFirstPropertyValue('summary') ?? '');
  return {
    ics: cal.toString(),
    organizer: { address: orgAddr, name: typeof orgName === 'string' ? orgName : undefined },
    attendee: attendeeAddr,
    summary,
  };
}

/** MIME-Nachricht mit iTIP-Antwort (Text + text/calendar; method=REPLY) */
export async function buildInviteReplyMime(opts: {
  from: EmailAddress;
  to: EmailAddress;
  subject: string;
  text: string;
  ics: string;
  inReplyTo?: string;
  references?: string[];
}): Promise<Buffer> {
  const composer = new MailComposer({
    from: formatAddress(opts.from),
    to: formatAddress(opts.to),
    subject: opts.subject,
    text: opts.text,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    date: new Date(),
    headers: { 'X-Mailer': 'Kuvert' },
    icalEvent: { method: 'REPLY', content: opts.ics },
  });
  return new Promise<Buffer>((resolve, reject) => composer.compile().build((err, buf) => (err ? reject(err) : resolve(buf))));
}

/** Erkennt S/MIME-Nachrichten anhand der Anhänge/Content-Types. */
/**
 * S/MIME-Art anhand des äußeren Content-Type (inkl. Parameter wie smime-type/protocol).
 * Bei multipart/signed ohne protocol-Parameter (z. B. Gmail-Metadaten) gilt die Mail als signiert,
 * PGP/MIME (application/pgp-signature) dagegen nicht.
 */
export function smimeFromContentType(contentType: string | undefined): SmimeKind | undefined {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/pkcs7-mime') || ct.includes('application/x-pkcs7-mime')) {
    return ct.includes('signed-data') ? 'signed' : 'encrypted';
  }
  if (ct.includes('multipart/signed') && !ct.includes('pgp-signature')) return 'signed';
  return undefined;
}

export function looksLikeSmime(msg: Pick<MessageDetail, 'attachments' | 'headers'>): SmimeKind | undefined {
  const ct = (msg.headers?.['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/pkcs7-mime') || ct.includes('application/x-pkcs7-mime')) {
    return ct.includes('signed-data') ? 'signed' : 'encrypted';
  }
  if (ct.includes('multipart/signed') && ct.includes('pkcs7-signature')) return 'signed';
  for (const a of msg.attachments) {
    const t = a.contentType.toLowerCase();
    const n = a.filename.toLowerCase();
    if (t.includes('pkcs7-mime') || n === 'smime.p7m') return 'encrypted';
    if (t.includes('pkcs7-signature') || n === 'smime.p7s') return 'signed';
  }
  return undefined;
}
