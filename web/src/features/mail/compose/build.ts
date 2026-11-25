/**
 * Hilfsfunktionen für Antworten, Weiterleitungen, Signaturen und die
 * Aufbereitung des HTML vor dem Senden.
 */
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import type { EmailAddress, MessageDetail, OutgoingAttachment, Signature } from '@kuvert/shared';
import { escapeHtml, formatAddress, textToHtml } from '@/lib/utils';
import type { MessageRef } from '../api';
import { sanitizeFragment } from '../sanitize';
import type { ComposeMode, ComposerInit } from './store';

/* ───────────────────────────── Betreff ───────────────────────────── */

const PREFIX_RE = /^\s*((re|aw|antw|fw|fwd|wg|tr|wtrlt)\s*(\[\d+\])?\s*:\s*)+/i;

export function prefixSubject(subject: string, kind: 'reply' | 'forward'): string {
  const base = (subject ?? '').replace(PREFIX_RE, '').trim();
  return `${kind === 'reply' ? 'AW' : 'WG'}: ${base}`;
}

/* ───────────────────────────── Zitate ───────────────────────────── */

function addrHtml(a?: EmailAddress) {
  if (!a) return '';
  return escapeHtml(a.name ? `${a.name} <${a.address}>` : a.address);
}

function originalBodyHtml(m: MessageDetail): string {
  if (m.html) {
    const doc = new DOMParser().parseFromString(sanitizeFragment(m.html), 'text/html');
    return doc.body.innerHTML;
  }
  return textToHtml(m.text ?? '');
}

