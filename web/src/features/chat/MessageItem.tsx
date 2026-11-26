import { memo, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { Check, CheckCheck, Copy, Download, File as FileIcon, MoreHorizontal, Pencil, Phone, PhoneOff, Reply, SmilePlus, Trash2 } from 'lucide-react';
import { CHAT_QUICK_REACTIONS, type ChatAttachment, type ChatCapabilities, type ChatCard, type ChatMessage, type ChatUser } from '@kuvert/shared';
import { Dropdown, Modal } from '@/components/ui';
import { cn, formatSize } from '@/lib/utils';
import { FULL_CAPS, fileUrl, userName } from './api';
import { EmojiGrid, Popover, UserAvatar } from './components';
import { bodyOf, isEmojiOnly, previewOf, renderBody, systemText, timeOf } from './format';

export interface MessageItemProps {
  message: ChatMessage;
  me: string | undefined;
  users: Map<string, ChatUser>;
  isGroup: boolean;
  /** Erste Nachricht eines Blocks desselben Absenders → Name/Avatar anzeigen */
  first: boolean;
  /** Darf fremde Nachrichten löschen (Gruppen-Admin) */
  canModerate: boolean;
  /** Lesestatus unter der letzten eigenen Nachricht */
  readState?: { read: boolean; label: string } | null;
  highlighted?: boolean;
  /** Möglichkeiten der Unterhaltung (verbundene Dienste können weniger) */
  caps?: ChatCapabilities;
  onReply(m: ChatMessage): void;
  onEdit(m: ChatMessage): void;
  onDelete(m: ChatMessage): void;
  onReact(m: ChatMessage, emoji: string): void;
  onJump(messageId: string): void;
  onMediaLoad(): void;
  /** Laufender Anruf der Unterhaltung: dorthin führt "Beitreten" auf der Anruf-Karte */
  callJoinUrl?: string | null;
}

const isImage = (a: ChatAttachment) => a.contentType.startsWith('image/') && !a.contentType.includes('svg');

function MessageItemImpl(p: MessageItemProps) {
  const { message: m, me, users } = p;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lightbox, setLightbox] = useState<ChatAttachment | null>(null);

  if (m.kind === 'system') {
    return (
      <div className="my-2 flex justify-center px-4">
        <span className="rounded-full bg-surface-2 px-3 py-1 text-center text-xs text-muted ring-1 ring-border">{systemText(m.body, users, me)}</span>
      </div>
    );
  }

  if (m.call) {
    const call = m.call;
    const ongoing = !call.endedAt;
    const starter = m.senderId === me ? 'dir' : (m.senderId ? users.get(m.senderId)?.name : undefined) ?? m.senderName ?? 'jemandem';
    const count = call.participantIds.length;
    return (
      <div id={`msg-${m.id}`} className="my-2 flex justify-center px-4">
        <div className={cn('flex max-w-full items-center gap-3 rounded-xl border px-3 py-2 text-sm shadow-soft', ongoing ? 'border-success/40 bg-success/5' : 'border-border bg-surface')}>
          <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', ongoing ? 'bg-success text-white' : 'bg-surface-2 text-muted')}>
            {ongoing ? <Phone className="h-4 w-4" /> : <PhoneOff className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{call.title ?? (ongoing ? 'Anruf läuft' : 'Anruf beendet')}</span>
            <span className="block truncate text-xs text-muted">
              Gestartet von {starter} um {timeOf(call.startedAt)}
              {call.endedAt && ` · ${callDuration(call.startedAt, call.endedAt)}`}
              {count > 0 && ` · ${count} ${count === 1 ? 'Person' : 'Personen'}`}
            </span>
          </span>
          {ongoing && p.callJoinUrl && (
            <button
              type="button"
              onClick={() => window.open(p.callJoinUrl!, '_blank', 'noopener,noreferrer')}
              className="shrink-0 rounded-lg bg-success px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              Beitreten
            </button>
          )}
        </div>
      </div>
    );
  }

  const caps = p.caps ?? FULL_CAPS;
  const mine = !!me && m.senderId === me;
  const sender = m.senderId ? users.get(m.senderId) : undefined;
  const senderLabel = sender?.name ?? m.senderName ?? 'Ehemaliger Benutzer';
  const showAvatar = p.isGroup && !mine;
  const cards = m.deleted ? [] : (m.cards ?? []);
  const emojiOnly = !m.deleted && !m.attachments.length && !m.replyTo && !cards.length && isEmojiOnly(m.body);
  const images = m.attachments.filter(isImage);
  const files = m.attachments.filter((a) => !isImage(a));
  const canDelete = !m.deleted && caps.delete && (mine || p.canModerate);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bodyOf(m));
      toast.success('Text kopiert');
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  const time = (
    <span className={cn('ml-2 inline-flex translate-y-1 select-none items-center gap-1 whitespace-nowrap text-[10.5px] leading-none', mine && !emojiOnly ? 'text-primary-fg/75' : 'text-subtle', 'float-right')}>
      {m.editedAt && !m.deleted && <span>bearbeitet</span>}
      {timeOf(m.createdAt)}
    </span>
  );

  return (
    <div
      id={`msg-${m.id}`}
      className={cn('group relative flex gap-2 px-3 sm:px-5', mine && 'flex-row-reverse', p.first ? 'mt-3' : 'mt-[3px]')}
    >
      {p.isGroup && !mine && (
        <div className="w-8 shrink-0 pt-0.5">
          {p.first && showAvatar && <UserAvatar user={sender ?? (m.senderName ? { id: m.senderId ?? '', name: m.senderName, email: '', online: false } : undefined)} size={32} presence={false} />}
        </div>
      )}

      <div className={cn('flex min-w-0 max-w-[min(78%,680px)] flex-col', mine ? 'items-end' : 'items-start')}>
        {p.first && showAvatar && (
          <div className="mb-0.5 flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
            {senderLabel}
            {m.bot && <span className="rounded bg-surface-2 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-subtle ring-1 ring-border">Bot</span>}
          </div>
        )}

        <div
          tabIndex={0}
          className={cn(
            'relative min-w-0 max-w-full break-words text-[14px] leading-[1.45] outline-none transition-shadow [overflow-wrap:anywhere]',
            emojiOnly
              ? 'text-[40px] leading-tight'
              : cn(
                  'rounded-2xl px-3 py-1.5',
                  mine ? 'bg-primary text-primary-fg' : 'border border-border bg-surface text-fg shadow-soft',
                  p.first && (mine ? 'rounded-tr-md' : 'rounded-tl-md'),
                ),
            m.deleted && 'italic opacity-70',
            p.highlighted && 'ring-2 ring-warning ring-offset-2 ring-offset-bg',
          )}
        >
          {m.replyTo && (
            <button
              type="button"
              onClick={() => p.onJump(m.replyTo!.id)}
              className={cn(
                'mb-1 mt-0.5 block w-full max-w-full rounded-md border-l-[3px] px-2 py-1 text-left text-xs',
                mine ? 'border-primary-fg/60 bg-black/10' : 'border-primary bg-surface-2',
              )}
            >
              <span className="block font-semibold">{userName(m.replyTo.senderId, users, me)}</span>
              <span className="line-clamp-2 opacity-80">
                {m.replyTo.deleted ? 'Gelöschte Nachricht' : previewOf(m.replyTo.body, m.replyTo.hasAttachments ? 1 : 0) || '…'}
              </span>
            </button>
          )}

          {images.length > 0 && (
            <div className={cn('my-1 grid gap-1', images.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
              {images.map((a) => (
                <button key={a.id} type="button" onClick={() => setLightbox(a)} className="block overflow-hidden rounded-lg bg-black/5" title={a.filename}>
                  <img
                    src={fileUrl(a.id, true)}
                    alt={a.filename}
                    loading="lazy"
                    onLoad={p.onMediaLoad}
                    className={cn('block w-full object-cover', images.length > 1 ? 'aspect-square max-w-[180px]' : 'max-h-72 max-w-[320px]')}
                  />
                </button>
              ))}
            </div>
          )}

          {files.length > 0 && (
            <div className="my-1 flex flex-col gap-1">
              {files.map((a) => (
                <a
                  key={a.id}
                  href={fileUrl(a.id)}
                  download={a.filename}
                  className={cn(
                    'flex min-w-0 max-w-[320px] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    mine ? 'bg-black/10 hover:bg-black/20' : 'bg-surface-2 hover:bg-hover',
                  )}
                >
                  <FileIcon className="h-5 w-5 shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium not-italic">{a.filename}</span>
                    <span className="block text-[11px] opacity-70">{formatSize(a.size)}</span>
                  </span>
                  <Download className="h-4 w-4 shrink-0 opacity-70" />
                </a>
              ))}
            </div>
          )}

          {m.deleted ? (
            <span>Diese Nachricht wurde gelöscht</span>
          ) : (
            m.body && <span className="whitespace-pre-wrap">{renderBody(m.body)}</span>
          )}
          {cards.length > 0 && (
            <div className={cn('flex flex-col gap-1.5', m.body.trim() ? 'mb-1 mt-1.5' : 'my-1')}>
              {cards.map((c, i) => (
                <MessageCard key={i} card={c} mine={mine} onMediaLoad={p.onMediaLoad} />
              ))}
            </div>
          )}
          {!emojiOnly && time}
          {emojiOnly && <span className="ml-1 align-bottom text-[10.5px] text-subtle">{timeOf(m.createdAt)}</span>}
        </div>

        {m.reactions.length > 0 && (
          <div className={cn('mt-1 flex flex-wrap gap-1', mine && 'justify-end')}>
            {m.reactions.map((r) => {
              const reacted = !!me && r.userIds.includes(me);
              const count = r.count ?? r.userIds.length;
              const names = r.userIds.map((id) => userName(id, users, me));
              return (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={!caps.react}
                  onClick={() => p.onReact(m, r.emoji)}
                  title={names.length < count ? [...names, `${count - names.length} weitere`].join(', ') : names.join(', ')}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
                    reacted ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border bg-surface text-muted hover:bg-hover',
                  )}
                >
                  <span className="text-sm leading-none">{r.emoji}</span>
                  <span className="font-medium tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {p.readState && (
          <div className="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-subtle">
            {p.readState.read ? <CheckCheck className="h-3.5 w-3.5 text-primary" /> : <Check className="h-3.5 w-3.5" />}
            {p.readState.label}
          </div>
        )}
      </div>

      {/* Aktionen bei Hover/Fokus */}
      {!m.deleted && (
        <div
          className={cn(
            'absolute -top-3 z-10 hidden items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-pop group-focus-within:flex group-hover:flex',
            mine ? 'left-3 sm:left-5' : 'right-3 sm:right-5',
            pickerOpen && 'flex',
          )}
        >
          {caps.react && CHAT_QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} type="button" onClick={() => p.onReact(m, e)} className="flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-hover" title={`Mit ${e} reagieren`}>
              {e}
            </button>
          ))}
          {caps.react && (
          <Popover
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            side="bottom"
            align={mine ? 'left' : 'right'}
            trigger={
              <button type="button" onClick={() => setPickerOpen((o) => !o)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Reaktion hinzufügen">
                <SmilePlus className="h-4 w-4" />
              </button>
            }
          >
            <EmojiGrid
              onPick={(e) => {
                setPickerOpen(false);
                p.onReact(m, e);
              }}
            />
          </Popover>
          )}
          {caps.reply && (
            <button type="button" onClick={() => p.onReply(m)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Antworten">
              <Reply className="h-4 w-4" />
            </button>
          )}
          <Dropdown
            align={mine ? 'left' : 'right'}
            trigger={
              <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Weitere Aktionen">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            }
            items={[
              ...(caps.reply ? [{ label: 'Antworten', icon: <Reply />, onClick: () => p.onReply(m) }] : []),
              ...(bodyOf(m) ? [{ label: 'Text kopieren', icon: <Copy />, onClick: () => void copy() }] : []),
              ...(mine && caps.edit ? [{ label: 'Bearbeiten', icon: <Pencil />, onClick: () => p.onEdit(m) }] : []),
              ...(canDelete ? [{ divider: true, label: '' }, { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => p.onDelete(m) }] : []),
            ]}
          />
        </div>
      )}

      {lightbox && (
        <Modal open onClose={() => setLightbox(null)} title={lightbox.filename} size="xl">
          <div className="flex flex-col items-center gap-3">
            <img src={fileUrl(lightbox.id, true)} alt={lightbox.filename} className="max-h-[70vh] max-w-full rounded-lg object-contain" />
            <a href={fileUrl(lightbox.id)} download={lightbox.filename} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
              <Download className="h-4 w-4" /> Herunterladen ({formatSize(lightbox.size)})
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}

export const MessageItem = memo(MessageItemImpl);

/** Formatierte Meldung eines Bots/Webhooks (Mattermost-Nachrichtenanhang) */
function MessageCard({ card: c, mine, onMediaLoad }: { card: ChatCard; mine: boolean; onMediaLoad(): void }) {
  const link = (href: string | null | undefined, children: ReactNode) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-current/40 underline-offset-2 hover:decoration-current">
        {children}
      </a>
    ) : (
      children
    );
  return (
    <div className="min-w-0">
      {c.pretext && <div className="mb-1 whitespace-pre-wrap">{renderBody(c.pretext)}</div>}
      <div
        className={cn('min-w-0 rounded-md border-l-4 px-2.5 py-1.5 text-[13px]', mine ? 'bg-black/10' : 'bg-surface-2')}
        style={{ borderLeftColor: c.color ?? 'var(--color-border-strong)' }}
      >
        {c.author && <div className="mb-0.5 text-xs font-medium opacity-80">{link(c.authorUrl, c.author)}</div>}
        {c.title && <div className="mb-0.5 font-semibold">{link(c.titleUrl, renderBody(c.title))}</div>}
        {c.text && <div className="whitespace-pre-wrap">{renderBody(c.text)}</div>}
        {!!c.fields?.length && (
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {c.fields.map((f, i) => (
              <div key={i} className={cn('min-w-0', !f.short && 'col-span-2')}>
                {f.title && <div className="text-xs font-semibold opacity-80">{renderBody(f.title)}</div>}
                {f.value && <div className="whitespace-pre-wrap">{renderBody(f.value)}</div>}
              </div>
            ))}
          </div>
        )}
        {c.imageUrl && (
          <a href={c.imageUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 block">
            <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onLoad={onMediaLoad} className="block max-h-72 max-w-full rounded" />
          </a>
        )}
        {(c.footer || c.ts) && (
          <div className="mt-1 text-[11px] opacity-70">
            {c.footer && renderBody(c.footer)}
            {c.footer && c.ts && ' · '}
            {c.ts && format(new Date(c.ts), 'dd.MM.yyyy HH:mm', { locale: de })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Dauer eines beendeten Anrufs, z. B. "Dauer 12 Min." */
function callDuration(start: string, end: string): string {
  const min = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  if (min < 1) return 'unter 1 Min.';
  if (min < 60) return `Dauer ${min} Min.`;
  return `Dauer ${Math.floor(min / 60)} Std. ${min % 60} Min.`;
}
