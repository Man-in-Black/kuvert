/**
 * KI-Chat als Seitenpanel rechts (nicht modal – Mail und Liste bleiben bedienbar).
 * Global oder mit einer Mail / einem Verlauf als Kontext; optional durchsucht der
 * Server das Postfach und gibt die gefundenen Mails als Quellen mit.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowUp, Copy, History, Mail, MessagesSquare, Mic, PenSquare, Pencil, RefreshCw, Reply, Search, Sparkles, Square, SquarePen, Trash2, X } from 'lucide-react';
import { isToday, isYesterday, subDays } from 'date-fns';
import type { AiChatContext, AiChatSource, AiChatSummary, AiStatus } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useSettings } from '@/lib/queries';
import { cn, displayAddress, formatListDate } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { Spinner, useConfirm } from '@/components/ui';
import { PinPanelButton, SidePanel } from '@/layout/SidePanel';
import { markdownToHtml } from '@/features/chat/markdown';
import { useMailActions } from '@/features/mail/actions';
import { fetchMessage } from '@/features/mail/api';
import { useMailAccounts } from '@/features/mail/hooks';
import { messageUrl } from '@/features/mail/links';
import { openCompose } from '@/features/mail/compose-api';
import { AiMarkdown, normalizeAiMarkdown } from './AiMarkdown';
import { useAiDefaults } from './AiResultModal';
import {
  closeAiChat,
  deleteAiChat,
  deleteAllAiChats,
  loadAiChat,
  renameAiChat,
  dropAiChatContext,
  resetAiChat,
  sendAiChat,
  setAiChatModel,
  setAiChatSearch,
  stopAiChat,
  useAiChat,
  type AiChatMessage,
  type AiChatSession,
} from './chat-store';

const SUGGESTIONS: Record<'search' | 'global' | 'message' | 'conversation' | 'meeting', string[]> = {
  search: [
    'Welche wichtigen Mails habe ich diese Woche bekommen?',
    'Was ist der letzte Stand zum Thema Angebot?',
    'Gibt es ungelesene Mails mit Fristen?',
    'Welche Rechnungen kamen letzten Monat?',
  ],
  global: [
    'Hilf mir, eine höfliche Absage zu formulieren.',
    'Erkläre mir den Unterschied zwischen CC und BCC.',
    'Übersetze „Vielen Dank für Ihre Geduld“ ins Englische.',
    'Wie schreibe ich eine gute Abwesenheitsnotiz?',
  ],
  message: ['Fasse die Mail kurz zusammen.', 'Was wird von mir erwartet?', 'Gibt es Fristen oder Termine?', 'Entwirf eine freundliche Antwort.'],
  conversation: ['Fasse den Verlauf zusammen.', 'Welche Punkte sind noch offen?', 'Wer hat was zugesagt?', 'Entwirf eine Antwort auf die letzte Nachricht.'],
  meeting: ['Was wurde vereinbart?', 'Welche Aufgaben habe ich übernommen?', 'Entwirf eine Folge-Mail an die Teilnehmer.', 'Was ist noch offen?'],
};

const CONTEXT_ICON = { message: Mail, conversation: MessagesSquare, meeting: Mic } as const;
const CONTEXT_LABEL = { message: 'E-Mail', conversation: 'Unterhaltung', meeting: 'Gespräch' } as const;

export function AiChatService() {
  const { open } = useAiChat();
  if (!open) return null;
  return <AiChatPanel />;
}

function AiChatPanel() {
  const { session, model, loading } = useAiChat();
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const defaults = useAiDefaults();
  const mobile = useIsMobile();
  const hasMail = useMailAccounts().length > 0;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busy = session.messages.some((m) => m.streaming);
  const kind = session.target?.context.kind ?? 'global';
  const searching = hasMail && session.searchMailbox;

  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api<AiStatus>('/ai/status'), staleTime: 60_000 });
  const models = status.data?.models ?? [];
  const defaultModel = defaults.model || status.data?.model;
  const sendOpts = { model: defaults.model, search: searching };

  useEffect(() => {
    setView('chat');
    inputRef.current?.focus();
  }, [session.id]);

  // Mitscrollen, solange der Benutzer unten ist
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session]);

  // Eingabe wächst mit (bis ~8 Zeilen)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const send = (text?: string) => {
    const value = text ?? input;
    if (!value.trim() || busy) return;
    stick.current = true;
    setInput('');
    void sendAiChat(value, sendOpts);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <SidePanel id="ai-chat" label="KI-Chat" defaultWidth={440} onClose={closeAiChat} canClose={!busy}>
      {/* Kopf */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">KI-Chat</div>
          {models.length > 1 ? (
            <select
              value={model ?? ''}
              onChange={(e) => setAiChatModel(e.target.value || null)}
              className="-ml-0.5 max-w-full cursor-pointer truncate bg-transparent text-xs text-muted outline-none hover:text-fg"
              title="Sprachmodell für diesen Chat"
            >
              <option value="">Standard{defaultModel ? ` (${defaultModel})` : ''}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <div className="truncate text-xs text-muted">{defaultModel ?? 'Lokales Sprachmodell'}</div>
          )}
        </div>
        <HeaderButton label={view === 'history' ? 'Zurück zum Chat' : 'Gespeicherte Chats'} onClick={() => setView((v) => (v === 'history' ? 'chat' : 'history'))} active={view === 'history'}>
          <History className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton
          label="Neuer Chat"
          onClick={() => {
            resetAiChat(true);
            setView('chat');
          }}
          disabled={!session.messages.length && view === 'chat'}
        >
          <SquarePen className="h-4 w-4" />
        </HeaderButton>
        <PinPanelButton id="ai-chat" />
        <HeaderButton label="Schließen" onClick={closeAiChat}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </header>

      {view === 'history' ? (
        <ChatHistory currentId={session.id} onBack={() => setView('chat')} />
      ) : (
        <>
      {/* Kontext / Postfach-Suche */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {session.target ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-primary-soft py-1 pl-2.5 pr-1 text-xs text-primary">
            <ContextIcon kind={session.target.context.kind} />
            <span className="truncate" title={session.target.context.title}>
              {CONTEXT_LABEL[session.target.context.kind]}: {session.target.context.title || '(ohne Betreff)'}
            </span>
            <button
              type="button"
              onClick={dropAiChatContext}
              className="rounded-full p-0.5 hover:bg-primary/15"
              title="Kontext entfernen (allgemeiner Chat)"
              aria-label="Kontext entfernen"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <span className="text-xs text-muted">Allgemeiner Chat</span>
        )}
        {hasMail && (
          <button
            type="button"
            onClick={() => setAiChatSearch(!session.searchMailbox)}
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
              session.searchMailbox ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border text-muted hover:text-fg',
            )}
            title="Für jede Frage passende Mails im Postfach suchen und als Quellen mitgeben"
            aria-pressed={session.searchMailbox}
          >
            <Search className="h-3.5 w-3.5" />
            Postfach durchsuchen
          </button>
        )}
      </div>

      {/* Verlauf */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {status.data && (!status.data.enabled || !status.data.reachable) && (
          <div className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">KI-Server nicht erreichbar{status.data.error ? `: ${status.data.error}` : ''}</div>
        )}
        {loading && !session.messages.length ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> Chat wird geladen …
          </div>
        ) : session.messages.length === 0 ? (
          <EmptyChat kind={kind} searching={searching} onPick={(s) => send(s)} />
        ) : (
          <div className="space-y-4">
            {session.messages.map((m, i) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} message={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  session={session}
                  last={i === session.messages.length - 1}
                  onRegenerate={() => void sendAiChat(undefined, sendOpts)}
                  onNavigate={mobile ? closeAiChat : undefined}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* Eingabe */}
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-primary/50 focus-within:shadow-glow">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={kind === 'global' ? (searching ? 'Frag etwas zu deinem Postfach …' : 'Frag die KI …') : kind === 'message' ? 'Frag etwas zu dieser Mail …' : kind === 'meeting' ? 'Frag etwas zu diesem Gespräch …' : 'Frag etwas zu dieser Unterhaltung …'}
            className="max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-subtle"
          />
          {busy ? (
            <button
              type="button"
              onClick={stopAiChat}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fg text-surface transition-opacity hover:opacity-80"
              title="Antwort abbrechen"
              aria-label="Antwort abbrechen"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send()}
              disabled={!input.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-40"
              title="Senden (Enter)"
              aria-label="Senden"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-subtle">Enter senden · Umschalt+Enter neue Zeile · Antworten können Fehler enthalten</p>
      </div>
        </>
      )}
    </SidePanel>
  );
}

function HeaderButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'rounded-md p-1.5 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-primary-soft text-primary' : 'text-muted',
      )}
    >
      {children}
    </button>
  );
}

