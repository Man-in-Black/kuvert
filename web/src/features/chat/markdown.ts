/**
 * Chat-Markdown (bewusst kleiner Umfang): **fett**, _kursiv_/*kursiv*, ~~durch~~,
 * `Code`, ```Codeblock```, > Zitat, - Liste, 1. Liste, [Text](https://…) und nackte URLs.
 *
 * Gespeichert wird Markdown (lesbar in Suche, Vorschau, Push, Webhooks, API).
 * - parseMarkdown → AST für die Anzeige (format.tsx) und den Editor (markdownToHtml)
 * - editorToMarkdown → TipTap-Dokument zurück in Markdown
 */
import type { JSONContent } from '@tiptap/react';

/* ───────────────────────────── AST ───────────────────────────── */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold' | 'italic' | 'strike'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

/** Eine Zeile = Liste von Inline-Knoten */
export type Line = Inline[];

export type Block =
  | { t: 'p'; lines: Line[] }
  | { t: 'code'; v: string }
  | { t: 'quote'; lines: Line[] }
  | { t: 'ul'; items: Line[][] }
  | { t: 'ol'; start: number; items: Line[][] };

const INLINE =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(\*\*[^\n]+?\*\*)|(~~[^\n]+?~~)|((?<![\w*])\*[^*\s](?:[^*\n]*[^*\s])?\*(?![\w*]))|((?<![\w_])_[^_\s](?:[^_\n]*[^_\s])?_(?![\w_]))|(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])|(www\.[^\s<>]+[^\s<>.,;:!?)\]'"])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ t: 'text', v: text.slice(last, start) });
    const s = m[0];
    if (m[1]) out.push({ t: 'code', v: s.slice(1, -1) });
    else if (m[2]) {
      const mid = s.indexOf('](');
      out.push({ t: 'link', href: s.slice(mid + 2, -1), c: parseInline(s.slice(1, mid)) });
    } else if (m[3]) out.push({ t: 'bold', c: parseInline(s.slice(2, -2)) });
    else if (m[4]) out.push({ t: 'strike', c: parseInline(s.slice(2, -2)) });
    else if (m[5] || m[6]) out.push({ t: 'italic', c: parseInline(s.slice(1, -1)) });
    else out.push({ t: 'link', href: m[8] ? `https://${s}` : s, c: [{ t: 'text', v: s }] });
    last = start + s.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const BULLET = /^\s{0,3}[-*•]\s+/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+/;
const QUOTE = /^>\s?/;
const CONTINUATION = /^\s{2,}\S/;

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const parts = md.replace(/\r\n?/g, '\n').split(/```(?:[\w+-]*\n)?([\s\S]*?)```/g);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      blocks.push({ t: 'code', v: part.replace(/\n$/, '') });
      return;
    }
    let text = part;
    // Zeilenumbrüche direkt an Codeblöcken entfallen
    if (idx > 0) text = text.replace(/^\n/, '');
    if (idx < parts.length - 1) text = text.replace(/\n$/, '');
    if (!text) return;
    for (const raw of text.split('\n')) {
      const prev = blocks[blocks.length - 1];
      if (QUOTE.test(raw)) {
        const line = parseInline(raw.replace(QUOTE, ''));
        if (prev?.t === 'quote') prev.lines.push(line);
        else blocks.push({ t: 'quote', lines: [line] });
      } else if (BULLET.test(raw)) {
        const item = [parseInline(raw.replace(BULLET, ''))];
        if (prev?.t === 'ul') prev.items.push(item);
        else blocks.push({ t: 'ul', items: [item] });
      } else if (ORDERED.test(raw)) {
        const n = Number(raw.match(ORDERED)![1]);
        const item = [parseInline(raw.replace(ORDERED, ''))];
        if (prev?.t === 'ol') prev.items.push(item);
        else blocks.push({ t: 'ol', start: n, items: [item] });
      } else if ((prev?.t === 'ul' || prev?.t === 'ol') && CONTINUATION.test(raw)) {
        // Eingerückte Folgezeile gehört zum letzten Listenpunkt
        prev.items[prev.items.length - 1]!.push(parseInline(raw.trim()));
      } else {
        const line = parseInline(raw);
        if (prev?.t === 'p') prev.lines.push(line);
        else blocks.push({ t: 'p', lines: [line] });
      }
    }
  });
  return blocks;
}

