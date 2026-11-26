/**
 * Darstellung von KI-Antworten: Markdown (Parser aus dem Chat-Modul) als React-Knoten –
 * ohne HTML-Einschleusung. Quellenverweise wie [2] werden zu Links auf die Mail.
 */
import { Fragment, type ReactNode } from 'react';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { parseMarkdown, type Inline, type Line } from '@/features/chat/markdown';

/** Was Modelle gern ausgeben, der Chat-Parser aber nicht kennt, vereinfachen */
export function normalizeAiMarkdown(text: string): { text: string; thinking: boolean } {
  // Denkprozess von Reasoning-Modellen (<think>…</think>) ausblenden
  const open = text.lastIndexOf('<think>');
  const thinking = open >= 0 && text.indexOf('</think>', open) < 0;
  let out = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  out = out
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '**$1**') // Überschriften → fett
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '') // Trennlinien
    .replace(/__(\S[^_\n]*?\S)__/g, '**$1**')
    .trim();
  return { text: out, thinking };
}

const CITE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

function renderText(text: string, key: string, cite?: (n: number) => ReactNode): ReactNode {
  if (!cite || !text.includes('[')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const nums = m[1]!.split(',').map((n) => Number(n.trim()));
    out.push(
      <Fragment key={`${key}-c${start}`}>
        {nums.map((n, i) => (
          <Fragment key={n}>
            {i > 0 && ' '}
            {cite(n) ?? `[${n}]`}
          </Fragment>
        ))}
      </Fragment>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderInline(nodes: Inline[], key: string, cite?: (n: number) => ReactNode): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}-${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{renderText(n.v, k, cite)}</Fragment>;
      case 'code':
        return (
          <code key={k} className="rounded bg-black/10 px-1 py-px font-mono text-[0.9em] dark:bg-white/10">
            {n.v}
          </code>
        );
      case 'bold':
        return <strong key={k}>{renderInline(n.c, k, cite)}</strong>;
      case 'italic':
        return <em key={k}>{renderInline(n.c, k, cite)}</em>;
      case 'strike':
        return <s key={k}>{renderInline(n.c, k, cite)}</s>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline decoration-current/40 underline-offset-2 hover:decoration-current">
            {renderInline(n.c, k, cite)}
          </a>
        );
    }
  });
}

function renderLines(lines: Line[], key: string, cite?: (n: number) => ReactNode): ReactNode[] {
  return lines.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(l, `${key}-${i}`, cite)}
    </Fragment>
  ));
}

export function AiMarkdown({ text, cite }: { text: string; cite?: (n: number) => ReactNode }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'p':
            return <p key={k}>{renderLines(b.lines, k, cite)}</p>;
          case 'code':
            return <CodeBlock key={k} code={b.v} lang={b.lang} compact />;
          case 'quote':
            return (
              <blockquote key={k} className="border-l-2 border-border-strong pl-3 text-muted">
                {renderLines(b.lines, k, cite)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={k} className="ml-5 list-disc space-y-0.5">
                {b.items.map((item, j) => (
                  <li key={j}>{renderLines(item, `${k}-${j}`, cite)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k} start={b.start} className="ml-5 list-decimal space-y-0.5">
                {b.items.map((item, j) => (
                  <li key={j}>{renderLines(item, `${k}-${j}`, cite)}</li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
