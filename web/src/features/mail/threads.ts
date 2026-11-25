/**
 * Konversationsansicht: gruppiert eine Nachrichtenliste nach Unterhaltung.
 *
 * Reihenfolge der Kriterien:
 *  1. Thread-ID des Anbieters (Gmail threadId, Graph conversationId, IMAP THREADID)
 *  2. Message-ID ↔ In-Reply-To innerhalb der geladenen Nachrichten
 *  3. Nur ohne Thread-ID: gleicher Betreff ohne „Re:/AW:/WG:“, sofern mindestens
 *     eine der Nachrichten eine Antwort/Weiterleitung ist
 *
 * Gruppiert wird immer nur innerhalb eines Kontos und nur über die bereits
 * geladenen Nachrichten.
 */
import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { MessageDetail, MessageSummary, ThreadQuery } from '@kuvert/shared';
import { fetchThread, mailKeys, refKey, setFlags, toRef, type MessageRef } from './api';

export interface Conversation {
  /** Schlüssel der neuesten Nachricht – dient als Auswahl-/React-Schlüssel */
  key: string;
  latest: MessageSummary;
  /** Neueste zuerst */
  messages: MessageSummary[];
  unread: number;
  flagged: boolean;
  hasAttachments: boolean;
}

const PREFIX = /^\s*(?:(?:re|aw|antw|wg|fw|fwd|sv|vs|tr|rif|r)(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;

/** Betreff ohne „Re:/AW:/WG:“-Präfixe */
export const stripSubjectPrefix = (subject: string) => subject.replace(PREFIX, '').trim();

export function normalizeSubject(subject: string): string {
  return stripSubjectPrefix(subject).replace(/\s+/g, ' ').toLowerCase();
}

const isReply = (m: MessageSummary) => !!m.inReplyTo || PREFIX.test(m.subject);

const time = (m: MessageSummary) => {
  const t = Date.parse(m.date);
  return Number.isNaN(t) ? 0 : t;
};

/** Bei verschlüsselten Mails ist der einzige „Anhang“ der Container smime.p7m – Inhalt unbekannt */
const realAttachments = (m: MessageSummary) => m.hasAttachments && m.smime !== 'encrypted';

export function single(m: MessageSummary): Conversation {
  return { key: refKey(toRef(m)), latest: m, messages: [m], unread: m.seen ? 0 : 1, flagged: m.flagged, hasAttachments: realAttachments(m) };
}

/** Unterhaltung aus bereits zusammengehörenden Nachrichten (mindestens eine) */
export function conversationOf(msgs: MessageSummary[]): Conversation {
  if (msgs.length === 1) return single(msgs[0]!);
  const sorted = [...msgs].sort((a, b) => time(b) - time(a));
  const latest = sorted[0]!;
  return {
    key: refKey(toRef(latest)),
    latest,
    messages: sorted,
    unread: sorted.filter((m) => !m.seen).length,
    flagged: sorted.some((m) => m.flagged),
    hasAttachments: sorted.some(realAttachments),
  };
}

/** Gruppiert `items` (Reihenfolge der Liste bleibt erhalten: Position der neuesten Nachricht). */
export function groupConversations(items: MessageSummary[]): Conversation[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const link = (map: Map<string, number>, key: string, i: number) => {
    const j = map.get(key);
    if (j === undefined) map.set(key, i);
    else union(j, i);
  };

  const byThread = new Map<string, number>();
  const byMsgId = new Map<string, number>();
  const bySubject = new Map<string, number[]>();
  items.forEach((m, i) => {
    if (m.threadId) link(byThread, `${m.accountId}\n${m.threadId}`, i);
    if (m.messageIdHeader) link(byMsgId, `${m.accountId}\n${m.messageIdHeader}`, i);
    if (!m.threadId) {
      const s = normalizeSubject(m.subject);
      if (s) {
        const k = `${m.accountId}\n${s}`;
        const list = bySubject.get(k);
        if (list) list.push(i);
        else bySubject.set(k, [i]);
      }
    }
  });
  items.forEach((m, i) => {
    if (!m.inReplyTo) return;
    const j = byMsgId.get(`${m.accountId}\n${m.inReplyTo}`);
    if (j !== undefined) union(j, i);
  });
  for (const list of bySubject.values()) {
    if (list.length > 1 && list.some((i) => isReply(items[i]!))) for (const i of list) union(list[0]!, i);
  }

  const groups = new Map<number, MessageSummary[]>();
  const order: number[] = [];
  items.forEach((m, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(m);
    else {
      groups.set(r, [m]);
      order.push(r);
    }
  });

  const out = order.map((r) => conversationOf(groups.get(r)!));
  // Liste nach der neuesten Nachricht je Unterhaltung ordnen (Position in der Ursprungsliste)
  const pos = new Map(items.map((m, i) => [refKey(toRef(m)), i]));
  return out.sort((a, b) => pos.get(a.key)! - pos.get(b.key)!);
}

export const conversationRefs = (c: Conversation): MessageRef[] => c.messages.map(toRef);

export function findConversation(convs: Conversation[], key: string | undefined): Conversation | undefined {
  if (!key) return undefined;
  return convs.find((c) => c.key === key || c.messages.some((m) => refKey(toRef(m)) === key));
}

/** Alle Unterhaltungen, in denen mindestens eine Nachricht ausgewählt ist. */
export function selectedConversations(convs: Conversation[], selected: Set<string>): Conversation[] {
  if (!selected.size) return [];
  return convs.filter((c) => c.messages.some((m) => selected.has(refKey(toRef(m)))));
}

/** Markiert: alle markierten Nachrichten entmarkieren – sonst jeweils die neueste markieren. */
export function toggleConversationFlag(qc: QueryClient, convs: Conversation[]) {
  if (convs.every((c) => c.flagged)) return setFlags(qc, convs.flatMap((c) => c.messages.filter((m) => m.flagged)).map(toRef), { flagged: false });
  return setFlags(qc, convs.filter((c) => !c.flagged).map((c) => toRef(c.latest)), { flagged: true });
}

/** Ungelesene vorhanden: alle als gelesen – sonst jeweils die neueste als ungelesen. */
export function toggleConversationSeen(qc: QueryClient, convs: Conversation[]) {
  if (convs.some((c) => c.unread)) {
    const msgs = convs.flatMap((c) => c.messages.filter((m) => !m.seen));
    return setFlags(qc, msgs.map(toRef), { seen: true }, msgs);
  }
  const latest = convs.map((c) => c.latest);
  return setFlags(qc, latest.map(toRef), { seen: false }, latest);
}

/* ───────────── Ordnerübergreifende Unterhaltung ───────────── */

/** Abfrage für den Server: Thread-ID (falls bekannt) und alle bekannten Message-IDs */
export function threadQueryOf(c: Conversation): ThreadQuery {
  const ids = new Set<string>();
  for (const m of c.messages) {
    if (m.messageIdHeader) ids.add(m.messageIdHeader);
    if (m.inReplyTo) ids.add(m.inReplyTo);
    // Nur bei geladenen Details (z. B. Lesefenster): References enthält meist die ganze Kette
    const refs = (m as Partial<MessageDetail>).references;
    if (refs) for (const r of [...refs].reverse()) ids.add(r);
  }
  return {
    folderId: c.latest.folderId,
    messageId: c.latest.id,
    threadId: c.messages.find((m) => m.threadId)?.threadId,
    messageIds: [...ids].slice(0, 50),
  };
}

/**
 * Kann die Unterhaltung mehr Nachrichten haben als die Liste zeigt? Ja bei mehreren
 * Nachrichten im Ordner – oder bei einer Antwort, deren übrige Nachrichten in anderen
 * Ordnern liegen (Gesendet, Archiv …). Die Thread-ID allein reicht nicht: Gmail und
 * Graph vergeben sie auch an Einzelnachrichten.
 */
export function mayHaveThread(c: Conversation): boolean {
  return c.messages.length > 1 || c.messages.some(isReply);
}

/** Stabiler Cache-Schlüssel der Unterhaltung (ändert sich nicht, wenn neue Nachrichten dazukommen) */
export function threadCacheKey(c: Conversation): string {
  const oldest = c.messages[c.messages.length - 1]!;
  return c.messages.find((m) => m.threadId)?.threadId ?? oldest.messageIdHeader ?? refKey(toRef(oldest));
}

/** Dieselbe Nachricht in Liste und Thread erkennen (Ordner-IDs können je nach Ansicht abweichen) */
function identities(m: MessageSummary): string[] {
  const out = [refKey(toRef(m))];
  if (m.messageIdHeader) out.push(`mid|${m.accountId}|${m.messageIdHeader}`);
  // Bei Anbietern mit Thread-ID (Graph, Gmail) sind Nachrichten-IDs kontoweit eindeutig
  if (m.threadId) out.push(`tid|${m.accountId}|${m.threadId}|${m.id}`);
  return out;
}

/**
 * Nachrichten der Liste plus ordnerübergreifend geladene (Gesendet, Archiv, Papierkorb …),
 * ohne Dubletten – bei Doppelten gewinnt die Nachricht aus der Liste. Neueste zuerst.
 */
export function mergeThread(listMessages: MessageSummary[], threadMessages: MessageSummary[]): MessageSummary[] {
  const seen = new Set<string>();
  const out: MessageSummary[] = [];
  for (const m of [...listMessages, ...threadMessages]) {
    const ids = identities(m);
    if (ids.some((id) => seen.has(id))) continue;
    ids.forEach((id) => seen.add(id));
    out.push(m);
  }
  return out.sort((a, b) => time(b) - time(a));
}

/**
 * Unterhaltung samt ordnerübergreifend nachgeladener Nachrichten (neueste zuerst).
 * Liste (aufgeklappte Zeile) und Leseansicht teilen sich denselben Cache-Eintrag.
 */
export function useConversationThread(c: Conversation, enabled = true) {
  const accountId = c.latest.accountId;
  const query = threadQueryOf(c);
  const thread = useQuery({
    queryKey: mailKeys.thread(accountId, threadCacheKey(c)),
    queryFn: () => fetchThread(accountId, query),
    enabled: enabled && (!!query.threadId || !!query.messageIds?.length),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const messages = useMemo(() => mergeThread(c.messages, thread.data?.items ?? []), [c.messages, thread.data]);
  return { thread, messages };
}
