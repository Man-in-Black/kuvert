/**
 * WYSIWYG-Eingabe des Chats (TipTap). Markdown-Kürzel werden beim Tippen direkt
 * umgesetzt (**fett**, _kursiv_, ~~durch~~, `Code`, ``` Codeblock, > Zitat, - / 1. Liste),
 * gespeichert wird weiterhin Markdown (editorToMarkdown).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, Extension, InputRule, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TEXT_SMILEYS, type ChatUser } from '@kuvert/shared';
import { AtSign, Bold, Code, Italic, Link as LinkIcon, List, ListOrdered, Quote, SquareCode, Strikethrough } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Popover, UserAvatar } from './components';
import { editorToMarkdown, markdownToHtml } from './markdown';
import './chat.css';

export interface ChatEditorHandle {
  setMarkdown(md: string): void;
  insertText(text: string): void;
  clear(): void;
  focus(): void;
  editor: Editor | null;
}

interface Props {
  initialMarkdown: string;
  placeholder: string;
  enterToSend: boolean;
  onChange(markdown: string): void;
  onSubmit(): void;
  /** true = verarbeitet (z. B. Antwort/Bearbeiten abgebrochen) */
  onEscape(): boolean;
  /** Pfeil nach oben im leeren Feld; true = verarbeitet */
  onArrowUpEmpty(): boolean;
  onFiles(files: File[]): void;
  /** TipTap-Instanz für die Formatleiste */
  onReady?(editor: Editor | null): void;
  /** Vorschläge für @-Erwähnungen (null = noch nicht geladen) */
  mentions?: MentionItem[] | null;
  /** Ein @ wurde getippt → Vorschläge laden */
  onMentionStart?(): void;
}

/** Eintrag der @-Vorschlagsliste */
export interface MentionItem {
  /** Text nach dem @ */
  handle: string;
  label: string;
  detail?: string;
  user?: ChatUser;
}

interface MentionQuery {
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
}

