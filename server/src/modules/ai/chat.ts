/**
 * KI-Chat: freie Fragen an das Sprachmodell – global, zu einer einzelnen Mail oder zu
 * einem ganzen Verlauf. Optional wird das Postfach durchsucht (Suchindex, sonst Live-Suche
 * beim Anbieter) und die Treffer fließen als Quellen in die Antwort ein.
 */
import type { AiChatRequest, AiChatSource, MessageSummary, User } from '@kuvert/shared';
import type { AccountRecord, ModuleContext } from '../../core/module.js';
import { settleByAccount } from '../../routes/util.js';
import { chatComplete, type ChatMessage } from './backends.js';

/** Obergrenzen, damit kleine lokale Modelle (Kontextfenster) nicht überlaufen */
const CONTEXT_BUDGET = 16_000;
const HISTORY_BUDGET = 12_000;
const MAX_TURNS = 20;
const SEARCH_HITS = 12;
const FULLTEXT_HITS = 4;
const FULLTEXT_CHARS = 2_500;
const LIVE_SEARCH_TIMEOUT = 15_000;

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function today(): string {
  const d = new Date();
  return `${WEEKDAYS[d.getDay()]}, ${d.toISOString().slice(0, 10)}`;
}

/* ───────────────────────────── Verlauf kürzen ───────────────────────────── */

/** Die neuesten Nachrichten behalten, bis das Budget erschöpft ist (die aktuelle Frage immer) */
export function trimHistory(turns: AiChatRequest['messages']): ChatMessage[] {
  const recent = turns.slice(-MAX_TURNS);
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i]!;
    const content = i === recent.length - 1 ? t.content.slice(0, HISTORY_BUDGET) : t.content;
    if (out.length && used + content.length > HISTORY_BUDGET) break;
    out.unshift({ role: t.role, content });
    used += content.length;
  }
  // Manche Modelle mögen keinen Verlauf, der mit einer Antwort beginnt
  while (out.length > 1 && out[0]!.role === 'assistant') out.shift();
  return out;
}

/* ───────────────────────────── Systemprompt ───────────────────────────── */

export function buildChatSystem(opts: {
  user: User;
  language: string;
  context?: AiChatRequest['context'];
  /** Suchtreffer als fertiger Textblock */
  sources?: string;
  searchQuery?: string;
  searched: boolean;
}): string {
  const parts = [
    'Du bist der KI-Assistent in Kuvert, einer selbst gehosteten App für E-Mail, Kalender, Kontakte, Aufgaben und Dateien.',
    `Heute ist ${today()}. Der Benutzer heißt ${opts.user.name} <${opts.user.email}>.`,
    `Antworte auf ${opts.language}, außer der Benutzer schreibt erkennbar in einer anderen Sprache.`,
    'Antworte hilfreich, konkret und so kurz wie möglich. Du darfst einfaches Markdown verwenden (**fett**, Listen, `Code`), aber keine Tabellen und keine Überschriften mit #.',
    'Erfinde keine Inhalte, Namen, Termine oder Zusagen. Wenn eine Information nicht im mitgegebenen Material steht, sag das offen.',
    'Wenn du eine E-Mail entwerfen sollst, gib nur den Mailtext mit Anrede und Grußformel aus, ohne Signatur und ohne Platzhalternamen.',
  ];
  if (opts.context?.text.trim()) {
    const what =
      opts.context.kind === 'conversation'
        ? 'den folgenden E-Mail-Verlauf (älteste Nachricht zuerst; „(ich)“ markiert eigene Nachrichten)'
        : opts.context.kind === 'meeting'
          ? 'das folgende aufgezeichnete Gespräch (Zusammenfassung, Aufgaben/Fragen und Transkript mit Zeitmarken und Sprechern)'
          : 'die folgende E-Mail';
    parts.push(
      `Der Benutzer hat ${what} geöffnet und stellt Fragen dazu. Beziehe dich darauf.\n"""\n${opts.context.text.trim().slice(0, CONTEXT_BUDGET)}\n"""`,
    );
  }
  if (opts.sources) {
    parts.push(
      `Für die aktuelle Frage wurde das Postfach durchsucht (Suchanfrage: ${opts.searchQuery}). Treffer, neueste zuerst:\n"""\n${opts.sources}\n"""\n` +
        'Stütze dich auf diese Mails und nenne bei Aussagen die Nummer der Mail in eckigen Klammern, z. B. [2]. ' +
        'Die Treffer sind möglicherweise unvollständig – sag das, wenn die Frage nach Vollständigkeit verlangt (z. B. „alle“, „wie viele“).',
    );
  } else if (opts.searched) {
    parts.push(`Für die aktuelle Frage wurde das Postfach durchsucht (Suchanfrage: ${opts.searchQuery}), aber es gab keine Treffer. Sag das dem Benutzer.`);
  }
  return parts.join('\n\n');
}

