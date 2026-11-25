/**
 * Eigenes Browserfenster zum Lesen einer Nachricht oder Unterhaltung
 * (/window/mail?m=<ref>[&c=<id>][&role=<ordnerrolle>]), geöffnet per Doppelklick
 * in der Liste oder über „In neuem Fenster öffnen“.
 *
 * Verschieben, Archivieren und Löschen schließen das Fenster, sobald der Server
 * die Aktion bestätigt hat. Antworten öffnet den Editor in diesem Fenster (bzw.
 * je nach Einstellung in einem weiteren Fenster).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { AccountInfo, FolderRole, MessageDetail, MessageSummary } from '@kuvert/shared';
import { errorMessage, whenWritesIdle } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { fetchMessage, fetchThread, mailKeys, toRef, type ListPage, type MessageRef } from './api';
import { decodeMessageRef } from './links';
import { useFolders } from './hooks';
import { useMailActions } from './actions';
import { MessageView } from './MessageView';
import { ConversationView } from './ConversationView';
import { conversationOf, mergeThread, single, threadQueryOf, type Conversation } from './threads';
import { ComposerHost } from './compose/ComposerHost';
import { getComposers } from './compose/store';
import { openMessageWindow, rememberMessageWindowGeometry, takeConversationHandover } from './message-window';

type WindowList = InfiniteData<ListPage, string | undefined>;

export function MessageWindowPage() {
  const [params] = useSearchParams();
  const raw = params.get('m');
  const msgRef = useMemo(() => decodeMessageRef(raw), [raw]);
  const convId = params.get('c');
  const accountMap = useAccountMap();
  const { data: folderData } = useFolders(msgRef?.accountId);
  const folderRole: FolderRole | undefined =
    folderData?.folders.find((f) => f.id === msgRef?.folderId)?.role ?? ((params.get('role') as FolderRole | null) || undefined);
  const account = msgRef ? accountMap.get(msgRef.accountId) : undefined;

  // ── Schließen erst, wenn Verschieben/Löschen beim Server angekommen ist ──
  // Ein offener Editor (Antwort im selben Fenster) hält das Fenster offen.
  const [closing, setClosing] = useState<'no' | 'waiting' | 'done'>('no');
  const closingRef = useRef(false);
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing('waiting');
    void whenWritesIdle().then(() => {
      setClosing('done');
      if (!getComposers().length) window.close();
    });
  }, []);

  // Größe und Position für das nächste Fenster merken
  useEffect(() => {
    let t: number | undefined;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(rememberMessageWindowGeometry, 300);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', rememberMessageWindowGeometry);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', rememberMessageWindowGeometry);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {!msgRef ? (
        <Notice icon={<AlertTriangle />} title="Nachricht nicht gefunden">
          Der Link zu dieser Nachricht ist unvollständig.
        </Notice>
      ) : closing !== 'no' ? (
        <Notice icon={closing === 'waiting' ? <Spinner className="h-6 w-6" /> : <CheckCircle2 />} title={closing === 'waiting' ? 'Wird ausgeführt …' : 'Erledigt'}>
          {closing === 'waiting' ? 'Dieses Fenster schließt sich automatisch.' : 'Dieses Fenster kann geschlossen werden.'}
        </Notice>
      ) : convId ? (
        <ConversationWindow key={convId} msgRef={msgRef} convId={convId} account={account} folderRole={folderRole} onClose={close} />
      ) : (
        <SingleWindow key={raw} msgRef={msgRef} account={account} folderRole={folderRole} onClose={close} />
      )}
      <ComposerHost />
    </div>
  );
}

/* ───────────── Einzelne Nachricht ───────────── */

function SingleWindow({ msgRef, account, folderRole, onClose }: { msgRef: MessageRef; account?: AccountInfo; folderRole?: FolderRole; onClose: () => void }) {
  const { data: msg } = useQuery({
    queryKey: mailKeys.message(msgRef.accountId, msgRef.folderId, msgRef.id),
    queryFn: () => fetchMessage(msgRef),
    staleTime: 5 * 60_000,
  });
  useWindowTitle(msg?.subject);
  useWindowShortcuts({ replyRef: msgRef, targets: [msgRef], folderRole, onRemoved: onClose });
  return (
    <div className="min-h-0 flex-1">
      <MessageView msgRef={msgRef} account={account} folderRole={folderRole} onAfterRemove={onClose} />
    </div>
  );
}

/* ───────────── Unterhaltung ───────────── */

