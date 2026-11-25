/**
 * Einordnung anzeigen (Banner) und von Hand überschreiben, als erledigt markieren
 * oder neu einordnen lassen – für einzelne Nachrichten und ganze Unterhaltungen.
 */
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, RotateCcw, Sparkles, Tag, X } from 'lucide-react';
import {
  TRIAGE_PRIORITIES,
  TRIAGE_PRIORITY_LABELS,
  getTriageSettings,
  type MessageSummary,
} from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { useSettings } from '@/lib/queries';
import { Dropdown, IconButton, type MenuItem } from '@/components/ui';
import type { ConversationExtensionProps, MessageExtensionProps } from '@/features/mail/extension-types';
import { TriageBadge, TriagePendingBadge, conversationTriage, type DisplayTriage } from '@/features/mail/components/TriageBadge';
import { runTriageWithFeedback, useTriagePending } from '@/features/mail/triage-pending';
import { cn } from '@/lib/utils';
import { useOwnAddresses } from '@/features/mail/hooks';
import { removeTriage, setTriage, setTriageMany, type TriagePatch } from './api';

const guard = (p: Promise<unknown>, success?: string) =>
  void p.then(() => success && toast.success(success)).catch((err) => toast.error(errorMessage(err)));

type Target = { accountId: string; folderId: string; id: string; messageIdHeader?: string };

/** Neu einordnen: sofort als „in Arbeit“ zeigen, bis das Ergebnis per Ereignis kommt */
function rerun(targets: Target[]) {
  void runTriageWithFeedback(targets).catch((err) => toast.error(errorMessage(err)));
}

const heading = (text: string): MenuItem => ({ label: <span className="text-xs font-medium uppercase tracking-wide text-muted">{text}</span>, disabled: true });

/** Menüeinträge für eine Einordnung (Nachricht oder Unterhaltung) */
function triageItems(o: {
  triage?: DisplayTriage;
  categories: string[];
  rerunLabel: string;
  onRerun: () => void;
  onSet: (patch: TriagePatch) => void;
  onRemove?: () => void;
}): MenuItem[] {
  const t = o.triage;
  // Kategorie aus einer älteren Liste weiterhin anzeigen
  const categories = t && !o.categories.includes(t.category) ? [...o.categories, t.category] : o.categories;
  const done = !!t?.done && !t.answered;
  return [
    { label: o.rerunLabel, icon: <Sparkles />, onClick: o.onRerun },
    done
      ? { label: 'Wieder offen', icon: <RotateCcw />, onClick: () => o.onSet({ done: false }) }
      : { label: 'Als erledigt markieren', icon: <Check />, onClick: () => o.onSet({ done: true }) },
    { divider: true, label: '' },
    heading('Priorität'),
    ...TRIAGE_PRIORITIES.map((p) => ({ label: TRIAGE_PRIORITY_LABELS[p], checked: !!t && t.priority === p, onClick: () => o.onSet({ priority: p }) })),
    { divider: true, label: '' },
    heading('Kategorie'),
    ...categories.map((c) => ({ label: c, checked: !!t && t.category === c, onClick: () => o.onSet({ category: c }) })),
    ...(t && o.onRemove ? [{ divider: true, label: '' }, { label: 'Einordnung entfernen', icon: <X />, onClick: o.onRemove }] : []),
  ];
}

function TriageDropdown({ items, trigger }: { items: MenuItem[]; trigger: ReactNode }) {
  return <Dropdown className="[&>div:last-child]:max-h-[70vh] [&>div:last-child]:overflow-y-auto" align="right" trigger={trigger} items={items} />;
}

function useMessageTriageItems({ accountId, folderId, message }: MessageExtensionProps): MenuItem[] {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const target = { accountId, folderId, id: message.id, messageIdHeader: message.messageIdHeader };
  return triageItems({
    triage: message.triage,
    categories: getTriageSettings(settings).categories,
    rerunLabel: 'Mit KI neu einordnen',
    onRerun: () => rerun([target]),
    onSet: (patch) => guard(setTriage(qc, target, patch)),
    onRemove: () => guard(removeTriage(qc, target)),
  });
}