export function buildQuote(m: MessageDetail, kind: 'reply' | 'forward'): string {
  const date = format(new Date(m.date), "EEEE, d. MMMM yyyy 'um' HH:mm", { locale: de });
  const body = originalBodyHtml(m);
  if (kind === 'reply') {
    return (
      `<div class="kuvert-quote"><p style="margin:16px 0 8px 0">Am ${escapeHtml(date)} schrieb ${addrHtml(m.from)}:</p>` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body}</blockquote></div>`
    );
  }
  const rows = [
    ['Von', addrHtml(m.from)],
    ['Datum', escapeHtml(date)],
    ['Betreff', escapeHtml(m.subject ?? '')],
    ['An', m.to.map(addrHtml).join(', ')],
    ...(m.cc?.length ? [['Cc', m.cc.map(addrHtml).join(', ')]] : []),
  ];
  return (
    `<div class="kuvert-quote"><p style="margin:16px 0 8px 0">---------- Weitergeleitete Nachricht ----------<br>` +
    rows.map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br>') +
    `</p>${body}</div>`
  );
}

/** Alle Absender-/Empfängeradressen, die "mir" gehören */
export function isOwn(addr: string, own: Set<string>) {
  return own.has(addr.trim().toLowerCase());
}

function dedupe(list: EmailAddress[], exclude: Set<string>): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    const k = a.address.trim().toLowerCase();
    if (!k || seen.has(k) || exclude.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** cid-Referenzen im HTML */
function referencedCids(html: string): Set<string> {
  const set = new Set<string>();
  for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) set.add(m[1]!.toLowerCase());
  return set;
}

export function buildReplyInit(
  original: MessageDetail,
  ref: MessageRef,
  mode: Exclude<ComposeMode, 'new' | 'edit'>,
  ownAddresses: Set<string>,
  bodyHtml?: string,
): ComposerInit {
  const kind = mode === 'forward' ? 'forward' : 'reply';
  const quoteHtml = buildQuote(original, kind);
  let to: EmailAddress[] = [];
  let cc: EmailAddress[] = [];
  if (mode !== 'forward') {
    const replyTargets = original.replyTo?.length ? original.replyTo : original.from ? [original.from] : [];
    const fromIsOwn = original.from && isOwn(original.from.address, ownAddresses);
    if (mode === 'reply') {
      // Antwort auf eigene gesendete Nachricht → an die ursprünglichen Empfänger
      to = fromIsOwn ? dedupe(original.to, ownAddresses) : dedupe(replyTargets, new Set());
    } else {
      to = dedupe(fromIsOwn ? original.to : [...replyTargets, ...original.to], ownAddresses);
      cc = dedupe(original.cc ?? [], new Set([...ownAddresses, ...to.map((a) => a.address.toLowerCase())]));
    }
  }
  // Ziel-Identität: die Adresse, an die die Mail ging
  const identityAddress = [...original.to, ...(original.cc ?? [])].find((a) => isOwn(a.address, ownAddresses))?.address;

  const cids = referencedCids(quoteHtml);
  const attachments =
    mode === 'forward'
      ? original.attachments
      : original.attachments.filter((a) => a.inline && a.contentId && cids.has(a.contentId.toLowerCase()));

  return {
    mode,
    accountId: ref.accountId,
    identityAddress,
    message: {
      to,
      cc,
      subject: prefixSubject(original.subject, kind),
      html: bodyHtml ? bodyHtml : '<p></p>',
      inReplyTo: mode === 'forward' ? undefined : original.messageIdHeader,
      references:
        mode === 'forward'
          ? undefined
          : [...(original.references ?? []), ...(original.messageIdHeader ? [original.messageIdHeader] : [])].slice(-20),
      reference: { folderId: ref.folderId, messageId: ref.id, type: mode },
    },
    quoteHtml,
    original,
    originalRef: ref,
    copyAttachments: attachments.length ? { ref, attachments } : undefined,
  };
}

/** Entwurf zum Bearbeiten öffnen */
export function buildEditInit(detail: MessageDetail, ref: MessageRef): ComposerInit {
  return {
    mode: 'edit',
    accountId: ref.accountId,
    identityAddress: detail.from?.address,
    message: {
      to: detail.to,
      cc: detail.cc ?? [],
      bcc: detail.bcc ?? [],
      subject: detail.subject,
      html: detail.html ? sanitizeFragment(detail.html) : textToHtml(detail.text ?? ''),
      inReplyTo: detail.inReplyTo,
      references: detail.references,
    },
    copyAttachments: detail.attachments.length ? { ref, attachments: detail.attachments } : undefined,
    draftRef: { folderId: ref.folderId, messageId: ref.id },
    skipSignature: true,
  };
}

/* ───────────────────────────── Signaturen ───────────────────────────── */

export function pickDefaultSignature(
  signatures: Signature[],
  accountId: string | undefined,
  address: string | undefined,
  kind: 'new' | 'reply',
): Signature | undefined {
  const flag = (s: Signature) => (kind === 'new' ? s.defaultNew : s.defaultReply);
  const addr = address?.toLowerCase();
  const candidates = signatures.filter(flag);
  return (
    candidates.find((s) => s.accountId === accountId && s.identityAddress && s.identityAddress.toLowerCase() === addr) ??
    candidates.find((s) => !s.accountId && s.identityAddress && s.identityAddress.toLowerCase() === addr) ??
    candidates.find((s) => s.accountId === accountId && !s.identityAddress) ??
    candidates.find((s) => !s.accountId && !s.identityAddress)
  );
}

export const SIGNATURE_ATTR = 'data-signature';

export function stripSignature(html: string): string {
  if (!html.includes(SIGNATURE_ATTR)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(`[${SIGNATURE_ATTR}]`).forEach((el) => el.remove());
  return doc.body.innerHTML;
}

export function extractSignature(html: string): string {
  if (!html.includes(SIGNATURE_ATTR)) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll(`[${SIGNATURE_ATTR}]`))
    .map((el) => el.outerHTML)
    .join('');
}

export function signatureBlock(content: string): string {
  const inner = /<[a-z][\s\S]*>/i.test(content) ? content : textToHtml(content);
  return `<div ${SIGNATURE_ATTR}="true">${inner}</div>`;
}

/** Fügt eine HTML-Signatur ans Ende (ersetzt vorhandene) */
export function applyHtmlSignature(html: string, sig: Signature | undefined): string {
  const body = stripSignature(html || '<p></p>');
  return sig && sig.mode === 'html' ? `${body}<p></p>${signatureBlock(sig.content)}` : body;
}

/** RAW-Signatur unverändert übernehmen; reiner Text → <pre> */
export function rawSignatureHtml(raw: string): string {
  return /<[a-z!][\s\S]*>/i.test(raw) ? raw : `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(raw)}</pre>`;
}

/* ───────────────────────────── Vor dem Senden ───────────────────────────── */

let cidCounter = 0;

/**
 * Wandelt Inline-Bilder des Editors in cid:-Anhänge um:
 *  - /api/uploads/<id>?inline=1 → Anhang mit uploadId
 *  - data:-URLs → Anhang mit contentBase64
 */
export function prepareInlineImages(html: string): { html: string; attachments: OutgoingAttachment[] } {
  if (!/<img/i.test(html)) return { html, attachments: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const attachments: OutgoingAttachment[] = [];
  const byUpload = new Map<string, string>();
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const up = src.match(/^\/api\/uploads\/([^/?#]+)/);
    if (up) {
      const uploadId = up[1]!;
      let cid = byUpload.get(uploadId);
      if (!cid) {
        cid = `${uploadId}@kuvert`;
        byUpload.set(uploadId, cid);
        attachments.push({ filename: img.getAttribute('alt') || `bild-${attachments.length + 1}`, uploadId, inline: true, contentId: cid });
      }
      img.setAttribute('src', `cid:${cid}`);
      return;
    }
    const data = src.match(/^data:([^;,]+);base64,(.+)$/);
    if (data) {
      const ct = data[1]!;
      const ext = ct.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const cid = `img${Date.now().toString(36)}${cidCounter++}@kuvert`;
      attachments.push({ filename: `bild-${attachments.length + 1}.${ext}`, contentType: ct, contentBase64: data[2]!, inline: true, contentId: cid });
      img.setAttribute('src', `cid:${cid}`);
    }
  });
  return { html: doc.body.innerHTML, attachments };
}

/** Blöcke, die im Editor (Tailwind-Preflight + editor.css) ohne eigenen Rand dargestellt werden */
const UNSPACED_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre';

/**
 * Übernimmt die Abstände des Editors als Inline-Stile. Ohne sie zeigen
 * Mailprogramme jeden Absatz mit dem Browser-Standardrand von 1em –
 * Signaturen und Anreden wirken dann auseinandergezogen.
 */
function inlineEditorSpacing(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // ".ProseMirror > * + *": 0,5em Abstand zwischen Blöcken der obersten Ebene
  Array.from(doc.body.children).forEach((el, i) => {
    if (i > 0 && el instanceof HTMLElement && !el.style.marginTop) el.style.marginTop = '0.5em';
  });
  doc.body.querySelectorAll<HTMLElement>(UNSPACED_BLOCKS).forEach((el) => {
    if (!el.style.marginTop) el.style.marginTop = '0';
    if (!el.style.marginBottom) el.style.marginBottom = '0';
  });
  // Leere Absätze stehen im Editor für eine Leerzeile; ohne Inhalt fielen sie auf 0 px zusammen
  doc.body.querySelectorAll('p').forEach((p) => {
    if (!p.childNodes.length) p.appendChild(doc.createElement('br'));
  });
  return doc.body.innerHTML;
}

/** Standard-Schrift und Editor-Abstände für den Editor-Teil der Mail */
export function wrapBody(html: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${inlineEditorSpacing(html)}</div>`;
}

export function addressesToString(list: EmailAddress[] | undefined): string {
  return (list ?? []).map(formatAddress).join(', ');
}

export const ATTACHMENT_KEYWORDS = /\b(anhang|anbei|angehängt|im anhang|beigefügt|attached|attachment|enclosed)\b/i;