/* ───────────────────────────── Postfach-Suche ───────────────────────────── */

const SEARCH_SYNTAX = [
  'Syntax der Suche:',
  '- Freitext: wenige aussagekräftige Stichwörter (alle müssen vorkommen), keine Füllwörter, keine ganzen Sätze',
  '- from:name oder from:adresse@domain.de – Absender; to:… – Empfänger',
  '- subject:wort – im Betreff; "exakte phrase"',
  '- has:attachment, is:unread, is:flagged',
  '- in:inbox | in:sent | in:archive | in:drafts',
  '- after:JJJJ-MM-TT und before:JJJJ-MM-TT – Zeitraum',
].join('\n');

/**
 * Lässt das Modell entscheiden, ob/wonach gesucht wird. Liefert null, wenn die Frage
 * keine Mails aus dem Postfach braucht.
 */
export async function planSearch(model: string, history: ChatMessage[], hasContext: boolean, signal: AbortSignal): Promise<string | null> {
  const convo = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Benutzer' : 'Assistent'}: ${m.content.slice(0, 1500)}`)
    .join('\n\n');
  const system = [
    'Du formulierst Suchanfragen für das E-Mail-Postfach des Benutzers.',
    `Heute ist ${today()}. Rechne relative Angaben („letzte Woche“, „im März“) in after:/before: um.`,
    SEARCH_SYNTAX,
    'Antworte ausschließlich mit JSON: {"search": true, "query": "…"} oder {"search": false}.',
    `search=false, wenn die letzte Frage keine Mails aus dem Postfach braucht (allgemeine Fragen, Formulierungshilfe${hasContext ? ', Fragen nur zur bereits geöffneten Mail' : ''}).`,
    'Lieber wenige Stichwörter plus passende Filter als viele Wörter – zu viele Wörter finden nichts.',
  ].join('\n');
  const raw = await chatComplete(
    model,
    [
      { role: 'system', content: system },
      { role: 'user', content: `Gespräch:\n${convo}\n\nErzeuge die Suchanfrage für die letzte Nachricht des Benutzers.` },
    ],
    { temperature: 0, signal, json: true },
  );
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { search?: boolean; query?: unknown };
    if (parsed.search === false || typeof parsed.query !== 'string') return null;
    const q = parsed.query.trim().slice(0, 300);
    return q || null;
  } catch {
    return null;
  }
}

/** Nur die Suchbefehle (from:, after: …) einer Anfrage – für den zweiten Versuch ohne Stichwörter */
function commandsOnly(q: string): string {
  return (q.match(/\w+:"[^"]*"|\w+:\S+/g) ?? []).join(' ');
}

async function searchOnce(ctx: ModuleContext, userId: string, query: string): Promise<MessageSummary[]> {
  const accs = ctx.accounts.withCapability(userId, 'mail');
  const idx = ctx.hooks.searchIndex;
  const ready = idx ? await idx.readyAccounts(userId) : new Set<string>();
  const indexedIds = accs.filter((a) => ready.has(a.id)).map((a) => a.id);
  const live = accs.filter((a) => !ready.has(a.id));

  const indexed = idx && indexedIds.length ? idx.search(userId, { q: query, accountIds: indexedIds, limit: SEARCH_HITS, offset: 0 }).catch(() => null) : null;
  const liveText = idx ? idx.plainText(query) : query.replace(/\w+:("[^"]*"|\S+)/g, ' ').replace(/\s+/g, ' ').trim();
  const liveSearch =
    live.length && liveText
      ? settleByAccount(live, async (a) => {
          const m = ctx.accounts.providersFor(a as AccountRecord).mail!;
          if (m.search) return (await m.search(liveText, { limit: SEARCH_HITS })).items.map((i) => ({ ...i, accountId: i.accountId || a.id }));
          const inbox = await m.getSpecialFolderId('inbox');
          return inbox ? (await m.listMessages({ folderId: inbox, search: liveText, limit: SEARCH_HITS })).items.map((i) => ({ ...i, accountId: i.accountId || a.id, folderId: i.folderId || inbox })) : [];
        })
      : null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), LIVE_SEARCH_TIMEOUT));
  const [ix, lv] = await Promise.all([indexed, liveSearch ? Promise.race([liveSearch, timeout]) : null]);
  return [...(ix?.items ?? []), ...(lv?.results.flatMap((r) => r.value) ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, SEARCH_HITS);
}

