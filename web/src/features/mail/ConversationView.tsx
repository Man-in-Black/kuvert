/**
 * Leseansicht einer Unterhaltung: alle Nachrichten des Threads chronologisch
 * untereinander – aus der Liste und ordnerübergreifend nachgeladen (eigene
 * Antworten aus „Gesendet“, Archiviertes, Gelöschtes). Ungelesene und die
 * neueste Nachricht sind aufgeklappt, ältere und gelöschte zugeklappt.
 *
 * Aktionen der Kopfleiste betreffen nur die Nachrichten des aktuellen Ordners.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, ArrowLeft, ExternalLink, Flag, FolderInput, Mail, MailOpen, Paperclip, ShieldAlert, Trash2 } from 'lucide-react';
import type { AccountInfo, FolderRole, MailFolder, MessageSummary } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { cn, displayAddress, formatListDate } from '@/lib/utils';
import { useExtensions } from '@/modules/context';
import { Avatar, Badge, IconButton, Spinner } from '@/components/ui';
import { moveMessages, refKey, toRef } from './api';
import { useFolders, useOwnAddresses } from './hooks';
import { useMailActions } from './actions';
import { MessageView } from './MessageView';
import { SmimeIcon } from './SmimeIcon';
import { MoveDialog } from './components/MoveDialog';
import { FolderBadge } from './components/FolderBadge';
import { TriageBadge, TriagePendingBadge, conversationTriage } from './components/TriageBadge';
import { useTriagePending } from './triage-pending';
import {
  conversationRefs,
  stripSubjectPrefix,
  toggleConversationFlag,
  toggleConversationSeen,
  useConversationThread,
  type Conversation,
} from './threads';

export function ConversationView({
  conv,
  account,
  folderRole,
  onBack,
  onAfterRemove,
  focusKey,
  onOpenWindow,
  onOpenMessageWindow,
}: {
  conv: Conversation;
  account?: AccountInfo;
  folderRole?: FolderRole;
  onBack?: () => void;
  onAfterRemove?: () => void;
  /** In der Liste angeklickte Einzelnachricht: aufklappen und dorthin scrollen */
  focusKey?: string;
  /** Ganze Unterhaltung in einem eigenen Fenster öffnen */
  onOpenWindow?: () => void;
  /** Einzelne Nachricht der Unterhaltung in einem eigenen Fenster öffnen */
  onOpenMessageWindow?: (m: MessageSummary) => void;
}) {
  const qc = useQueryClient();
  const actions = useMailActions();
  const conversationActions = useExtensions('conversationActions');
  const triagePending = useTriagePending();
  const own = useOwnAddresses();
  const [moveOpen, setMoveOpen] = useState(false);
  const accountId = conv.latest.accountId;

  // ── Ordnerübergreifend nachladen (Gesendet, Archiv, Papierkorb …) ──
  const { thread, messages } = useConversationThread(conv);

  const { data: folderData } = useFolders(accountId);
  const folderById = useMemo(() => new Map((folderData?.folders ?? []).map((f) => [f.id, f])), [folderData]);
  const listKeys = useMemo(() => new Set(conv.messages.map((m) => refKey(toRef(m)))), [conv.messages]);
  /** Nachricht aus einem anderen Ordner als die Liste (nicht über die Kopfleiste bearbeitet) */
  const foreignFolder = (m: MessageSummary): MailFolder | undefined | null =>
    listKeys.has(refKey(toRef(m))) ? null : folderById.get(m.folderId);
  const isDeleted = (m: MessageSummary) => foreignFolder(m)?.role === 'trash';
  const foreignCount = messages.filter((m) => !listKeys.has(refKey(toRef(m)))).length;

  const chronological = [...messages].reverse();
  const latest = messages.find((m) => !isDeleted(m)) ?? messages[0]!;
  const latestKey = refKey(toRef(latest));

  // Aufgeklappt: ungelesene + neueste (+ in der Liste angeklickte). Später eintreffende
  // neueste Nachrichten kommen dazu.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([latestKey, ...conv.messages.filter((m) => !m.seen).map((m) => refKey(toRef(m))), ...(focusKey ? [focusKey] : [])]),
  );
  useEffect(() => {
    setExpanded((prev) => (prev.has(latestKey) ? prev : new Set(prev).add(latestKey)));
  }, [latestKey]);
  useEffect(() => {
    if (focusKey) setExpanded((prev) => (prev.has(focusKey) ? prev : new Set(prev).add(focusKey)));
  }, [focusKey]);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Beim Öffnen – und noch einmal, wenn der Thread nachgeladen ist (ältere Karten
  // kommen oben dazu) – zur angeklickten bzw. ersten aufgeklappten Nachricht scrollen
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadLoaded = thread.isFetched;
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: 'start' });
  }, [threadLoaded, focusKey]);
  const chronoKeys = chronological.map((m) => refKey(toRef(m)));
  const scrollKey = focusKey && chronoKeys.includes(focusKey) ? focusKey : chronoKeys.find((k) => expanded.has(k));

  const refs = conversationRefs(conv);
  const isJunk = folderRole === 'junk';
  const isTrash = folderRole === 'trash';
  const after = () => onAfterRemove?.();
  const run = (p: Promise<unknown>) => p.catch((err) => toast.error(errorMessage(err)));
  const subject = messages[messages.length - 1]!.subject;
  // KI-Triage der Unterhaltung: höchste offene Priorität – eine eigene Antwort
  // (auch aus „Gesendet“ nachgeladen) gilt als erledigt
  const triage = conversationTriage(messages, own);

  // Nur eine Nachricht (auch nach dem Nachladen): normale Leseansicht
  if (messages.length <= 1) {
    return (
      <MessageView
        key={refKey(toRef(conv.latest))}
        msgRef={toRef(conv.latest)}
        account={account}
        folderRole={folderRole}
        onBack={onBack}
        onAfterRemove={onAfterRemove}
        onOpenWindow={onOpenWindow}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Aktionsleiste für die ganze Unterhaltung (nur Nachrichten dieses Ordners) */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5">
        {onBack && (
          <IconButton label="Zurück" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton
          label="Unterhaltung archivieren (E)"
          size="icon-sm"
          onClick={() => {
            void actions.archive(refs);
            after();
          }}
        >
          <Archive className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={isTrash ? 'Unterhaltung endgültig löschen' : 'Unterhaltung löschen (Entf)'}
          size="icon-sm"
          onClick={() => {
            void actions.remove(refs, isTrash);
            after();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="Unterhaltung verschieben" size="icon-sm" onClick={() => setMoveOpen(true)}>
          <FolderInput className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={isJunk ? 'Kein Spam' : 'Spam'}
          size="icon-sm"
          onClick={() => {
            void (isJunk ? actions.notSpam(refs) : actions.spam(refs));
            after();
          }}
        >
          <ShieldAlert className="h-4 w-4" />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton
          label={conv.flagged ? 'Markierung entfernen (S)' : 'Markieren (S)'}
          size="icon-sm"
          onClick={() => void run(toggleConversationFlag(qc, [conv]))}
        >
          <Flag className={cn('h-4 w-4', conv.flagged && 'fill-danger text-danger')} />
        </IconButton>
        <IconButton
          label={conv.unread ? 'Als gelesen markieren (U)' : 'Als ungelesen markieren (U)'}
          size="icon-sm"
          onClick={() => void run(toggleConversationSeen(qc, [conv]))}
        >
          {conv.unread ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
        </IconButton>
        {conversationActions.map((C, i) => (
          <Fragment key={i}>
            <C messages={messages} />
          </Fragment>
        ))}
        {onOpenWindow && (
          <>
            <span className="flex-1" />
            <IconButton label="Unterhaltung in neuem Fenster öffnen" size="icon-sm" onClick={onOpenWindow}>
              <ExternalLink className="h-4 w-4" />
            </IconButton>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-3 px-1">
          <h1 className="text-xl font-semibold leading-snug">{stripSubjectPrefix(subject) || '(ohne Betreff)'}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {account && <Badge color={account.color}>{account.name}</Badge>}
            <Badge>{messages.length} Nachrichten</Badge>
            {foreignCount > 0 && <span className="text-xs text-muted">davon {foreignCount} aus anderen Ordnern</span>}
            {thread.isFetching && !thread.isFetched && <Spinner className="h-3.5 w-3.5" />}
            {triagePending.anyPending(messages) ? (
              <TriagePendingBadge className="py-0.5" label="Wird eingeordnet …" />
            ) : (
              triage && <TriageBadge triage={triage} className="py-0.5" />
            )}
          </div>
        </div>

        <div className="space-y-2">
          {chronological.map((m) => {
            const key = refKey(toRef(m));
            const open = expanded.has(key);
            const folder = foreignFolder(m);
            const deleted = folder?.role === 'trash';
            const badge = folder === null ? null : <FolderBadge folder={folder} />;
            return (
              <div key={key} ref={key === scrollKey ? scrollRef : undefined} className="scroll-mt-2">
                {open ? (
                  <div className={cn(deleted && 'opacity-70', key === focusKey && 'rounded-lg ring-2 ring-primary/40')}>
                    {badge && <div className="mb-1 flex justify-end">{badge}</div>}
                    <MessageView
                      msgRef={toRef(m)}
                      account={account}
                      folderRole={folder === null ? folderRole : (folder?.role ?? folderRole)}
                      embedded
                      showReplyButtons={key === latestKey}
                      onCollapse={() => toggle(key)}
                      onOpenWindow={onOpenMessageWindow ? () => onOpenMessageWindow(m) : undefined}
                    />
                  </div>
                ) : (
                  <CollapsedMessage m={m} badge={badge} dimmed={deleted} triageWorking={triagePending.isPending(m)} onClick={() => toggle(key)} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <MoveDialog
        open={moveOpen}
        accountId={conv.latest.accountId}
        excludeFolderId={conv.messages.every((m) => m.folderId === conv.latest.folderId) ? conv.latest.folderId : undefined}
        onClose={() => setMoveOpen(false)}
        onPick={(folderId) => {
          void run(moveMessages(qc, refs, folderId));
          after();
        }}
      />
    </div>
  );
}

function CollapsedMessage({
  m,
  badge,
  dimmed,
  triageWorking,
  onClick,
}: {
  m: MessageSummary;
  badge?: ReactNode;
  dimmed?: boolean;
  triageWorking?: boolean;
  onClick: () => void;
}) {
  const unread = !m.seen && !dimmed;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left hover:bg-hover',
        dimmed && 'opacity-60',
      )}
    >
      <Avatar name={m.from?.name} email={m.from?.address} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'text-fg/85')}>{displayAddress(m.from) || '(unbekannt)'}</span>
          {badge}
          {triageWorking ? <TriagePendingBadge /> : m.triage && <TriageBadge triage={m.triage} />}
          <SmimeIcon kind={m.smime} />
          {m.hasAttachments && m.smime !== 'encrypted' && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" />}
          {m.flagged && <Flag className="h-3.5 w-3.5 shrink-0 fill-current text-danger" />}
          <span className={cn('shrink-0 text-xs', unread ? 'font-semibold text-primary' : 'text-muted')}>{formatListDate(m.date)}</span>
        </div>
        <div className="truncate text-xs text-muted">{m.preview || m.subject}</div>
      </div>
    </button>
  );
}
