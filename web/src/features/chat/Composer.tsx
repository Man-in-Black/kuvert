import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ALargeSmall, File as FileIcon, Loader2, Paperclip, Pencil, Reply, SendHorizontal, Smile, X } from 'lucide-react';
import type { ChatBridgeType, ChatCapabilities, ChatConversation, ChatMessage, ChatUser, UploadInfo } from '@kuvert/shared';
import { Button, IconButton } from '@/components/ui';
import { errorMessage, uploadFile } from '@/lib/api';
import { cn, formatSize } from '@/lib/utils';
import { FULL_CAPS, applyNewMessage, chatApi, drafts, upsertMessage, useChatSettings, useParticipants, userName } from './api';
import type { Editor } from '@tiptap/react';
import { ChatEditor, FormatBar, type ChatEditorHandle, type MentionItem } from './ChatEditor';
import { EmojiGrid, Popover } from './components';
import { bodyOf, previewOf } from './format';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MAX_FILES = 10;
const MAX_LENGTH = 10_000;
const TOOLBAR_KEY = 'kuvert.chat.formatbar';

/** Erwähnungen für alle, je nach Dienst (Teams-Chats kennen keine) */
function allMentions(kind: ChatConversation['kind'], source: ChatBridgeType | undefined): MentionItem[] {
  if (kind !== 'group' || source === 'teams') return [];
  const all: MentionItem = { handle: 'all', label: 'Alle', detail: '@all' };
  if (source !== 'mattermost') return [all];
  return [
    { ...all, label: 'Alle Mitglieder' },
    { handle: 'channel', label: 'Alle im Kanal', detail: '@channel' },
    { handle: 'here', label: 'Alle, die online sind', detail: '@here' },
  ];
}

interface PendingFile {
  key: string;
  name: string;
  size: number;
  progress: number;
  upload?: UploadInfo;
  error?: string;
}

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

