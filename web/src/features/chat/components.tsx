/** Kleine Bausteine des Chats: Avatare mit Online-Status, Emoji-Auswahl, Personenauswahl. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Search, Users } from 'lucide-react';
import type { ChatConversation, ChatUser } from '@kuvert/shared';
import { Avatar, Input } from '@/components/ui';
import { cn, colorFromString } from '@/lib/utils';
import { otherMember } from './api';

/* ───────────────────────────── Avatare ───────────────────────────── */

export function PresenceDot({ online, size = 10 }: { online: boolean; size?: number }) {
  return (
    <span
      className={cn('absolute bottom-0 right-0 block rounded-full ring-2 ring-surface', online ? 'bg-success' : 'bg-border-strong')}
      style={{ width: size, height: size }}
      title={online ? 'Online' : 'Offline'}
    >
      <span className="sr-only">{online ? 'online' : 'offline'}</span>
    </span>
  );
}

export function UserAvatar({ user, size = 36, presence = true }: { user?: ChatUser; size?: number; presence?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={user?.name ?? '?'} email={user?.email} src={user?.avatarUrl} size={size} />
      {presence && user && !user.disabled && <PresenceDot online={user.online} size={Math.max(8, Math.round(size * 0.28))} />}
    </span>
  );
}

export function GroupAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const base = colorFromString(name || 'Gruppe');
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-xl text-white ring-1 ring-black/5"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 65%, #000))` }}
      aria-hidden
    >
      <Users style={{ width: size * 0.48, height: size * 0.48 }} />
    </span>
  );
}

export function ConversationAvatar({ conversation, users, me, size = 40 }: { conversation: ChatConversation; users: Map<string, ChatUser>; me?: string; size?: number }) {
  if (conversation.kind === 'group') return <GroupAvatar name={conversation.name ?? ''} size={size} />;
  const other = otherMember(conversation, me);
  return <UserAvatar user={other ? users.get(other) : undefined} size={size} />;
}

/* ───────────────────────────── Popover ───────────────────────────── */

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = 'top',
  align = 'left',
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  side?: 'top' | 'bottom';
  align?: 'left' | 'right';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onOpenChange(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger}
      {open && (
        <div
          className={cn(
            'absolute z-40 animate-scale-in rounded-xl border border-border bg-surface p-2 shadow-pop',
            side === 'top' ? 'bottom-full mb-1.5 origin-bottom' : 'top-full mt-1.5 origin-top',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Emojis ───────────────────────────── */

export const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎', '🤓',
  '🤔', '🤨', '😐', '🙄', '😏', '😬', '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯',
  '😴', '🤒', '🤗', '🤫', '🙈', '🙏', '👍', '👎', '👌', '✌️', '🤞', '👏', '🙌', '💪', '👋', '🤝',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '🔥', '✨', '⭐', '🎉', '🎂', '🎁', '☕', '🍕',
  '✅', '❌', '⚠️', '❗', '❓', '💡', '📌', '📎', '📅', '⏰', '🚀', '💯', '👀', '🤷', '🫡', '🥳',
];

export function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="grid w-[288px] grid-cols-8 gap-0.5">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-transform hover:scale-110 hover:bg-hover"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────────── Personenauswahl ───────────────────────────── */

export function UserPicker({
  users,
  exclude = [],
  selected,
  onToggle,
  multi,
  autoFocus,
  hideSearch,
}: {
  users: ChatUser[];
  exclude?: string[];
  selected: string[];
  onToggle: (id: string) => void;
  multi?: boolean;
  autoFocus?: boolean;
  /** Suche erfolgt außerhalb (z. B. beim verbundenen Dienst) */
  hideSearch?: boolean;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const term = q.trim().toLocaleLowerCase('de');
    return users
      .filter((u) => !u.disabled && !exclude.includes(u.id))
      .filter((u) => !term || `${u.name} ${u.email} ${u.department ?? ''} ${u.jobTitle ?? ''}`.toLocaleLowerCase('de').includes(term))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'de'));
  }, [users, exclude, q]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {!hideSearch && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Name, E-Mail oder Abteilung" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
        </div>
      )}
      <div className="max-h-[min(50vh,360px)] min-h-24 overflow-auto rounded-xl border border-border">
        {list.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted">{users.length <= 1 && !hideSearch ? 'Noch keine weiteren Benutzer in dieser Kuvert-Instanz' : 'Keine Treffer'}</div>
        ) : (
          list.map((u) => {
            const isSel = selected.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onToggle(u.id)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-hover',
                  isSel && 'bg-primary-soft hover:bg-primary-soft',
                )}
              >
                <UserAvatar user={u} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{u.name}</span>
                  <span className="block truncate text-xs text-muted">{[u.jobTitle, u.department].filter(Boolean).join(' · ') || u.email}</span>
                </span>
                {multi && (
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                      isSel ? 'border-primary bg-primary text-white' : 'border-border-strong',
                    )}
                  >
                    {isSel && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