export async function searchMailbox(ctx: ModuleContext, userId: string, query: string): Promise<{ items: MessageSummary[]; query: string }> {
  let items = await searchOnce(ctx, userId, query);
  if (!items.length) {
    const fallback = commandsOnly(query);
    if (fallback && fallback !== query) {
      items = await searchOnce(ctx, userId, fallback);
      if (items.length) return { items, query: fallback };
    }
  }
  return { items, query };
}

/** Volltexte der besten Treffer nachladen (gebündelt je Konto/Ordner, wo der Anbieter das kann) */
async function loadTexts(ctx: ModuleContext, userId: string, items: MessageSummary[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const key = (m: MessageSummary) => `${m.accountId}|${m.folderId}|${m.id}`;
  await Promise.all(
    items.map(async (m) => {
      try {
        const mail = ctx.accounts.providersFor(ctx.accounts.get(userId, m.accountId)).mail;
        if (!mail) return;
        if (mail.getMessageTexts) {
          const texts = await mail.getMessageTexts(m.folderId, [m.id]);
          const t = texts.get(m.id);
          if (t && !t.encrypted) out.set(key(m), t.text);
          return;
        }
        const d = await mail.getMessage(m.folderId, m.id);
        out.set(key(m), d.text || (d.html ? d.html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ') : '') || d.preview || '');
      } catch {
        /* Vorschau genügt */
      }
    }),
  );
  return out;
}

function stripQuoted(text: string): string {
  const cut = text.search(/^(-{2,}\s*(Original Message|Ursprüngliche Nachricht)\s*-{2,}|(Am|On)\s.{4,200}(schrieb|wrote).{0,80}:?\s*$)/im);
  return (cut > 0 ? text.slice(0, cut) : text)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function formatSources(ctx: ModuleContext, userId: string, items: MessageSummary[]): Promise<{ text: string; sources: AiChatSource[] }> {
  const texts = await loadTexts(ctx, userId, items.slice(0, FULLTEXT_HITS));
  const blocks = items.map((m, i) => {
    const full = texts.get(`${m.accountId}|${m.folderId}|${m.id}`);
    const body = full ? stripQuoted(full).slice(0, FULLTEXT_CHARS) : (m.preview ?? '').slice(0, 300);
    const flags = [m.seen === false ? 'ungelesen' : '', m.flagged ? 'markiert' : '', m.hasAttachments ? 'mit Anhang' : ''].filter(Boolean).join(', ');
    return [
      `[${i + 1}] Datum: ${m.date}`,
      `Von: ${m.from?.name ?? ''} <${m.from?.address ?? ''}>`,
      m.to?.length ? `An: ${m.to.map((t) => t.name || t.address).join(', ')}` : '',
      `Betreff: ${m.subject || '(ohne Betreff)'}`,
      flags ? `Status: ${flags}` : '',
      `${full ? 'Inhalt' : 'Auszug'}: ${body}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return {
    text: blocks.join('\n\n'),
    sources: items.map((m) => ({ accountId: m.accountId, folderId: m.folderId, id: m.id, subject: m.subject, from: m.from, date: m.date })),
  };
}
