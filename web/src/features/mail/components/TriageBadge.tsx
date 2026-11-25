/**
 * Anzeige der KI-Triage (Priorität + Kategorie) in Liste und Leseansicht.
 * Die Daten hängen an `MessageSummary.triage` (Server-Modul "triage").
 */
import { Check, ChevronDown, ChevronsUp, LoaderCircle } from 'lucide-react';
import { TRIAGE_PRIORITY_LABELS, type MessageSummary, type TriageInfo, type TriagePriority } from '@kuvert/shared';
import { cn } from '@/lib/utils';

const RANK: Record<TriagePriority, number> = { high: 2, normal: 1, low: 0 };

/** Einordnung einer Unterhaltung bzw. Nachricht für die Anzeige */
export type DisplayTriage = TriageInfo & {
  /** Nach der Nachricht kam eine eigene Antwort – gilt als erledigt */
  answered?: boolean;
};

/**
 * Einordnung einer Unterhaltung (Nachrichten neueste zuerst): die höchste Priorität unter
 * den noch offenen Nachrichten. Offen ist eine Nachricht, wenn sie nicht als erledigt
 * markiert ist und danach keine eigene Mail (Antwort aus „Gesendet“) in der Unterhaltung
 * folgt. Ist nichts mehr offen, wird die höchste Einordnung als erledigt geliefert.
 */
export function conversationTriage(messages: MessageSummary[], own?: Set<string>): DisplayTriage | undefined {
  let lastOwn = -Infinity;
  if (own?.size) {
    for (const m of messages) {
      const from = m.from?.address?.toLowerCase();
      if (from && own.has(from)) lastOwn = Math.max(lastOwn, Date.parse(m.date) || 0);
    }
  }
  let best: TriageInfo | undefined;
  let bestOpen: TriageInfo | undefined;
  let answered = false;
  for (const m of messages) {
    const t = m.triage;
    if (!t) continue;
    if (!best || RANK[t.priority] > RANK[best.priority]) best = t;
    // Beantwortet: eigene Mail danach im Thread oder \Answered (IMAP)
    const replied = (Date.parse(m.date) || 0) < lastOwn || !!m.answered;
    if (replied) answered = true;
    if (!t.done && !replied && (!bestOpen || RANK[t.priority] > RANK[bestOpen.priority])) bestOpen = t;
  }
  if (bestOpen) return bestOpen;
  if (!best) return undefined;
  return { ...best, done: true, answered: answered && !best.done };
}

/** Für den Filter „Wichtig“: offene Unterhaltung mit hoher Priorität */
export const isImportant = (messages: MessageSummary[], own?: Set<string>) => {
  const t = conversationTriage(messages, own);
  return !!t && t.priority === 'high' && !t.done;
};

const TONES: Record<TriagePriority, string> = {
  high: 'bg-danger/10 text-danger ring-danger/25',
  normal: 'bg-surface-2 text-fg/75 ring-border',
  low: 'bg-transparent text-muted ring-border/70',
};

export function TriageBadge({ triage, className, showPriority }: { triage: DisplayTriage; className?: string; showPriority?: boolean }) {
  const done = !!triage.done;
  const title = [
    `KI-Triage: Priorität ${TRIAGE_PRIORITY_LABELS[triage.priority].toLowerCase()} · ${triage.category}`,
    triage.reason,
    done ? (triage.answered ? 'Erledigt – du hast geantwortet' : 'Als erledigt markiert') : '',
    triage.source === 'manual' ? '(von Hand eingeordnet)' : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-[11rem] shrink-0 items-center gap-0.5 truncate rounded px-1.5 text-[11px] font-medium leading-4 ring-1 ring-inset',
        done ? 'bg-transparent text-muted ring-border/70' : TONES[triage.priority],
        className,
      )}
    >
      {done ? (
        <Check className="h-3 w-3 shrink-0" />
      ) : triage.priority === 'high' ? (
        <ChevronsUp className="h-3 w-3 shrink-0" />
      ) : triage.priority === 'low' ? (
        <ChevronDown className="h-3 w-3 shrink-0" />
      ) : null}
      {showPriority && <span className="shrink-0">{TRIAGE_PRIORITY_LABELS[triage.priority]} ·</span>}
      <span className={cn('truncate', done && 'line-through decoration-muted/60')}>{triage.category}</span>
    </span>
  );
}

/* ───────────── Sortieren & Filtern der Liste ───────────── */

/** Filter nach Einordnung: Priorität (nur offene), erledigt/beantwortet oder noch ohne Einordnung */
export type PriorityFilter = TriagePriority | 'done' | 'none';

export const PRIORITY_FILTER_LABELS: Record<PriorityFilter, string> = {
  high: 'Hoch',
  normal: 'Normal',
  low: 'Niedrig',
  done: 'Erledigt / beantwortet',
  none: 'Ohne Einordnung',
};

export function matchesPriorityFilter(t: DisplayTriage | undefined, f: PriorityFilter): boolean {
  if (f === 'none') return !t;
  if (!t) return false;
  if (f === 'done') return !!t.done;
  return !t.done && t.priority === f;
}

/** Sortierschlüssel (höher = weiter oben): offen hoch > normal/ohne > niedrig > erledigt */
export function triageSortKey(t: DisplayTriage | undefined): number {
  if (!t) return RANK.normal;
  if (t.done) return -1;
  return RANK[t.priority];
}

/** Platzhalter, solange die KI die Nachricht (neu) einordnet */
export function TriagePendingBadge({ className, label = 'Einordnen …' }: { className?: string; label?: string }) {
  return (
    <span
      title="Wird gerade mit KI eingeordnet …"
      className={cn(
        'triage-working inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-4 text-primary ring-1 ring-inset ring-primary/30',
        className,
      )}
    >
      <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
      {label}
    </span>
  );
}
