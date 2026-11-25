/**
 * WYSIWYG-Editor (TipTap v3) für E-Mails, Signaturen und Vorlagen.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { toast } from 'sonner';
import { errorMessage, uploadFile } from '@/lib/api';
import { cn } from '@/lib/utils';
import { buildExtensions } from './extensions';
import { EditorToolbar } from './Toolbar';
import './editor.css';

export interface RichEditorProps {
  /** HTML-Inhalt (initial bzw. kontrolliert) */
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Kompakte Werkzeugleiste (z. B. für Signaturen) */
  minimal?: boolean;
  /** Zusätzliche Elemente am Ende der Werkzeugleiste (KI, Teams …) */
  toolbarExtras?: ReactNode;
  /** Zugriff auf die TipTap-Instanz */
  onEditorReady?: (editor: Editor) => void;
  autoFocus?: boolean;
  className?: string;
  /** Mindesthöhe des Schreibbereichs in px */
  minHeight?: number;
  /**
   * Wie eingefügte Bilder gespeichert werden:
   *  - "upload": Upload auf den Server (/api/uploads/<id>?inline=1), wird beim Senden zu cid: umgewandelt
   *  - "dataurl": direkt als data:-URL eingebettet (dauerhaft, z. B. für Signaturen/Vorlagen)
   * Standard: "upload", bei minimal: "dataurl"
   */
  imageMode?: 'upload' | 'dataurl';
  /** Nicht-Bild-Dateien, die in den Editor gezogen wurden (z. B. als Anhang übernehmen) */
  onFilesDropped?: (files: File[]) => void;
  /** Werkzeugleiste ausblenden */
  hideToolbar?: boolean;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function RichEditor({
  value,
  onChange,
  placeholder,
  minimal,
  toolbarExtras,
  onEditorReady,
  autoFocus,
  className,
  minHeight = 200,
  imageMode,
  onFilesDropped,
  hideToolbar,
}: RichEditorProps) {
  const lastEmitted = useRef<string>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const filesDroppedRef = useRef(onFilesDropped);
  filesDroppedRef.current = onFilesDropped;
  const mode = imageMode ?? (minimal ? 'dataurl' : 'upload');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const editorRef = useRef<Editor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const insertImages = async (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    for (const f of files) {
      try {
        const src =
          modeRef.current === 'dataurl' ? await readAsDataUrl(f) : `/api/uploads/${(await uploadFile(f, f.name)).id}?inline=1`;
        const chain = ed.chain().focus();
        if (pos !== undefined) chain.insertContentAt(pos, { type: 'image', attrs: { src, alt: f.name } }).run();
        else chain.setImage({ src, alt: f.name }).run();
      } catch (err) {
        toast.error(`Bild konnte nicht eingefügt werden: ${errorMessage(err)}`);
      }
    }
  };
  const insertImagesRef = useRef(insertImages);
  insertImagesRef.current = insertImages;

  const extensions = useMemo(() => buildExtensions(placeholder), [placeholder]);

  const editor = useEditor({
    extensions,
    content: value || '',
    autofocus: autoFocus ? 'start' : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'kuvert-mail-content', spellcheck: 'true' },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        void insertImagesRef.current(files);
        return true;
      },
      handleDrop(view, event) {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        const images = files.filter((f) => f.type.startsWith('image/'));
        const others = files.filter((f) => !f.type.startsWith('image/'));
        const coords = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        if (images.length) void insertImagesRef.current(images, coords?.pos);
        if (others.length) filesDroppedRef.current?.(others);
        return true;
      },
      handleKeyDown(_view, event) {
        // Strg+K → Link-Dialog: wird über die Werkzeugleiste gelöst; hier nur Browser-Default verhindern
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate({ editor: e }) {
      const html = e.getHTML();
      lastEmitted.current = html;
      onChangeRef.current(html);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) onEditorReady?.(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Kontrollierter Wert: nur übernehmen, wenn er sich von außen geändert hat
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmitted.current) return;
    if (value === editor.getHTML()) {
      lastEmitted.current = value;
      return;
    }
    lastEmitted.current = value;
    editor.commands.setContent(value || '', { emitUpdate: false });
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div className={cn('kuvert-editor flex min-h-0 flex-col', className)}>
      {!hideToolbar && <EditorToolbar editor={editor} minimal={minimal} extras={toolbarExtras} onImage={() => fileInput.current?.click()} />}
      <div className="min-h-0 flex-1 cursor-text overflow-auto" onClick={() => !editor.isFocused && editor.commands.focus()}>
        <EditorContent editor={editor} style={{ minHeight }} className="h-full [&_.ProseMirror]:h-full" />
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void insertImages(files);
        }}
      />
    </div>
  );
}
