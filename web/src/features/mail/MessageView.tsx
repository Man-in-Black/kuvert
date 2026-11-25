/**
 * Leseansicht einer Nachricht.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCode,
  Flag,
  FolderInput,
  Forward,
  Lock,
  Mail,
  MailOpen,
  MapPin,
  MoreHorizontal,
  PenLine,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Trash2,
  User,
} from 'lucide-react';
import type { AccountInfo, EmailAddress, FolderRole, MessageDetail, UserSettings } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { useSettings } from '@/lib/queries';
import { cn, formatDateTime } from '@/lib/utils';
import { Avatar, Badge, Button, Dropdown, EmptyState, IconButton, Spinner } from '@/components/ui';
import { useExtensions } from '@/modules/context';
import { openCompose } from './compose-api';
import { fetchMessage, mailKeys, moveMessages, rawUrl, refKey, respondToInvite, toRef, wasRemoved, type MessageRef } from './api';
import { useMailActions } from './actions';
import { AttachmentList } from './components/Attachments';
import { MessageBody, isTrustedSender, messageSrcDoc } from './components/MessageBody';
import { MoveDialog } from './components/MoveDialog';
import { useQueryClient } from '@tanstack/react-query';

export function MessageView({
  msgRef,
  account,
  folderRole,
  onBack,
  onAfterRemove,
  embedded,
  onCollapse,
  showReplyButtons = true,
  onOpenWindow,
}: {
  msgRef: MessageRef;
  account?: AccountInfo;
  folderRole?: FolderRole;
  onBack?: () => void;
  /** Nach Archivieren/Löschen (z. B. zur nächsten Nachricht springen) */
  onAfterRemove?: () => void;
  /** Als Karte innerhalb einer Konversation (ohne eigenen Scrollbereich und Betreff) */
  embedded?: boolean;
  /** Nur eingebettet: Karte zuklappen */
  onCollapse?: () => void;
  /** Antworten-Schaltflächen unter dem Inhalt */
  showReplyButtons?: boolean;
  /** „In neuem Fenster öffnen“ anbieten */
  onOpenWindow?: () => void;
}) {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const actions = useMailActions();
  const navigate = useNavigate();
  const messageActions = useExtensions('messageActions');
  const messageBanners = useExtensions('messageBanners');
  const [showDetails, setShowDetails] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  const { data: msg, isLoading, error } = useQuery({
    queryKey: mailKeys.message(msgRef.accountId, msgRef.folderId, msgRef.id),
    queryFn: () => fetchMessage(msgRef),
    staleTime: 5 * 60_000,
  });

  // ── Als gelesen markieren (Einstellung „Als gelesen markieren") ──
  // Pro geöffneter Nachricht höchstens einmal automatisch. Hat der Nutzer den
  // Lesestatus während des Lesens selbst geändert (z. B. wieder auf ungelesen),
  // wird nichts mehr automatisch markiert.
  const readMode: UserSettings['markReadMode'] = settings.markReadDelaySec < 0 ? 'manual' : (settings.markReadMode ?? 'delay');
  // Schlüssel aus Konto+Ordner+ID (IMAP-UIDs sind nur je Ordner eindeutig)
  const msgKey = msg ? refKey(toRef(msg)) : undefined;
  const readTrack = useRef<{ key: string; msg: MessageDetail; done: boolean } | null>(null);
  const pendingLeave = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    if (!msg || !msgKey) return;
    const t = readTrack.current;
    if (!t || t.key !== msgKey) readTrack.current = { key: msgKey, msg, done: msg.seen };
    else {
      if (msg.seen !== t.msg.seen) t.done = true;
      t.msg = msg;
    }
  }, [msg, msgKey]);

  useEffect(() => {
    const entry = readTrack.current;
    if (!msgKey || !entry || entry.key !== msgKey) return;
    // StrictMode/Neu-Rendern derselben Nachricht: geplantes „beim Verlassen" verwerfen
    if (pendingLeave.current?.key === msgKey) {
      clearTimeout(pendingLeave.current.timer);
      pendingLeave.current = null;
    }
    const mark = () => {
      if (entry.done) return;
      entry.done = true;
      const ref = toRef(entry.msg);
      const cur = qc.getQueryData<MessageDetail>(mailKeys.message(ref.accountId, ref.folderId, ref.id)) ?? entry.msg;
      if (cur.seen || wasRemoved(ref)) return;
      void actions.markSeen(cur);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (readMode === 'delay') timer = setTimeout(mark, Math.max(0, settings.markReadDelaySec) * 1000);
    return () => {
      if (timer) clearTimeout(timer);
      if (readMode === 'leave' && !entry.done) pendingLeave.current = { key: entry.key, timer: setTimeout(mark, 0) };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgKey, readMode, settings.markReadDelaySec]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center', embedded ? 'rounded-lg border border-border py-6' : 'h-full')}>
        <Spinner />
      </div>
    );
  }
  if (error || !msg) {
    if (embedded)
      return (
        <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Nachricht konnte nicht geladen werden{error ? `: ${errorMessage(error)}` : ''}
        </div>
      );
    return (
      <EmptyState icon={<AlertTriangle />} title="Nachricht konnte nicht geladen werden">
        {error ? errorMessage(error) : null}
      </EmptyState>
    );
  }

  const ref = toRef(msg);
  const isDraft = folderRole === 'drafts';
  const isJunk = folderRole === 'junk';
  const isTrash = folderRole === 'trash';
  const remove = () => {
    void actions.remove([ref], isTrash);
    onAfterRemove?.();
  };

  const print = () => {
    const trusted = !settings.blockRemoteContent || isTrustedSender(msg.from?.address, settings.trustedSenders);
    const doc = messageSrcDoc(msg, ref, trusted);
    const header = `<div style="font-family:Arial,sans-serif;font-size:13px;border-bottom:1px solid #ccc;padding:0 0 10px;margin:0 0 12px">
      <div style="font-size:18px;font-weight:bold;margin-bottom:6px">${escape(msg.subject)}</div>
      <div><b>Von:</b> ${escape(addr(msg.from))}</div>
      <div><b>An:</b> ${escape(msg.to.map(addr).join(', '))}</div>
      ${msg.cc?.length ? `<div><b>Cc:</b> ${escape(msg.cc.map(addr).join(', '))}</div>` : ''}
      <div><b>Datum:</b> ${escape(formatDateTime(msg.date))}</div></div>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(doc.replace(/<body([^>]*)>/i, `<body$1>${header}`));
    w.document.close();
    setTimeout(() => {
      w.focus();
      w.print();
    }, 400);
  };

  const unsubscribe = parseUnsubscribe(msg.listUnsubscribe);
  const hasBadges = (!embedded && !!account) || msg.importance === 'high' || !!msg.security?.signed || !!msg.security?.encrypted || !!msg.categories?.length;

  return (
    <div className={cn('bg-surface', embedded ? 'rounded-lg border border-border shadow-sm' : 'flex h-full min-h-0 flex-col')}>
      {/* Aktionsleiste */}
      <div className={cn('flex flex-wrap items-center gap-0.5 border-b border-border px-2', embedded ? 'py-1' : 'py-1.5')}>
        {onBack && (
          <IconButton label="Zurück" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        )}
        {isDraft ? (
          <Button size="sm" variant="primary" icon={<PenLine className="h-4 w-4" />} onClick={() => actions.editDraft(msg, ref)}>
            Entwurf bearbeiten
          </Button>
        ) : (
          <>
            <IconButton label="Antworten (R)" size="icon-sm" onClick={() => actions.reply(msg, ref, 'reply')}>
              <Reply className="h-4 w-4" />
            </IconButton>
            <IconButton label="Allen antworten (A)" size="icon-sm" onClick={() => actions.reply(msg, ref, 'replyAll')}>
              <ReplyAll className="h-4 w-4" />
            </IconButton>
            <IconButton label="Weiterleiten (F)" size="icon-sm" onClick={() => actions.reply(msg, ref, 'forward')}>
              <Forward className="h-4 w-4" />
            </IconButton>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton
          label="Archivieren (E)"
          size="icon-sm"
          onClick={() => {
            void actions.archive([ref]);
            onAfterRemove?.();
          }}
        >
          <Archive className="h-4 w-4" />
        </IconButton>
        <IconButton label={isTrash ? 'Endgültig löschen' : 'Löschen (Entf)'} size="icon-sm" onClick={remove}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="Verschieben" size="icon-sm" onClick={() => setMoveOpen(true)}>
          <FolderInput className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={isJunk ? 'Kein Spam' : 'Spam'}
          size="icon-sm"
          onClick={() => {
            void (isJunk ? actions.notSpam([ref]) : actions.spam([ref]));
            onAfterRemove?.();
          }}
        >
          <ShieldAlert className="h-4 w-4" />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton label={msg.flagged ? 'Markierung entfernen (S)' : 'Markieren (S)'} size="icon-sm" onClick={() => void actions.toggleFlag([msg])}>
          <Flag className={cn('h-4 w-4', msg.flagged && 'fill-danger text-danger')} />
        </IconButton>
        <IconButton label={msg.seen ? 'Als ungelesen markieren (U)' : 'Als gelesen markieren (U)'} size="icon-sm" onClick={() => void actions.toggleSeen([msg])}>
          {msg.seen ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
        </IconButton>
        {messageActions.map((C, i) => (
          <Fragment key={i}>
            <C accountId={msgRef.accountId} folderId={msgRef.folderId} message={msg} />
          </Fragment>
        ))}
        <span className="flex-1" />
        {onOpenWindow && (
          <IconButton label="In neuem Fenster öffnen" size="icon-sm" onClick={onOpenWindow}>
            <ExternalLink className="h-4 w-4" />
          </IconButton>
        )}
        <Dropdown
          align="right"
          trigger={
            <IconButton label="Weitere Aktionen" size="icon-sm">
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          }
          items={[
            { label: 'Drucken', icon: <Printer />, onClick: print },
            {
              label: 'Quelltext herunterladen (.eml)',
              icon: <FileCode />,
              onClick: () => {
                const a = document.createElement('a');
                a.href = rawUrl(ref);
                a.download = ''; // Dateiname (Betreff + Absender) kommt vom Server
                a.click();
              },
            },
            ...(isDraft ? [] : [{ label: 'Als Entwurf bearbeiten', icon: <PenLine />, onClick: () => actions.editDraft(msg, ref) }]),
          ]}
        />
        {onCollapse && (
          <IconButton label="Zuklappen" size="icon-sm" onClick={onCollapse}>
            <ChevronUp className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {/* Inhalt */}
      <div className={embedded ? 'px-4 py-3' : 'min-h-0 flex-1 overflow-y-auto px-5 py-4'}>
        {!embedded && <h1 className="mb-3 text-xl font-semibold leading-snug">{msg.subject || '(ohne Betreff)'}</h1>}
        {hasBadges && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {!embedded && account && <Badge color={account.color}>{account.name}</Badge>}
            {msg.importance === 'high' && <Badge color="#dc2626">Wichtig</Badge>}
            <SecurityBadge msg={msg} />
            {msg.categories?.map((c) => <Badge key={c}>{c}</Badge>)}
          </div>
        )}

        <div className="flex items-start gap-3">
          <Avatar name={msg.from?.name} email={msg.from?.address} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{msg.from?.name || msg.from?.address || '(unbekannt)'}</span>
              {msg.from?.name && <span className="text-sm text-muted">&lt;{msg.from.address}&gt;</span>}
            </div>
            <button type="button" className="flex items-center gap-1 text-left text-xs text-muted hover:text-fg" onClick={() => setShowDetails(!showDetails)}>
              <span className="truncate">an {msg.to.map((a) => a.name || a.address).join(', ') || '—'}</span>
              {showDetails ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
            </button>
            {showDetails && (
              <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-surface-2 p-2 text-xs">
                <AddrRow label="Von" list={msg.from ? [msg.from] : []} />
                <AddrRow label="An" list={msg.to} />
                <AddrRow label="Cc" list={msg.cc} />
                <AddrRow label="Bcc" list={msg.bcc} />
                <AddrRow label="Antwort an" list={msg.replyTo} />
                <span className="text-muted">Datum</span>
                <span>{formatDateTime(msg.date)}</span>
                {msg.security?.signer && (
                  <>
                    <span className="text-muted">Signiert von</span>
                    <span>{msg.security.signer}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right text-xs text-muted" title={formatDateTime(msg.date)}>
            {format(new Date(msg.date), 'd. MMM yyyy, HH:mm', { locale: de })}
          </div>
        </div>

        {unsubscribe && (
          <div className="mt-2 text-xs text-muted">
            Newsletter?{' '}
            {unsubscribe.http ? (
              <a href={unsubscribe.http} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                Abbestellen
              </a>
            ) : (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => openCompose({ accountId: msgRef.accountId, to: [{ address: unsubscribe.mailto!.address }], subject: unsubscribe.mailto!.subject ?? 'unsubscribe' })}
              >
                Abbestellen
              </button>
            )}
          </div>
        )}

        {msg.security?.error && (
          <div
            className={cn(
              'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
              msg.security.trusted === false ? 'border-warning/40 bg-warning/10 text-warning' : 'border-danger/40 bg-danger/10 text-danger',
            )}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" /> {msg.security.error}
          </div>
        )}

        {msg.invite && (
          <InviteCard
            invite={msg.invite}
            msgRef={msgRef}
            onOpenCalendar={() => navigate(`/calendar${msg.invite?.start ? `?date=${msg.invite.start.slice(0, 10)}` : ''}`)}
          />
        )}

        <div className="mt-4 space-y-3">
          {messageBanners.map((C, i) => (
            <Fragment key={i}>
              <C accountId={msgRef.accountId} folderId={msgRef.folderId} message={msg} />
            </Fragment>
          ))}
        </div>

        <div className="mt-4">
          <MessageBody message={msg} msgRef={ref} />
        </div>

        <AttachmentList attachments={msg.attachments} msgRef={ref} />

        {!isDraft && showReplyButtons && (
          <div className="mt-6 flex flex-wrap gap-2">
            <Button icon={<Reply className="h-4 w-4" />} onClick={() => actions.reply(msg, ref, 'reply')}>
              Antworten
            </Button>
            <Button icon={<ReplyAll className="h-4 w-4" />} onClick={() => actions.reply(msg, ref, 'replyAll')}>
              Allen antworten
            </Button>
            <Button icon={<Forward className="h-4 w-4" />} onClick={() => actions.reply(msg, ref, 'forward')}>
              Weiterleiten
            </Button>
          </div>
        )}
      </div>

      <MoveDialog
        open={moveOpen}
        accountId={msgRef.accountId}
        excludeFolderId={msgRef.folderId}
        onClose={() => setMoveOpen(false)}
        onPick={(folderId) => {
          void moveMessages(qc, [ref], folderId);
          onAfterRemove?.();
        }}
      />
    </div>
  );
}

function AddrRow({ label, list }: { label: string; list?: EmailAddress[] }) {
  if (!list?.length) return null;
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className="break-all">{list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}</span>
    </>
  );
}

function SecurityBadge({ msg }: { msg: MessageDetail }) {
  const s = msg.security;
  if (!s) return null;
  return (
    <>
      {s.signed &&
        (s.signatureValid ? (
          <Badge color="#16a34a" className="gap-1">
            <ShieldCheck className="h-3 w-3" /> Signiert{s.signer ? ` · ${s.signer}` : ''}
          </Badge>
        ) : s.trusted === false ? (
          <Badge color="#d97706" className="gap-1">
            <ShieldAlert className="h-3 w-3" /> Signatur nicht vertrauenswürdig
          </Badge>
        ) : (
          <Badge color="#dc2626" className="gap-1">
            <ShieldX className="h-3 w-3" /> Signatur ungültig
          </Badge>
        ))}
      {s.encrypted && (
        <Badge color={s.decrypted ? '#2563eb' : '#d97706'} className="gap-1">
          <Lock className="h-3 w-3" /> {s.decrypted ? 'Verschlüsselt' : 'Verschlüsselt (nicht entschlüsselbar)'}
        </Badge>
      )}
    </>
  );
}

type InviteResponse = 'accept' | 'tentative' | 'decline';

const RESPONSE_LABEL: Record<NonNullable<MessageDetail['invite']>['myResponse'] & string, string> = {
  accepted: 'Zugesagt',
  tentative: 'Mit Vorbehalt zugesagt',
  declined: 'Abgesagt',
  none: '',
  organizer: 'Du bist Organisator',
};
const SENT_LABEL: Record<InviteResponse, string> = { accept: 'Zugesagt', tentative: 'Mit Vorbehalt zugesagt', decline: 'Abgesagt' };

function InviteCard({ invite, msgRef, onOpenCalendar }: { invite: NonNullable<MessageDetail['invite']>; msgRef: MessageRef; onOpenCalendar: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<InviteResponse | null>(null);
  const [sent, setSent] = useState<InviteResponse | null>(null);
  const start = invite.start ? new Date(invite.start) : null;
  const end = invite.end ? new Date(invite.end) : null;
  const method = invite.method?.toUpperCase();
  const cancelled = method === 'CANCEL';
  const status = sent ? SENT_LABEL[sent] : invite.myResponse ? RESPONSE_LABEL[invite.myResponse] : '';
  const current: InviteResponse | null =
    sent ?? (invite.myResponse === 'accepted' ? 'accept' : invite.myResponse === 'tentative' ? 'tentative' : invite.myResponse === 'declined' ? 'decline' : null);

  const respond = async (response: InviteResponse) => {
    setBusy(response);
    try {
      await respondToInvite(msgRef, response);
      setSent(response);
      toast.success(`${SENT_LABEL[response]} – Antwort an ${invite.organizer?.name || invite.organizer?.address || 'den Organisator'} gesendet`);
      void qc.invalidateQueries({ queryKey: mailKeys.message(msgRef.accountId, msgRef.folderId, msgRef.id) });
      void qc.invalidateQueries({ queryKey: ['calendar', 'events'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn('mt-4 flex flex-wrap gap-3 rounded-lg border p-3', cancelled ? 'border-danger/40 bg-danger/5' : 'border-primary/30 bg-primary-soft')}>
      <CalendarDays className={cn('mt-0.5 h-5 w-5 shrink-0', cancelled ? 'text-danger' : 'text-primary')} />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold">
          {cancelled ? 'Termin abgesagt: ' : method === 'REPLY' ? 'Antwort auf Einladung: ' : 'Einladung: '}
          {invite.summary ?? '(ohne Titel)'}
        </div>
        {start && (
          <div className="text-muted">
            {format(start, "EEEE, d. MMMM yyyy, HH:mm", { locale: de })}
            {end ? ` – ${format(end, start.toDateString() === end.toDateString() ? 'HH:mm' : 'd. MMM HH:mm', { locale: de })}` : ''}
          </div>
        )}
        {invite.location && (
          <div className="flex items-center gap-1 text-muted">
            <MapPin className="h-3.5 w-3.5" /> {invite.location}
          </div>
        )}
        {invite.organizer && (
          <div className="flex items-center gap-1 text-muted">
            <User className="h-3.5 w-3.5" /> {invite.organizer.name || invite.organizer.address}
          </div>
        )}
        {status && <div className="mt-1 text-xs font-medium text-primary">{status}</div>}
        {invite.canRespond ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {(['accept', 'tentative', 'decline'] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={current === r ? (r === 'decline' ? 'danger' : 'primary') : 'secondary'}
                loading={busy === r}
                disabled={!!busy}
                onClick={() => void respond(r)}
              >
                {r === 'accept' ? 'Zusagen' : r === 'tentative' ? 'Mit Vorbehalt' : 'Absagen'}
              </Button>
            ))}
          </div>
        ) : (
          method === 'REQUEST' &&
          invite.myResponse !== 'organizer' && (
            <div className="mt-2 text-xs text-muted">Zusagen/Absagen ist im Kalender möglich, sobald der Termin dort eingetragen ist.</div>
          )
        )}
      </div>
      <Button size="sm" onClick={onOpenCalendar}>
        Im Kalender öffnen
      </Button>
    </div>
  );
}

function parseUnsubscribe(header?: string): { http?: string; mailto?: { address: string; subject?: string } } | null {
  if (!header) return null;
  const parts = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const http = parts.find((p) => /^https?:\/\//i.test(p));
  const mail = parts.find((p) => /^mailto:/i.test(p));
  if (http) return { http };
  if (mail) {
    const u = mail.slice(7);
    const [address, query] = u.split('?');
    const subject = query ? new URLSearchParams(query).get('subject') ?? undefined : undefined;
    return { mailto: { address: decodeURIComponent(address ?? ''), subject } };
  }
  return null;
}

function addr(a?: EmailAddress) {
  return a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '';
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