function ContextIcon({ kind }: { kind: AiChatContext['kind'] }) {
  const Icon = CONTEXT_ICON[kind];
  return <Icon className="h-3.5 w-3.5 shrink-0" />;
}

function EmptyChat({ kind, searching, onPick }: { kind: 'global' | AiChatContext['kind']; searching: boolean; onPick: (s: string) => void }) {
  const list = SUGGESTIONS[kind === 'global' && searching ? 'search' : kind];
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h3 className="text-sm font-semibold">Was möchtest du wissen?</h3>
      <p className="mt-1 max-w-xs text-xs text-muted">
        {kind === 'global'
          ? searching
            ? 'Die KI sucht für jede Frage passende Mails in deinem Postfach und antwortet mit Quellen.'
            : 'Frag die KI alles Mögliche – alles läuft über dein lokales Sprachmodell.'
          : kind === 'message'
            ? 'Die geöffnete Mail ist der Kontext für deine Fragen.'
            : kind === 'meeting'
              ? 'Zusammenfassung, Aufgaben und Transkript des Gesprächs sind der Kontext für deine Fragen.'
              : 'Der ganze Verlauf ist der Kontext für deine Fragen.'}
      </p>
      <div className="mt-4 flex w-full flex-col gap-1.5">
        {list.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="rounded-lg border border-border px-3 py-2 text-left text-sm text-fg/90 transition-colors hover:border-primary/40 hover:bg-hover">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: AiChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-fg">{message.content}</div>
    </div>
  );
}