/* ───────────────────────────── Markdown → Editor-HTML ───────────────────────────── */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return esc(n.v);
        case 'code':
          return `<code>${esc(n.v)}</code>`;
        case 'bold':
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case 'italic':
          return `<em>${inlineHtml(n.c)}</em>`;
        case 'strike':
          return `<s>${inlineHtml(n.c)}</s>`;
        case 'link':
          return `<a href="${esc(n.href)}">${inlineHtml(n.c)}</a>`;
      }
    })
    .join('');
}

const linesToParagraphs = (lines: Line[]) => lines.map((l) => `<p>${inlineHtml(l)}</p>`).join('');
const itemHtml = (item: Line[]) => `<li><p>${item.map(inlineHtml).join('<br>')}</p></li>`;

/** Für den Editor: jede Zeile wird ein eigener Absatz (Enter = neue Zeile) */
export function markdownToHtml(md: string): string {
  if (!md) return '';
  return parseMarkdown(md)
    .map((b) => {
      switch (b.t) {
        case 'p':
          return linesToParagraphs(b.lines);
        case 'code':
          return `<pre><code>${esc(b.v)}</code></pre>`;
        case 'quote':
          return `<blockquote>${linesToParagraphs(b.lines)}</blockquote>`;
        case 'ul':
          return `<ul>${b.items.map(itemHtml).join('')}</ul>`;
        case 'ol':
          return `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>${b.items.map(itemHtml).join('')}</ol>`;
      }
    })
    .join('');
}

/* ───────────────────────────── Editor → Markdown ───────────────────────────── */

type Mark = NonNullable<JSONContent['marks']>[number];

const WRAP: Record<string, string> = { bold: '**', italic: '_', strike: '~~' };
const SIMPLE = Object.keys(WRAP);

/**
 * Inline-Inhalt eines Absatzes. Markierungen werden über benachbarte Textstücke
 * zusammengefasst (Stapel wie in prosemirror-markdown), Leerraum am Rand bleibt
 * außerhalb der Markierung (sonst wäre "_kursiv _" kein gültiges Markdown).
 * Zeilenumbrüche (hardBreak) werden zu \n.
 */
function inlineMd(nodes: JSONContent[] | undefined): string {
  let out = '';
  let pending = '';
  const active: string[] = [];
  const close = (keep: number) => {
    while (active.length > keep) out += WRAP[active.pop()!];
  };
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      close(0);
      out += `${pending}\n`;
      pending = '';
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const [, lead = '', core = '', trail = ''] = n.text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
    if (!core) {
      pending += n.text;
      continue;
    }
    const marks: Mark[] = n.marks ?? [];
    const simple = SIMPLE.filter((t) => marks.some((m) => m.type === t));
    let keep = 0;
    while (keep < active.length && simple.includes(active[keep]!)) keep++;
    close(keep);
    out += pending;
    pending = '';
    // Neue Markierungen erst nach dem führenden Leerraum öffnen
    out += lead;
    for (const t of simple) {
      if (active.includes(t)) continue;
      out += WRAP[t];
      active.push(t);
    }

    let text = core;
    if (marks.some((m) => m.type === 'code')) text = `\`${core.replace(/`/g, 'ˋ')}\``;
    const href = marks.find((m) => m.type === 'link')?.attrs?.href as string | undefined;
    if (href && href !== core) text = /^https?:\/\//i.test(href) ? `[${text}](${href})` : text;
    out += text;
    pending = trail;
  }
  close(0);
  return out + pending;
}

function blockMd(n: JSONContent): string {
  switch (n.type) {
    case 'paragraph':
      return inlineMd(n.content);
    case 'heading':
      return `**${inlineMd(n.content)}**`;
    case 'codeBlock':
      return `\`\`\`\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n\`\`\``;
    case 'blockquote':
      return (n.content ?? [])
        .map(blockMd)
        .join('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'bulletList':
    case 'orderedList': {
      const start = Number(n.attrs?.start ?? 1) || 1;
      return (n.content ?? [])
        .map((item, i) => {
          const prefix = n.type === 'bulletList' ? '- ' : `${start + i}. `;
          const body = (item.content ?? []).map(blockMd).join('\n');
          return prefix + body.split('\n').join(`\n${' '.repeat(prefix.length)}`);
        })
        .join('\n');
    }
    case 'horizontalRule':
      return '---';
    default:
      return inlineMd(n.content);
  }
}

export function editorToMarkdown(doc: JSONContent): string {
  return (doc.content ?? [])
    .map(blockMd)
    .join('\n')
    .replace(/\s+$/, '');
}
