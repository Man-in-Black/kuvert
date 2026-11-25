import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowLeft, Bell, BellOff, ExternalLink, Info, Phone, Star, Upload } from 'lucide-react';
import type { ChatCall, ChatConversation, ChatMessage, ChatUser } from '@kuvert/shared';
import { Button, IconButton, Spinner, useConfirm } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  activeChat,
  applyRead,
  capsOf,
  chatApi,
  chatKeys,
  conversationTitle,
  otherMember,
  replaceConversation,
  userName,
  upsertMessage,
  useMe,
  useMessages,
  useTyping,
  useUserMap,
  withSenders,
  type MessagesData,
} from './api';
import { Composer, type ComposerHandle } from './Composer';
import { ConversationAvatar } from './components';
import { ConversationInfo } from './ConversationInfo';
import { dayLabel, sameDay, timeOf } from './format';
import { MessageItem } from './MessageItem';

const GROUP_GAP_MS = 5 * 60_000;

export function ConversationView({ conversation: c, onBack, jumpSeq, onJumpDone }: { conversation: ChatConversation; onBack?: () => void; jumpSeq?: number | null; onJumpDone?: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const baseUsers = useUserMap();
  const q = useMessages(c.id);
  const caps = capsOf(c);
  const { confirm, dialog } = useConfirm();

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);

  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const atBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const initialized = useRef(false);
  const lastMarked = useRef(0);

  const myMember = c.members.find((m) => m.userId === me);
  // Lesestand beim Öffnen → Trenner "Neue Nachrichten" bleibt stehen, bis man die Unterhaltung verlässt
  const initialRead = useRef<number | null>(null);
  if (initialRead.current === null && myMember) initialRead.current = myMember.lastReadSeq;

  const messages = useMemo(() => (q.data ? q.data.pages.slice().reverse().flatMap((p) => p.items) : []), [q.data]);
  // Verbundene Dienste: Absender, die nicht in der Teilnehmerliste stehen, über ihren Namen aus der Nachricht ergänzen
  const users = useMemo(() => (c.source ? withSenders(baseUsers, messages) : baseUsers), [c.source, baseUsers, messages]);
  const oldestSeq = messages[0]?.seq ?? 0;
  const newest = messages[messages.length - 1];

  // Einmal beim ersten Laden bestimmen – später eintreffende Nachrichten verschieben den Trenner nicht
  const divider = useRef<string | null | undefined>(undefined);
  if (divider.current === undefined && q.data && me) {
    const from = initialRead.current ?? 0;
    divider.current = messages.find((m) => m.seq > from && m.kind === 'text' && m.senderId !== me)?.id ?? null;
  }
  const dividerId = divider.current ?? null;

  /* ───────────── Aktive Unterhaltung (für Benachrichtigungen) ───────────── */
  useEffect(() => {
    activeChat.id = c.id;
    return () => {
      if (activeChat.id === c.id) activeChat.id = null;
    };
  }, [c.id]);

  /* ───────────── Scrollen ───────────── */
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
    setNewBelow(0);
    setShowJump(false);
  }, []);

  const fetchRef = useRef(q.fetchNextPage);
  fetchRef.current = q.fetchNextPage;
  const loadOlder = useCallback(async () => {
    const el = scroller.current;
    if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
    return fetchRef.current();
  }, []);

  // Ältere Nachrichten oben eingefügt → Position halten
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !restore.current) return;
    el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
    restore.current = null;
  }, [oldestSeq]);

  // Neueste Nachricht beim letzten Rendern (erkennt neu eingetroffene Nachrichten)
  const newestSeq = newest?.seq ?? 0;
  const prevNewest = useRef(newestSeq);

  // Erstes Laden: zum ersten ungelesenen Beitrag bzw. ans Ende
  useLayoutEffect(() => {
    if (initialized.current || !q.data) return;
    initialized.current = true;
    prevNewest.current = newestSeq;
    const divider = dividerId ? document.getElementById(`msg-${dividerId}`) : null;
    if (divider && scroller.current) {
      divider.scrollIntoView({ block: 'center' });
      const el = scroller.current;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    } else scrollToBottom();
  }, [q.data, dividerId, newestSeq, scrollToBottom]);

  // Inhalt geändert (Reaktion, Bearbeitung, Antwortleiste …) → unten bleiben, wenn man dort war
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && initialized.current && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [q.data]);

  // Verlauf wird kleiner (Eingabefeld wächst, Antwortleiste, Fenstergröße) → ebenfalls unten bleiben
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (initialized.current && atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Neue Nachricht unten angekommen
  useLayoutEffect(() => {
    if (!initialized.current || newestSeq <= prevNewest.current) return;
    prevNewest.current = newestSeq;
    if (atBottom.current || newest?.senderId === me) scrollToBottom();
    else if (newest?.kind === 'text') setNewBelow((n) => n + 1);
  }, [newestSeq, newest?.senderId, newest?.kind, me, scrollToBottom]);

  /* ───────────── Gelesen markieren ───────────── */
  const markRead = useCallback(() => {
    if (!newestSeq || document.hidden || !atBottom.current) return;
    if (newestSeq <= (myMember?.lastReadSeq ?? 0) || newestSeq <= lastMarked.current) return;
    lastMarked.current = newestSeq;
    if (me) applyRead(qc, c.id, me, newestSeq, me);
    chatApi.read(c.id, newestSeq).catch(() => {
      lastMarked.current = 0;
    });
  }, [newestSeq, myMember?.lastReadSeq, me, qc, c.id]);

  useEffect(() => {
    const t = setTimeout(markRead, 400);
    const onVis = () => !document.hidden && markRead();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [markRead]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = dist < 80;
    setShowJump(dist > 400);
    if (atBottom.current) {
      setNewBelow(0);
      markRead();
    }
    if (el.scrollTop < 300 && q.hasNextPage && !q.isFetchingNextPage) void loadOlder();
  };

  /* ───────────── Zu Nachricht springen (Antwortzitat, Suche) ───────────── */
  const jump = useCallback(
    async (match: (m: ChatMessage) => boolean) => {
      for (let i = 0; i < 40; i++) {
        const data = qc.getQueryData<MessagesData>(chatKeys.messages(c.id));
        const found = data?.pages.flatMap((p) => p.items).find(match);
        if (found) {
          // Gescrollt wird erst, wenn React die (evtl. gerade nachgeladene) Nachricht gerendert hat
          setHighlight(found.id);
          setJumpTarget(found.id);
          setTimeout(() => setHighlight((h) => (h === found.id ? null : h)), 2500);
          return;
        }
        const last = data?.pages[data.pages.length - 1];
        if (data && !last?.hasMore) break;
        await loadOlder();
      }
      toast.info('Nachricht nicht mehr vorhanden');
    },
    [qc, c.id, loadOlder],
  );

  useLayoutEffect(() => {
    if (!jumpTarget) return;
    const el = document.getElementById(`msg-${jumpTarget}`);
    if (!el) return; // noch nicht gerendert → nächster Durchlauf (messages ändert sich)
    atBottom.current = false;
    el.scrollIntoView({ block: 'center' });
    setJumpTarget(null);
  }, [jumpTarget, messages]);

  useEffect(() => {
    if (!jumpSeq || !q.data) return;
    void jump((m) => m.seq === jumpSeq).finally(() => onJumpDone?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq, !!q.data]);

  /* ───────────── Aktionen ───────────── */
  const onReply = useCallback((m: ChatMessage) => {
    setEditing(null);
    setReplyTo(m);
  }, []);
  const onEdit = useCallback((m: ChatMessage) => {
    setReplyTo(null);
    setEditing(m);
  }, []);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const onDelete = useCallback(
    async (m: ChatMessage) => {
      if (!(await confirmRef.current('Diese Nachricht für alle löschen?', { danger: true }))) return;
      try {
        upsertMessage(qc, await chatApi.remove(m.id));
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [qc],
  );
  const onReact = useCallback(
    (m: ChatMessage, emoji: string) => {
      chatApi
        .react(m.id, emoji)
        .then((msg) => upsertMessage(qc, msg))
        .catch((err) => toast.error(errorMessage(err)));
    },
    [qc],
  );
  const onJump = useCallback((id: string) => void jump((m) => m.id === id), [jump]);
  const onMediaLoad = useCallback(() => {
    if (atBottom.current) scrollToBottom();
  }, [scrollToBottom]);

  const editLast = () => {
    if (!caps.edit) return;
    const mine = [...messages].reverse().find((m) => m.senderId === me && m.kind === 'text' && !m.deleted);
    if (mine) onEdit(mine);
  };

  const setPrefs = async (prefs: { muted?: boolean; pinned?: boolean }) => {
    try {
      replaceConversation(qc, await chatApi.prefs(c.id, prefs));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  /* ───────────── Anzeige ───────────── */
  const title = conversationTitle(c, me, users);
  const other = c.kind === 'direct' ? users.get(otherMember(c, me) ?? '') : undefined;
  const typingIds = useTyping(c.id).filter((id) => id !== me);
  const typingText = useMemo(() => {
    const names = typingIds.map((id) => users.get(id)?.name.split(' ')[0] ?? 'Jemand');
    if (!names.length) return null;
    if (c.kind === 'direct') return 'schreibt …';
    if (names.length === 1) return `${names[0]} schreibt …`;
    if (names.length === 2) return `${names[0]} und ${names[1]} schreiben …`;
    return 'Mehrere Personen schreiben …';
  }, [typingIds, users, c.kind]);

  const onlineCount = c.members.filter((m) => users.get(m.userId)?.online).length;
  const memberCount = c.memberCount ?? c.members.length;
  const subtitle = c.source
    ? c.kind === 'direct'
      ? [other?.online ? 'Online' : null, c.source.label].filter(Boolean).join(' · ')
      : [c.memberCount ? `${memberCount} ${memberCount === 1 ? 'Mitglied' : 'Mitglieder'}` : null, c.source.context, c.source.label].filter(Boolean).join(' · ')
    : c.kind === 'direct'
      ? other?.disabled
        ? 'Gesperrt'
        : other?.online
          ? 'Online'
          : [other?.jobTitle, other?.department].filter(Boolean).join(' · ') || other?.email || ''
      : `${c.members.length} ${c.members.length === 1 ? 'Mitglied' : 'Mitglieder'}${onlineCount ? ` · ${onlineCount} online` : ''}`;

  // Lesestatus unter der letzten eigenen Nachricht
  const lastMine = useMemo(() => [...messages].reverse().find((m) => m.senderId === me && m.kind === 'text' && !m.deleted), [messages, me]);
  const readState = useMemo(() => {
    if (!lastMine || !caps.readReceipts) return null;
    const others = c.members.filter((m) => m.userId !== me);
    if (!others.length) return null;
    const readers = others.filter((m) => m.lastReadSeq >= lastMine.seq);
    if (c.kind === 'direct') return { read: readers.length > 0, label: readers.length ? 'Gelesen' : 'Zugestellt' };
    if (readers.length === others.length) return { read: true, label: 'Von allen gelesen' };
    return { read: false, label: readers.length ? `Gelesen von ${readers.length} von ${others.length}` : 'Zugestellt' };
  }, [lastMine, c.members, c.kind, me, caps.readReceipts]);

  const canModerate = c.kind === 'group' && c.myRole === 'owner';
  // Anrufe laufen im Dienst selbst: Beitreten/Starten öffnet die Unterhaltung dort
  const callUrl = c.call?.joinUrl ?? c.source?.webUrl ?? null;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-bg"
      onDragOver={(e) => {
        if (!caps.files || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles([...e.dataTransfer.files]);
      }}
    >
      {/* Kopfzeile */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-2 sm:px-4">
        {onBack && (
          <IconButton label="Zurück" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
        )}
        <button type="button" onClick={() => setInfoOpen(true)} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 py-1 text-left hover:bg-hover">
          <ConversationAvatar conversation={c} users={users} me={me} size={36} />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-5">{title}</span>
            <span className={cn('block truncate text-xs', typingText ? 'text-primary' : 'text-muted')}>{typingText ?? subtitle}</span>
          </span>
        </button>
        {caps.calls && callUrl && (
          <IconButton
            label={c.call ? 'Anruf beitreten' : `Anruf in ${c.source?.label ?? 'Mattermost'} starten`}
            onClick={() => window.open(callUrl, '_blank', 'noopener,noreferrer')}
            className={cn(c.call && 'text-success hover:text-success')}
          >
            <Phone className="h-[18px] w-[18px]" />
          </IconButton>
        )}
        <IconButton
          label={c.pinned ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
          onClick={() => void setPrefs({ pinned: !c.pinned })}
          className={cn(c.pinned && 'text-warning hover:text-warning')}
        >
          <Star className={cn('h-[18px] w-[18px]', c.pinned && 'fill-current')} />
        </IconButton>
        <IconButton label={c.muted ? 'Benachrichtigungen einschalten' : 'Stummschalten'} onClick={() => void setPrefs({ muted: !c.muted })} className={cn(c.muted && 'text-warning')}>
          {c.muted ? <BellOff className="h-[18px] w-[18px]" /> : <Bell className="h-[18px] w-[18px]" />}
        </IconButton>
        {c.source?.webUrl && (
          <IconButton label={`In ${c.source.label} öffnen`} onClick={() => window.open(c.source!.webUrl!, '_blank', 'noopener,noreferrer')}>
            <ExternalLink className="h-[18px] w-[18px]" />
          </IconButton>
        )}
        <IconButton label="Details" onClick={() => setInfoOpen(true)}>
          <Info className="h-[18px] w-[18px]" />
        </IconButton>
      </header>

      {c.call && <CallBanner call={c.call} users={users} me={me} joinUrl={callUrl} service={c.source?.label ?? 'Mattermost'} />}

      {/* Verlauf */}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain pb-4 pt-2">
          {q.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : q.error ? (
            <div className="p-6 text-center text-sm text-danger">{errorMessage(q.error)}</div>
          ) : (
            <>
              {q.hasNextPage ? (
                <div className="flex h-10 items-center justify-center">{q.isFetchingNextPage && <Spinner className="h-4 w-4" />}</div>
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 pb-4 pt-8 text-center">
                  <ConversationAvatar conversation={c} users={users} me={me} size={64} />
                  <div className="text-base font-semibold">{title}</div>
                  <div className="max-w-sm text-sm text-muted">
                    {c.kind === 'direct' ? `Das ist der Anfang deiner Unterhaltung mit ${title}.` : c.description || `Willkommen in der Gruppe „${title}“.`}
                  </div>
                  {c.source && <div className="text-xs text-subtle">Unterhaltung aus {c.source.label}</div>}
                </div>
              )}

              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
                const first =
                  newDay ||
                  !prev ||
                  m.id === dividerId ||
                  prev.kind !== 'text' ||
                  prev.senderId !== m.senderId ||
                  new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > GROUP_GAP_MS;
                return (
                  <Fragment key={m.id}>
                    {newDay && (
                      <div className="sticky top-0 z-[5] flex justify-center py-2">
                        <span className="rounded-full border border-border bg-surface/90 px-3 py-0.5 text-[11px] font-medium text-muted shadow-soft backdrop-blur">{dayLabel(m.createdAt)}</span>
                      </div>
                    )}
                    {m.id === dividerId && (
                      <div className="my-2 flex items-center gap-3 px-5 text-[11px] font-semibold uppercase tracking-wide text-danger">
                        <span className="h-px flex-1 bg-danger/40" />
                        Neue Nachrichten
                        <span className="h-px flex-1 bg-danger/40" />
                      </div>
                    )}
                    <MessageItem
                      message={m}
                      me={me}
                      users={users}
                      isGroup={c.kind === 'group'}
                      first={first}
                      canModerate={canModerate}
                      readState={m.id === lastMine?.id ? readState : null}
                      highlighted={highlight === m.id}
                      caps={caps}
                      onReply={onReply}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onReact={onReact}
                      onJump={onJump}
                      onMediaLoad={onMediaLoad}
                      callJoinUrl={c.call ? callUrl : null}
                    />
                  </Fragment>
                );
              })}
            </>
          )}
        </div>

        {(showJump || newBelow > 0) && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-4 right-4 flex h-10 animate-scale-in items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm font-medium shadow-pop hover:bg-hover"
          >
            <ArrowDown className="h-4 w-4" />
            {newBelow > 0 ? `${newBelow} neu` : 'Ans Ende'}
          </button>
        )}
      </div>

      <Composer
        key={c.id}
        ref={composer}
        conversationId={c.id}
        me={me}
        users={users}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onEditLast={editLast}
        onSent={() => scrollToBottom()}
        caps={caps}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-primary-soft/90 text-primary">
          <Upload className="h-8 w-8" />
          <span className="text-sm font-medium">Dateien zum Senden hier ablegen</span>
        </div>
      )}

      {infoOpen && <ConversationInfo conversation={c} onClose={() => setInfoOpen(false)} />}
      {dialog}
    </div>
  );
}

/** Hinweis auf einen laufenden Anruf mit Teilnehmenden und "Beitreten" */
function CallBanner({ call, users, me, joinUrl, service }: { call: ChatCall; users: Map<string, ChatUser>; me?: string; joinUrl: string | null; service: string }) {
  const names = call.participantIds.map((id) => userName(id, users, me).split(' ')[0]!);
  const who = names.length ? (names.length > 3 ? `${names.slice(0, 3).join(', ')} und ${names.length - 3} weitere` : names.join(', ')) : null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-success/10 px-3 py-2 sm:px-5">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Anruf läuft</span>
        <span className="text-muted"> · seit {timeOf(call.startedAt)}</span>
        {who && <span className="block truncate text-xs text-muted">Dabei: {who}</span>}
      </span>
      {joinUrl && (
        <Button size="sm" variant="primary" icon={<Phone className="h-4 w-4" />} onClick={() => window.open(joinUrl, '_blank', 'noopener,noreferrer')} title={`Öffnet den Anruf in ${service}`}>
          Beitreten
        </Button>
      )}
    </div>
  );
}