function AssistantMessage({
  message,
  session,
  last,
  onRegenerate,
  onNavigate,
}: {
  message: AiChatMessage;
  session: AiChatSession;
  last: boolean;
  onRegenerate: () => void;
  onNavigate?: () => void;
}) {
  const actions = useMailActions();
  const { text, thinking } = normalizeAiMarkdown(message.content);
  const sources = message.sources ?? [];
  const replyTo = session.target?.replyTo;
  const done = !message.streaming && !message.error && !!text;

  const cite = sources.length
    ? (n: number) => {
        const s = sources[n - 1];
        if (!s) return null;
        return (
          <Link
            to={messageUrl(s)}
            onClick={onNavigate}
            title={`${s.subject || '(ohne Betreff)'} – ${displayAddress(s.from)}`}
            className="mx-px inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded bg-primary-soft px-1 align-middle text-[10px] font-semibold text-primary no-underline hover:bg-primary hover:text-primary-fg"
          >
            {n}
          </Link>
        );
      }
    : undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('In die Zwischenablage kopiert');
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  return (
    <div className="group/msg">
      {message.searchQuery !== undefined && <SourceList sources={sources} query={message.searchQuery} onNavigate={onNavigate} />}
      <div className="text-sm leading-relaxed text-fg">
        {text ? <AiMarkdown text={text} cite={cite} /> : null}
        {message.streaming && (message.status || thinking || !text) && (
          <div className={cn('flex items-center gap-2 text-xs text-muted', text && 'mt-2')}>
            <Spinner className="h-3.5 w-3.5" />
            {thinking ? 'Denkt nach …' : (message.status ?? 'Die KI denkt nach …')}
          </div>
        )}
        {message.error && <div className="mt-1 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{message.error}</div>}
      </div>
      {!message.streaming && (
        <div className={cn('mt-1.5 flex flex-wrap items-center gap-1 transition-opacity', last ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100')}>
          {done && (
            <MsgAction icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copy()}>
              Kopieren
            </MsgAction>
          )}
          {done && replyTo && (
            <MsgAction
              icon={<Reply className="h-3.5 w-3.5" />}
              onClick={async () => {
                try {
                  // Bei gespeicherten Chats ist nur die Referenz bekannt → Mail nachladen
                  const detail = replyTo.detail ?? (await fetchMessage(replyTo.ref));
                  actions.reply(detail, replyTo.ref, 'reply', markdownToHtml(text));
                } catch (err) {
                  toast.error(`Mail nicht gefunden: ${errorMessage(err)}`);
                }
              }}
            >
              Als Antwort
            </MsgAction>
          )}
          {done && !replyTo && (
            <MsgAction icon={<PenSquare className="h-3.5 w-3.5" />} onClick={() => openCompose({ html: markdownToHtml(text) })}>
              Als E-Mail
            </MsgAction>
          )}
          {last && (
            <MsgAction icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRegenerate}>
              Neu generieren
            </MsgAction>
          )}
        </div>
      )}
    </div>
  );
}

function MsgAction({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-fg">
      {icon}
      {children}
    </button>
  );
}

function SourceList({ sources, query, onNavigate }: { sources: AiChatSource[]; query: string; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) {
    return (
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted">
        <Search className="h-3.5 w-3.5" /> Keine Mails gefunden für <code className="rounded bg-surface-2 px-1">{query}</code>
      </div>
    );
  }
  return (
    <div className="mb-2 rounded-lg border border-border bg-surface-2/60 text-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted hover:text-fg">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {sources.length} {sources.length === 1 ? 'Mail' : 'Mails'} gefunden · <code className="rounded bg-surface px-1">{query}</code>
        </span>
        <span className="shrink-0">{open ? 'ausblenden' : 'anzeigen'}</span>
      </button>
      {open && (
        <ol className="space-y-0.5 border-t border-border px-1.5 py-1.5">
          {sources.map((s, i) => (
            <li key={`${s.accountId}|${s.folderId}|${s.id}`}>
              <Link to={messageUrl(s)} onClick={onNavigate} className="flex items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                <span className="w-4 shrink-0 text-right font-semibold text-primary">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">{s.subject || '(ohne Betreff)'}</span>
                  <span className="block truncate text-muted">
                    {displayAddress(s.from)} · {formatListDate(s.date)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ───────────────────────────── Gespeicherte Chats ───────────────────────────── */

function groupOf(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Heute';
  if (isYesterday(d)) return 'Gestern';
  if (d > subDays(new Date(), 7)) return 'Letzte 7 Tage';
  if (d > subDays(new Date(), 30)) return 'Letzte 30 Tage';
  return 'Älter';
}

function ChatHistory({ currentId, onBack }: { currentId: string; onBack: () => void }) {
  const { historyVersion } = useAiChat();
  const { settings } = useSettings();
  const { confirm, dialog } = useConfirm();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const chats = useQuery({
    queryKey: ['ai', 'chats', historyVersion],
    queryFn: () => api<AiChatSummary[]>('/ai/chats'),
    placeholderData: keepPreviousData,
  });
  const retention = settings.ai.chatRetentionDays ?? 90;

  const q = filter.trim().toLowerCase();
  const list = (chats.data ?? []).filter((c) => !q || `${c.title} ${c.contextTitle ?? ''}`.toLowerCase().includes(q));
  const groups: { label: string; items: AiChatSummary[] }[] = [];
  for (const c of list) {
    const label = groupOf(c.updatedAt);
    const g = groups[groups.length - 1];
    if (g?.label === label) g.items.push(c);
    else groups.push({ label, items: [c] });
  }

  const commitRename = () => {
    if (editing) void renameAiChat(editing.id, editing.title);
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg" title="Zurück zum Chat" aria-label="Zurück zum Chat">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Chats durchsuchen …"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2.5 text-sm outline-none focus:border-primary/50"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {chats.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Spinner className="h-4 w-4" /> Lade Chats …
          </div>
        ) : chats.error ? (
          <div className="m-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{errorMessage(chats.error)}</div>
        ) : !list.length ? (
          <div className="px-4 py-10 text-center text-sm text-muted">{q ? 'Keine passenden Chats.' : 'Noch keine gespeicherten Chats.'}</div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g.label}</div>
              {g.items.map((c) => {
                const Icon = c.kind === 'global' ? Sparkles : CONTEXT_ICON[c.kind];
                const current = c.id === currentId;
                return (
                  <div key={c.id} className={cn('group/item flex items-center gap-2 rounded-lg px-2 py-1.5', current ? 'bg-primary-soft' : 'hover:bg-hover')}>
                    <Icon className={cn('h-4 w-4 shrink-0', current ? 'text-primary' : 'text-subtle')} />
                    {editing?.id === c.id ? (
                      <input
                        autoFocus
                        value={editing.title}
                        onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                        maxLength={200}
                        className="h-7 min-w-0 flex-1 rounded border border-primary/50 bg-surface px-1.5 text-sm outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void loadAiChat(c.id);
                          onBack();
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className={cn('block truncate text-sm', current && 'font-medium text-primary')}>{c.title}</span>
                        <span className="block truncate text-xs text-muted">
                          {formatListDate(c.updatedAt)} · {c.messageCount} {c.messageCount === 1 ? 'Nachricht' : 'Nachrichten'}
                          {c.contextTitle && c.contextTitle !== c.title ? ` · ${c.contextTitle}` : ''}
                        </span>
                      </button>
                    )}
                    {editing?.id !== c.id && (
                      <div className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/item:opacity-100">
                        <button
                          type="button"
                          onClick={() => setEditing({ id: c.id, title: c.title })}
                          className="rounded p-1 text-muted hover:bg-surface hover:text-fg"
                          title="Umbenennen"
                          aria-label="Umbenennen"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteAiChat(c.id)}
                          className="rounded p-1 text-muted hover:bg-surface hover:text-danger"
                          title="Löschen"
                          aria-label="Löschen"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-subtle">
        <span className="min-w-0 flex-1">
          {retention > 0 ? `Chats werden ${retention} Tage nach der letzten Nachricht gelöscht.` : 'Chats werden unbegrenzt aufbewahrt.'}{' '}
          <Link to="/settings/ai" className="underline underline-offset-2 hover:text-fg">
            Ändern
          </Link>
        </span>
        {!!chats.data?.length && (
          <button
            type="button"
            onClick={async () => {
              if (await confirm(`Alle ${chats.data!.length} gespeicherten KI-Chats endgültig löschen?`, { danger: true })) void deleteAllAiChats();
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
          >
            Alle löschen
          </button>
        )}
      </div>
      {dialog}
    </div>
  );
}