const MENTION_BEFORE = /(?:^|[\s(])@([\w.+-]*)$/;
const MAX_MENTIONS = 8;

function rankMention(it: MentionItem, q: string): number {
  if (!q) return 1;
  const h = it.handle.replace(/^"/, '').toLowerCase();
  const l = it.label.toLowerCase();
  if (h.startsWith(q)) return 0;
  if (l.startsWith(q) || l.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (h.includes(q) || l.includes(q)) return 2;
  return -1;
}

/** :) ;-) <3 … am Wortanfang beim Tippen durch Emojis ersetzen (Rücktaste macht es rückgängig) */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const SMILEY_CODES = [...TEXT_SMILEYS.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
const SMILEY_RE = new RegExp(`(?:^|\\s)(${SMILEY_CODES.join('|')})$`);

const Smileys = Extension.create({
  name: 'chatSmileys',
  addInputRules() {
    return [
      new InputRule({
        find: SMILEY_RE,
        handler: ({ state, range, match }) => {
          const code = match[1]!;
          const emoji = TEXT_SMILEYS.get(code);
          if (!emoji) return null;
          const start = range.from + match[0].length - code.length;
          state.tr.insertText(emoji, start, range.to);
        },
      }),
    ];
  },
});

export const ChatEditor = forwardRef<ChatEditorHandle, Props>(function ChatEditor(p, ref) {
  // Aktuelle Callbacks für die einmal erzeugten TipTap-Erweiterungen
  const cb = useRef(p);
  cb.current = p;

  /* ─── @-Erwähnungen ─── */
  const [mq, setMq] = useState<MentionQuery | null>(null);
  const [mIndex, setMIndex] = useState(0);
  /** Mit Esc geschlossen – erst bei einem neuen @ wieder anzeigen */
  const dismissed = useRef<number | null>(null);
  const detectMention = (e: Editor) => {
    const sel = e.state.selection;
    if (!sel.empty || e.isActive('code') || e.isActive('codeBlock')) return setMq(null);
    const $from = sel.$from;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 64), $from.parentOffset, undefined, ' ');
    const m = MENTION_BEFORE.exec(before);
    if (!m) {
      dismissed.current = null;
      return setMq(null);
    }
    const from = sel.from - m[1]!.length - 1;
    if (dismissed.current === from) return setMq(null);
    const c = e.view.coordsAtPos(from);
    setMq((cur) => (cur && cur.from === from && cur.query === m[1] ? cur : { query: m[1]!, from, to: sel.from, left: c.left, top: c.top }));
    cb.current.onMentionStart?.();
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        underline: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Placeholder.configure({ placeholder: () => cb.current.placeholder }),
      Smileys,
      // Tasten der Vorschlagsliste vor allen anderen (Enter sendet sonst)
      Extension.create({
        name: 'chatMentionKeys',
        priority: 1100,
        addKeyboardShortcuts() {
          const m = () => mention.current;
          const take = (fn: () => void) => () => {
            if (!m().items.length) return false;
            fn();
            return true;
          };
          return {
            ArrowDown: take(() => m().move(1)),
            ArrowUp: take(() => m().move(-1)),
            Enter: take(() => m().pick()),
            Tab: take(() => m().pick()),
            Escape: take(() => m().close()),
          };
        },
      }),
      Extension.create({
        name: 'chatKeys',
        priority: 1000,
        addKeyboardShortcuts() {
          const inBlock = () => this.editor.isActive('codeBlock') || this.editor.isActive('listItem');
          return {
            Enter: () => {
              // In Listen/Codeblöcken erzeugt Enter eine neue Zeile bzw. einen neuen Punkt
              if (!cb.current.enterToSend || inBlock()) return false;
              cb.current.onSubmit();
              return true;
            },
            // Neue Zeile = neuer Absatz bzw. Listenpunkt, damit "- ", "> " usw. am Zeilenanfang wirken
            'Shift-Enter': () => {
              const e = this.editor;
              if (e.isActive('codeBlock')) return e.commands.newlineInCode();
              if (e.isActive('listItem')) return e.commands.splitListItem('listItem');
              return e.commands.splitBlock();
            },
            'Mod-Enter': () => {
              cb.current.onSubmit();
              return true;
            },
            Escape: () => cb.current.onEscape(),
            ArrowUp: () => (this.editor.isEmpty ? cb.current.onArrowUpEmpty() : false),
          };
        },
      }),
    ],
    content: markdownToHtml(p.initialMarkdown),
    autofocus: 'end',
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'chat-editor-content', 'aria-label': 'Nachricht', spellcheck: 'true' },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || event.clipboardData?.types.includes('text/plain')) return false;
        event.preventDefault();
        cb.current.onFiles(files);
        return true;
      },
      // Dateien übernimmt die Unterhaltungsansicht (Ablegen als Anhang)
      handleDrop: (_view, event) => !!(event as DragEvent).dataTransfer?.files.length,
    },
    onUpdate({ editor: e }) {
      cb.current.onChange(e.isEmpty ? '' : editorToMarkdown(e.getJSON()));
      detectMention(e);
    },
    onSelectionUpdate({ editor: e }) {
      detectMention(e);
    },
    onBlur() {
      setMq(null);
    },
  });

  const items = useMemo(() => {
    if (!mq || !p.mentions?.length) return [];
    const q = mq.query.toLowerCase();
    return p.mentions
      .map((it) => [it, rankMention(it, q)] as const)
      .filter(([, r]) => r >= 0)
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_MENTIONS)
      .map(([it]) => it);
  }, [mq, p.mentions]);

  useEffect(() => setMIndex(0), [mq?.from, mq?.query]);

  const pickMention = (it: MentionItem | undefined) => {
    if (!editor || !mq || !it) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: mq.from, to: mq.to }, { type: 'text', text: `@${it.handle} ` })
      .run();
    setMq(null);
  };
  const mention = useRef({ items, move: (_d: number) => {}, pick: () => {}, close: () => {} });
  mention.current = {
    items,
    move: (d) => setMIndex((i) => (i + d + items.length) % items.length),
    pick: () => pickMention(items[Math.min(mIndex, items.length - 1)]),
    close: () => {
      dismissed.current = mq?.from ?? null;
      setMq(null);
    },
  };

  useEffect(() => {
    cb.current.onReady?.(editor);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      editor,
      setMarkdown(md) {
        editor?.commands.setContent(markdownToHtml(md), { emitUpdate: true });
        editor?.commands.focus('end');
      },
      insertText(text) {
        editor?.chain().focus().insertContent(text).run();
      },
      clear() {
        editor?.commands.clearContent(true);
      },
      focus() {
        editor?.commands.focus();
      },
    }),
    [editor],
  );

  return (
    <>
      <EditorContent editor={editor} className="chat-editor max-h-[220px] min-h-[36px] flex-1 overflow-y-auto px-1.5 py-[7px] text-[14px] leading-[1.45]" />
      {mq &&
        items.length > 0 &&
        createPortal(
          <div
            role="listbox"
            aria-label="Erwähnen"
            className="fixed z-[60] w-72 animate-scale-in overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop origin-bottom-left"
            style={{ left: Math.max(8, Math.min(mq.left - 8, window.innerWidth - 296)), bottom: window.innerHeight - mq.top + 6 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((it, i) => (
              <button
                key={it.handle}
                type="button"
                role="option"
                aria-selected={i === mIndex}
                onMouseEnter={() => setMIndex(i)}
                onClick={() => pickMention(it)}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm', i === mIndex ? 'bg-hover' : '')}
              >
                {it.user ? (
                  <UserAvatar user={it.user} size={24} />
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <AtSign className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{it.label}</span>
                {it.detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">{it.detail}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});

/* ───────────────────────────── Formatleiste ───────────────────────────── */

export function FormatBar({ editor }: { editor: Editor | null }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            link: e.isActive('link'),
            bulletList: e.isActive('bulletList'),
            orderedList: e.isActive('orderedList'),
            blockquote: e.isActive('blockquote'),
            codeBlock: e.isActive('codeBlock'),
          }
        : null,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  if (!editor || !state) return null;

  const btn = (active: boolean, label: string, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors', active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {icon}
    </button>
  );
  const c = () => editor.chain().focus();

  const applyLink = () => {
    const href = url.trim();
    setLinkOpen(false);
    setUrl('');
    if (!href) return;
    const full = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      c().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href: full } }] }).run();
    } else c().extendMarkRange('link').setLink({ href: full }).run();
  };

  const sep = <span className="mx-1 h-4 w-px bg-border" />;
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      {btn(state.bold, 'Fett (Strg+B)', <Bold className="h-4 w-4" />, () => c().toggleBold().run())}
      {btn(state.italic, 'Kursiv (Strg+I)', <Italic className="h-4 w-4" />, () => c().toggleItalic().run())}
      {btn(state.strike, 'Durchgestrichen', <Strikethrough className="h-4 w-4" />, () => c().toggleStrike().run())}
      {btn(state.code, 'Code', <Code className="h-4 w-4" />, () => c().toggleCode().run())}
      <Popover
        open={linkOpen}
        onOpenChange={setLinkOpen}
        side="top"
        trigger={btn(state.link, state.link ? 'Link entfernen' : 'Link einfügen', <LinkIcon className="h-4 w-4" />, () => {
          if (editor.isActive('link')) c().extendMarkRange('link').unsetLink().run();
          else setLinkOpen((o) => !o);
        })}
      >
        <form
          className="flex w-72 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <Input autoFocus placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} className="h-8" />
          <Button type="submit" size="sm" variant="primary">
            OK
          </Button>
        </form>
      </Popover>
      {sep}
      {btn(state.bulletList, 'Aufzählung', <List className="h-4 w-4" />, () => c().toggleBulletList().run())}
      {btn(state.orderedList, 'Nummerierung', <ListOrdered className="h-4 w-4" />, () => c().toggleOrderedList().run())}
      {btn(state.blockquote, 'Zitat', <Quote className="h-4 w-4" />, () => c().toggleBlockquote().run())}
      {btn(state.codeBlock, 'Codeblock', <SquareCode className="h-4 w-4" />, () => c().toggleCodeBlock().run())}
    </div>
  );
}
