/**
 * Darstellung von Chat-Texten (Markdown aus markdown.ts) – ohne HTML-Einschleusung,
 * alles als React-Knoten. Dazu Systemnachrichten, Vorschautexte und Zeitangaben.
 */
import { Fragment, type ReactNode } from 'react';
import { format, isSameDay, isToday, isYesterday } from 'date-fns';
import { de } from 'date-fns/locale';
import type { ChatSystemEvent, ChatUser } from '@kuvert/shared';
import { userName } from './api';
import { parseMarkdown, type Inline, type Line } from './markdown';

function renderInline(nodes: Inline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}-${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'code':
        return (
          <code key={k} className="rounded bg-black/10 px-1 py-px font-mono text-[0.9em] dark:bg-white/10">
            {n.v}
          </code>
        );
      case 'bold':
        return <strong key={k}>{renderInline(n.c, k)}</strong>;
      case 'italic':
        return <em key={k}>{renderInline(n.c, k)}</em>;
      case 'strike':
        return <s key={k}>{renderInline(n.c, k)}</s>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" className="break-all underline decoration-current/40 underline-offset-2 hover:decoration-current">
            {renderInline(n.c, k)}
          </a>
        );
    }
  });
}

function renderLines(lines: Line[], key: string): ReactNode[] {
  return lines.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(l, `${key}-${i}`)}
    </Fragment>
  ));
}

/** Text einer Nachricht als React-Knoten (kein HTML, daher sicher) */
export function renderBody(body: string): ReactNode {
  return parseMarkdown(body).map((b, i) => {
    const key = String(i);
    switch (b.t) {
      case 'p':
        // inline, damit die Uhrzeit (float) in die letzte Textzeile passt
        return <Fragment key={key}>{renderLines(b.lines, key)}</Fragment>;
      case 'code':
        return (
          <pre key={key} className="my-1 overflow-x-auto whitespace-pre rounded-lg bg-black/10 px-3 py-2 font-mono text-[12.5px] leading-relaxed dark:bg-white/10">
            {b.v}
          </pre>
        );
      case 'quote':
        return (
          <span key={key} className="my-0.5 block border-l-2 border-current/40 pl-2 opacity-80">
            {renderLines(b.lines, key)}
          </span>
        );
      case 'ul':
        return (
          <ul key={key} className="my-0.5 list-disc pl-5">
            {b.items.map((item, j) => <li key={j}>{renderLines(item, `${key}-${j}`)}</li>)}
          </ul>
        );
      case 'ol':
        return (
          <ol key={key} start={b.start} className="my-0.5 list-decimal pl-6">
            {b.items.map((item, j) => <li key={j}>{renderLines(item, `${key}-${j}`)}</li>)}
          </ol>
        );
    }
  });
}

/** Nur Emojis (1–3) → große Darstellung */
export function isEmojiOnly(body: string): boolean {
  const s = body.trim();
  if (!s || s.length > 24) return false;
  const stripped = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|\s/gu, '');
  if (stripped.length) return false;
  const count = [...new Intl.Segmenter('de', { granularity: 'grapheme' }).segment(s)].filter((g) => g.segment.trim()).length;
  return count >= 1 && count <= 3;
}

/** Einzeilige Vorschau (Liste, Antwortzitat, Benachrichtigung) */
export function previewOf(body: string, attachments = 0): string {
  const text = body
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/^>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*•]|\d{1,9}[.)])\s+/gm, '')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/(\*\*|~~|`)/g, '')
    // _kursiv_ / *kursiv* → kursiv (Unterstriche in Wörtern wie snake_case bleiben)
    .replace(/(^|[^\w*])[_*](?=\S)([^_*\n]*?\S)[_*](?![\w*])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text;
  if (attachments === 1) return '📎 Datei';
  if (attachments > 1) return `📎 ${attachments} Dateien`;
  return '';
}

/* ───────────────────────────── Systemnachrichten ───────────────────────────── */

export function parseSystem(body: string): ChatSystemEvent | null {
  try {
    return JSON.parse(body) as ChatSystemEvent;
  } catch {
    return null;
  }
}

export function systemText(body: string, users: Map<string, ChatUser>, me: string | undefined): string {
  const e = parseSystem(body);
  if (!e) return body;
  // Fertiger Text aus Mattermost/Talk
  if (e.action === 'text') return e.text ?? '';
  const actor = userName(e.actorId, users, me);
  const self = e.actorId === me;
  const names = (e.userIds ?? []).map((id) => (id === me ? 'dich' : userName(id, users, me))).join(', ');
  switch (e.action) {
    case 'created':
      return `${actor} ${self ? 'hast' : 'hat'} die Gruppe „${e.name ?? ''}“ erstellt`;
    case 'added':
      return `${actor} ${self ? 'hast' : 'hat'} ${names} hinzugefügt`;
    case 'removed':
      return `${actor} ${self ? 'hast' : 'hat'} ${names} entfernt`;
    case 'left':
      return `${actor} ${self ? 'hast' : 'hat'} die Gruppe verlassen`;
    case 'renamed':
      return `${actor} ${self ? 'hast' : 'hat'} die Gruppe in „${e.name ?? ''}“ umbenannt`;
    default:
      return '';
  }
}

/* ───────────────────────────── Zeit ───────────────────────────── */

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Heute';
  if (isYesterday(d)) return 'Gestern';
  return format(d, d.getFullYear() === new Date().getFullYear() ? 'EEEE, d. MMMM' : 'EEEE, d. MMMM yyyy', { locale: de });
}

export const timeOf = (iso: string) => format(new Date(iso), 'HH:mm', { locale: de });

export const sameDay = (a: string, b: string) => isSameDay(new Date(a), new Date(b));
