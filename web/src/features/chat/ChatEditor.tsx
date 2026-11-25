/**
 * WYSIWYG-Eingabe des Chats (TipTap). Markdown-Kürzel werden beim Tippen direkt
 * umgesetzt (**fett**, _kursiv_, ~~durch~~, `Code`, ``` Codeblock, > Zitat, - / 1. Liste),
 * gespeichert wird weiterhin Markdown (editorToMarkdown).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { EditorContent, Extension, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Bold, Code, Italic, Link as LinkIcon, List, ListOrdered, Quote, SquareCode, Strikethrough } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Popover } from './components';
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
}

export const ChatEditor = forwardRef<ChatEditorHandle, Props>(function ChatEditor(p, ref) {
  // Aktuelle Callbacks für die einmal erzeugten TipTap-Erweiterungen
  const cb = useRef(p);
  cb.current = p;

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
    },
  });

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

  return <EditorContent editor={editor} className="chat-editor max-h-[220px] min-h-[36px] flex-1 overflow-y-auto px-1.5 py-[7px] text-[14px] leading-[1.45]" />;
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