function ConversationWindow({
  msgRef,
  convId,
  account,
  folderRole,
  onClose,
}: {
  msgRef: MessageRef;
  convId: string;
  account?: AccountInfo;
  folderRole?: FolderRole;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [handover] = useState(() => takeConversationHandover(convId));
  // Die Nachrichten der Listenzeile liegen wie eine Liste im Cache – so wirken
  // Markieren, Verschieben usw. (patchMessages/removeMessages) auch hier.
  const key = useMemo(() => [...mailKeys.lists, { kind: 'window', id: convId }] as const, [convId]);
  const list = useQuery({
    queryKey: key,
    queryFn: async (): Promise<WindowList> => {
      const cur = qc.getQueryData<WindowList>(key);
      if (cur) return cur;
      return { pages: [{ items: handover ?? (await loadConversation(msgRef)) }], pageParams: [undefined] };
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const conv: Conversation | null = useMemo(() => {
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    return items.length ? conversationOf(items) : null;
  }, [list.data]);

  // Alle Nachrichten dieses Ordners verschoben/gelöscht → Fenster schließen
  useEffect(() => {
    if (list.isSuccess && !conv) onClose();
  }, [list.isSuccess, conv, onClose]);

  useWindowTitle(conv?.latest.subject);
  const targets = useMemo(() => (conv ? conv.messages.map(toRef) : []), [conv]);
  useWindowShortcuts({ replyRef: conv ? toRef(conv.latest) : undefined, targets, folderRole, onRemoved: onClose });

  if (list.isLoading)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  if (list.error)
    return (
      <EmptyState icon={<AlertTriangle />} title="Nachricht konnte nicht geladen werden">
        {errorMessage(list.error)}
      </EmptyState>
    );
  if (!conv) return null;

  return (
    <div className="min-h-0 flex-1">
      <ConversationView
        conv={conv}
        account={account}
        folderRole={folderRole}
        onAfterRemove={onClose}
        onOpenMessageWindow={(m) => {
          if (!openMessageWindow(toRef(m))) toast.warning('Fenster wurde vom Browser blockiert', { description: 'Bitte Popups für Kuvert erlauben.' });
        }}
      />
    </div>
  );
}

/**
 * Ohne Übergabe aus dem Hauptfenster (z. B. Link direkt geöffnet): Nachricht laden
 * und die übrigen Nachrichten der Unterhaltung aus demselben Ordner dazunehmen.
 */
async function loadConversation(ref: MessageRef): Promise<MessageSummary[]> {
  const detail = await fetchMessage(ref);
  try {
    const q = threadQueryOf(single(detail));
    if (!q.threadId && !q.messageIds?.length) return [detail];
    const res = await fetchThread(ref.accountId, q);
    return mergeThread([detail], res.items.filter((m) => m.folderId === ref.folderId));
  } catch {
    return [detail];
  }
}

/* ───────────── Hilfen ───────────── */

function useWindowTitle(subject: string | undefined) {
  useEffect(() => {
    if (subject !== undefined) document.title = `${subject || '(ohne Betreff)'} – Kuvert`;
  }, [subject]);
}

/** Tastenkürzel wie in der Mail-Ansicht: R/A/F antworten, E archivieren, Entf/# löschen */
function useWindowShortcuts({
  replyRef,
  targets,
  folderRole,
  onRemoved,
}: {
  replyRef?: MessageRef;
  targets: MessageRef[];
  folderRole?: FolderRole;
  onRemoved: () => void;
}) {
  const qc = useQueryClient();
  const actions = useMailActions();
  const state = useRef({ replyRef, targets, folderRole, onRemoved });
  state.current = { replyRef, targets, folderRole, onRemoved };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const st = state.current;
      const r = st.replyRef;
      const detail = r ? qc.getQueryData<MessageDetail>(mailKeys.message(r.accountId, r.folderId, r.id)) : undefined;
      switch (e.key) {
        case 'r':
          if (detail && r) actions.reply(detail, r, 'reply');
          break;
        case 'a':
          if (detail && r) actions.reply(detail, r, 'replyAll');
          break;
        case 'f':
          if (detail && r) actions.reply(detail, r, 'forward');
          break;
        case 'e':
          if (!st.targets.length) return;
          void actions.archive(st.targets);
          st.onRemoved();
          break;
        case '#':
        case 'Delete':
          if (!st.targets.length) return;
          void actions.remove(st.targets, st.folderRole === 'trash');
          st.onRemoved();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, qc]);
}

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary [&_svg]:h-6 [&_svg]:w-6">{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="max-w-sm text-sm text-muted">{children}</p>
      <Button onClick={() => window.close()}>Fenster schließen</Button>
    </div>
  );
}