/** Leseansicht: Etikett-Symbol in der Aktionsleiste (pulsiert, solange die KI arbeitet) */
export function TriageMenu(props: MessageExtensionProps) {
  const items = useMessageTriageItems(props);
  const working = useTriagePending().isPending({ accountId: props.accountId, folderId: props.folderId, id: props.message.id });
  return (
    <TriageDropdown
      items={items}
      trigger={
        <IconButton label={working ? 'Wird mit KI eingeordnet …' : 'Einordnung (KI-Triage) ändern'} size="icon-sm" className={cn(working && 'text-primary')}>
          <Tag className={cn('h-4 w-4', working && 'animate-pulse')} />
        </IconButton>
      }
    />
  );
}

/** Banner, solange die KI arbeitet */
function WorkingBanner({ text }: { text: string }) {
  return (
    <div className="triage-working flex items-center gap-2 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary" role="status">
      <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse" />
      <span className="flex-1">{text}</span>
      <TriagePendingBadge label="läuft" className="bg-transparent" />
    </div>
  );
}

/** Zeile über dem Inhalt: Priorität, Kategorie, Begründung – mit „Ändern“ */
export function TriageBanner(props: MessageExtensionProps) {
  const items = useMessageTriageItems(props);
  const working = useTriagePending().isPending({ accountId: props.accountId, folderId: props.folderId, id: props.message.id });
  const t = props.message.triage;
  if (working) return <WorkingBanner text={t ? 'Wird mit KI neu eingeordnet …' : 'Wird mit KI eingeordnet …'} />;
  if (!t) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-xs text-muted">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
      <TriageBadge triage={t} showPriority />
      {t.reason && (
        <span className="min-w-0 flex-1 truncate" title={t.reason}>
          {t.reason}
        </span>
      )}
      {t.done && <span className="italic">erledigt</span>}
      {t.source === 'manual' && !t.done && <span className="italic">von Hand eingeordnet</span>}
      <span className={t.reason ? '' : 'flex-1'} />
      <TriageDropdown items={items} trigger={<button type="button" className="font-medium text-primary hover:underline">Ändern</button>} />
    </div>
  );
}

/** Unterhaltung: Einordnung für alle eingehenden Nachrichten auf einmal */
export function TriageConversationMenu({ messages }: ConversationExtensionProps) {
  const { settings } = useSettings();
  const own = useOwnAddresses();
  const pendingState = useTriagePending();
  // Eigene (gesendete) Mails werden nicht eingeordnet
  const incoming = messages.filter((m) => !own.has(m.from?.address?.toLowerCase() ?? ''));
  const targets = incoming.map((m: MessageSummary) => ({ accountId: m.accountId, folderId: m.folderId, id: m.id, messageIdHeader: m.messageIdHeader }));
  const t = conversationTriage(messages, own);
  const n = targets.length;
  const items = triageItems({
    triage: t,
    categories: getTriageSettings(settings).categories,
    rerunLabel: n > 1 ? `Alle ${n} Nachrichten neu einordnen` : 'Mit KI neu einordnen',
    onRerun: () => rerun(targets),
    // Priorität/Kategorie/Erledigt gelten für alle eingehenden Nachrichten der Unterhaltung
    onSet: (patch) => guard(setTriageMany(targets, patch)),
  });
  if (!n) return null;
  const working = pendingState.anyPending(targets);
  return (
    <TriageDropdown
      items={items}
      trigger={
        <IconButton
          label={working ? 'Unterhaltung wird mit KI eingeordnet …' : 'Einordnung der Unterhaltung (KI-Triage)'}
          size="icon-sm"
          className={cn(working && 'text-primary')}
        >
          <Tag className={cn('h-4 w-4', working && 'animate-pulse')} />
        </IconButton>
      }
    />
  );
}