interface Props {
  conversationId: string;
  me: string | undefined;
  users: Map<string, ChatUser>;
  replyTo: ChatMessage | null;
  onCancelReply(): void;
  editing: ChatMessage | null;
  onCancelEdit(): void;
  /** Pfeil nach oben im leeren Feld → letzte eigene Nachricht bearbeiten */
  onEditLast(): void;
  /** Nach dem Senden ans Ende scrollen */
  onSent(): void;
  /** Möglichkeiten der Unterhaltung (Dateien, Tippen …) */
  caps?: ChatCapabilities;
  /** Art und Herkunft der Unterhaltung (für @-Erwähnungen) */
  kind: ChatConversation['kind'];
  source?: ChatBridgeType;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(p, ref) {
  const qc = useQueryClient();
  const { settings } = useChatSettings();
  /** Aktueller Inhalt als Markdown */
  const [text, setText] = useState(() => drafts.get(p.conversationId) ?? '');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showFormat, setShowFormat] = useState(() => {
    try {
      return localStorage.getItem(TOOLBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const editorRef = useRef<ChatEditorHandle>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const stash = useRef<string | null>(null);

  // @-Erwähnungen: Mitglieder erst laden, wenn jemand @ tippt
  const [mentionOn, setMentionOn] = useState(false);
  const { data: participants } = useParticipants(p.conversationId, mentionOn);
  const mentions = useMemo<MentionItem[] | null>(() => {
    if (!participants) return null;
    const people = participants
      .filter((u) => u.id !== p.me && u.mention && !u.disabled)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'de'))
      .map((u): MentionItem => ({ handle: u.mention!, label: u.name, detail: `@${u.mention}`, user: u }));
    return [...allMentions(p.kind, p.source), ...people];
  }, [participants, p.me, p.kind, p.source]);

  // Entwurf merken
  useEffect(() => {
    if (p.editing) return;
    if (text) drafts.set(p.conversationId, text);
    else drafts.delete(p.conversationId);
  }, [text, p.conversationId, p.editing]);

  // Bearbeiten: Text übernehmen, beim Beenden den vorherigen Entwurf zurückholen
  useEffect(() => {
    if (p.editing) {
      stash.current ??= text;
      editorRef.current?.setMarkdown(p.editing.body);
    } else if (stash.current !== null) {
      editorRef.current?.setMarkdown(stash.current);
      stash.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.editing?.id]);

  useEffect(() => {
    if (p.replyTo) editorRef.current?.focus();
  }, [p.replyTo?.id]);

  const caps = p.caps ?? FULL_CAPS;
  const addFiles = (files: File[]) => {
    if (!caps.files) {
      if (files.length) toast.info('In dieser Unterhaltung können keine Dateien gesendet werden');
      return;
    }
    const room = MAX_FILES - pending.length;
    if (files.length > room) toast.warning(`Höchstens ${MAX_FILES} Dateien pro Nachricht`);
    for (const file of files.slice(0, Math.max(room, 0))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const name = file.name || (file.type.startsWith('image/') ? `Bild-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${file.type.split('/')[1] ?? 'png'}` : 'Datei');
      setPending((list) => [...list, { key, name, size: file.size, progress: 0 }]);
      uploadFile(file, name, (pct) => setPending((list) => list.map((x) => (x.key === key ? { ...x, progress: pct } : x))))
        .then((upload) => setPending((list) => list.map((x) => (x.key === key ? { ...x, upload, progress: 100 } : x))))
        .catch((err) => setPending((list) => list.map((x) => (x.key === key ? { ...x, error: errorMessage(err) } : x))));
    }
    editorRef.current?.focus();
  };

  useImperativeHandle(ref, () => ({ addFiles, focus: () => editorRef.current?.focus() }));

  const uploading = pending.some((x) => !x.upload && !x.error);
  const ready = pending.filter((x) => x.upload);
  const canSend = !uploading && !saving && (p.editing ? true : !!text.trim() || ready.length > 0);

  const onChange = (value: string) => {
    setText(value);
    if (!value.trim() || p.editing || !caps.typing) return;
    const now = Date.now();
    if (now - lastTyping.current < 3000) return;
    lastTyping.current = now;
    void chatApi.typing(p.conversationId).catch(() => undefined);
  };

  const submit = async () => {
    if (!canSend) return;
    if (text.length > MAX_LENGTH) {
      toast.error(`Die Nachricht ist zu lang (max. ${MAX_LENGTH.toLocaleString('de')} Zeichen)`);
      return;
    }
    if (p.editing) {
      const target = p.editing;
      if (text === target.body) {
        p.onCancelEdit();
        return;
      }
      setSaving(true);
      try {
        upsertMessage(qc, await chatApi.edit(target.id, text));
        p.onCancelEdit();
      } catch (err) {
        toast.error(`Speichern fehlgeschlagen: ${errorMessage(err)}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    const body = text;
    const files = pending;
    const reply = p.replyTo;
    editorRef.current?.clear();
    setText('');
    setPending([]);
    p.onCancelReply();
    lastTyping.current = 0;
    try {
      const msg = await chatApi.send(p.conversationId, body, { replyToId: reply?.id, uploadIds: files.filter((x) => x.upload).map((x) => x.upload!.id) });
      upsertMessage(qc, msg);
      applyNewMessage(qc, msg, p.me, false);
      p.onSent();
    } catch (err) {
      toast.error(`Senden fehlgeschlagen: ${errorMessage(err)}`);
      if (editorRef.current?.editor?.isEmpty) editorRef.current.setMarkdown(body);
      setPending((list) => (list.length ? list : files));
    }
  };

  // Aktuelle Fassung für die Tastenkürzel des Editors
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const toggleFormat = () =>
    setShowFormat((v) => {
      try {
        localStorage.setItem(TOOLBAR_KEY, v ? '0' : '1');
      } catch {
        /* egal */
      }
      return !v;
    });

  const hint = settings.enterToSend ? 'Enter senden · Umschalt+Enter neue Zeile' : `${isMac ? '⌘' : 'Strg'}+Enter senden`;

  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-5">
      {(p.replyTo || p.editing) && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-[3px] border-primary bg-surface-2 px-3 py-1.5 text-xs">
          {p.editing ? <Pencil className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Reply className="h-3.5 w-3.5 shrink-0 text-primary" />}
          <span className="min-w-0 flex-1 truncate">
            {p.editing ? (
              <span className="font-medium">Nachricht bearbeiten</span>
            ) : (
              <>
                <span className="font-medium">Antwort an {userName(p.replyTo!.senderId, p.users, p.me)}: </span>
                <span className="text-muted">{previewOf(bodyOf(p.replyTo!), p.replyTo!.attachments.length)}</span>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={p.editing ? p.onCancelEdit : p.onCancelReply}
            className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
            aria-label="Abbrechen"
            title="Abbrechen (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pending.map((f) => (
            <div
              key={f.key}
              className={cn(
                'relative flex max-w-[240px] items-center gap-2 overflow-hidden rounded-lg border bg-surface-2 py-1.5 pl-2 pr-1 text-xs',
                f.error ? 'border-danger/50 text-danger' : 'border-border',
              )}
              title={f.error ?? f.name}
            >
              {!f.upload && !f.error ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" /> : <FileIcon className="h-4 w-4 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{f.name}</span>
                <span className="block text-[10.5px] text-muted">{f.error ? 'Upload fehlgeschlagen' : f.upload ? formatSize(f.size) : `${f.progress} %`}</span>
              </span>
              <button
                type="button"
                className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                onClick={() => setPending((list) => list.filter((x) => x.key !== f.key))}
                aria-label={`${f.name} entfernen`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              {!f.upload && !f.error && <span className="absolute bottom-0 left-0 h-0.5 bg-primary transition-all" style={{ width: `${f.progress}%` }} />}
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-input-border bg-input transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-glow">
        {showFormat && <FormatBar editor={editor} />}
        <div className="flex items-end gap-1 py-1 pl-1 pr-1">
          {!p.editing && caps.files && (
            <IconButton label="Datei anhängen" size="icon-sm" className="mb-0.5 h-8 w-8" onClick={() => fileInput.current?.click()}>
              <Paperclip className="h-[18px] w-[18px]" />
            </IconButton>
          )}
          <IconButton label={showFormat ? 'Formatierung ausblenden' : 'Formatierung'} size="icon-sm" className={cn('mb-0.5 h-8 w-8', showFormat && 'text-primary')} onClick={toggleFormat}>
            <ALargeSmall className="h-[18px] w-[18px]" />
          </IconButton>
          <Popover
            open={emojiOpen}
            onOpenChange={setEmojiOpen}
            side="top"
            trigger={
              <IconButton label="Emoji einfügen" size="icon-sm" className="mb-0.5 h-8 w-8" onClick={() => setEmojiOpen((o) => !o)}>
                <Smile className="h-[18px] w-[18px]" />
              </IconButton>
            }
          >
            <EmojiGrid
              onPick={(emoji) => {
                setEmojiOpen(false);
                editorRef.current?.insertText(emoji);
              }}
            />
          </Popover>
          <ChatEditor
            ref={editorRef}
            initialMarkdown={text}
            placeholder={p.editing ? 'Nachricht bearbeiten …' : 'Nachricht schreiben …'}
            enterToSend={settings.enterToSend}
            onChange={onChange}
            onSubmit={() => void submitRef.current()}
            onEscape={() => {
              if (p.editing) p.onCancelEdit();
              else if (p.replyTo) p.onCancelReply();
              else return false;
              return true;
            }}
            onArrowUpEmpty={() => {
              if (p.editing || pending.length) return false;
              p.onEditLast();
              return true;
            }}
            onFiles={addFiles}
            onReady={setEditor}
            mentions={mentions}
            onMentionStart={() => setMentionOn(true)}
          />
          <Button
            variant="primary"
            size="icon"
            className="mb-0.5 h-8 w-8 rounded-xl"
            disabled={!canSend}
            loading={saving}
            onClick={() => void submit()}
            title={p.editing ? 'Speichern' : 'Senden'}
            aria-label={p.editing ? 'Speichern' : 'Senden'}
            icon={saving ? undefined : <SendHorizontal className="h-4 w-4" />}
          />
        </div>
      </div>
      <div className="mt-1 hidden justify-between gap-3 px-1 text-[11px] text-subtle sm:flex">
        <span>{hint}</span>
        <span>
          Markdown wird direkt umgesetzt: <span className="font-mono">**fett**</span> <span className="font-mono">_kursiv_</span> <span className="font-mono">`Code`</span>{' '}
          <span className="font-mono">&gt; Zitat</span> <span className="font-mono">- Liste</span>
        </span>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
});
