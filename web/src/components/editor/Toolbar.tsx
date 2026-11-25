import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Code,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Field, Input, Modal } from '@/components/ui';

const FONTS = [
  { label: 'Standard', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Carlito, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", Roboto, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

const SIZES = ['', '10px', '12px', '13px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'];

const COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#c00000', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b',
  '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#546e7a',
];

const HIGHLIGHTS = ['#fff59d', '#ffe082', '#c5e1a5', '#b3e5fc', '#f8bbd0', '#e1bee7', '#ffccbc', '#e0e0e0'];

function TB({ active, onClick, label, children, disabled }: { active?: boolean; onClick: () => void; label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded text-fg/80 hover:bg-hover disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4',
        active && 'bg-primary-soft text-primary',
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-5 w-px bg-border" />;
}

/** Kleines Popover für Farbauswahl */
function Popover({ trigger, children, label }: { trigger: ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <TB label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </TB>
      {open && <div className="absolute left-0 top-8 z-50 rounded-lg border border-border bg-surface p-2 shadow-xl">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function Swatches({ colors, onPick, onClear, clearLabel }: { colors: string[]; onPick: (c: string) => void; onClear: () => void; clearLabel: string }) {
  return (
    <div className="w-44">
      <div className="grid grid-cols-6 gap-1">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            className="h-6 w-6 rounded border border-border"
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <button type="button" onClick={onClear} className="mt-2 w-full rounded px-2 py-1 text-left text-xs text-muted hover:bg-hover">
        {clearLabel}
      </button>
    </div>
  );
}

export function EditorToolbar({
  editor,
  minimal,
  extras,
  onImage,
}: {
  editor: Editor;
  minimal?: boolean;
  extras?: ReactNode;
  onImage: () => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      left: e.isActive({ textAlign: 'left' }),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      justify: e.isActive({ textAlign: 'justify' }),
      font: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const block = s.h1 ? 'h1' : s.h2 ? 'h2' : s.h3 ? 'h3' : 'p';
  const setBlock = (v: string) => {
    const c = editor.chain().focus();
    if (v === 'p') c.setParagraph().run();
    else c.toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
  };

  const openLink = () => {
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '');
    setLinkOpen(true);
  };
  const applyLink = () => {
    const url = linkUrl.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) chain.unsetLink().run();
    else {
      const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : url.includes('@') && !url.includes('/') ? `mailto:${url}` : `https://${url}`;
      if (editor.state.selection.empty && !s.link) {
        editor.chain().focus().insertContent(`<a href="${href.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`).run();
      } else chain.setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const selectCls = 'h-7 rounded border border-transparent bg-transparent px-1 text-xs text-fg hover:border-border focus:border-primary focus:outline-none';

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface px-2 py-1">
      <TB label="Rückgängig (Strg+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!s.canUndo}>
        <Undo2 />
      </TB>
      <TB label="Wiederholen (Strg+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={!s.canRedo}>
        <Redo2 />
      </TB>
      <Sep />
      {!minimal && (
        <select className={selectCls} value={block} onChange={(e) => setBlock(e.target.value)} title="Absatzformat">
          <option value="p">Absatz</option>
          <option value="h1">Überschrift 1</option>
          <option value="h2">Überschrift 2</option>
          <option value="h3">Überschrift 3</option>
        </select>
      )}
      <select
        className={cn(selectCls, 'max-w-28')}
        value={s.font}
        title="Schriftart"
        onChange={(e) => (e.target.value ? editor.chain().focus().setFontFamily(e.target.value).run() : editor.chain().focus().unsetFontFamily().run())}
      >
        {FONTS.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className={selectCls}
        value={s.size}
        title="Schriftgröße"
        onChange={(e) => (e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run())}
      >
        {SIZES.map((sz) => (
          <option key={sz} value={sz}>
            {sz ? sz.replace('px', '') : 'Größe'}
          </option>
        ))}
      </select>
      <Sep />
      <TB label="Fett (Strg+B)" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold />
      </TB>
      <TB label="Kursiv (Strg+I)" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic />
      </TB>
      <TB label="Unterstrichen (Strg+U)" active={s.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline />
      </TB>
      {!minimal && (
        <TB label="Durchgestrichen" active={s.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough />
        </TB>
      )}
      <Popover label="Textfarbe" trigger={<Baseline />}>
        {(close) => (
          <Swatches
            colors={COLORS}
            clearLabel="Standardfarbe"
            onPick={(c) => {
              editor.chain().focus().setColor(c).run();
              close();
            }}
            onClear={() => {
              editor.chain().focus().unsetColor().run();
              close();
            }}
          />
        )}
      </Popover>
      <Popover label="Hervorheben" trigger={<Highlighter />}>
        {(close) => (
          <Swatches
            colors={HIGHLIGHTS}
            clearLabel="Keine Hervorhebung"
            onPick={(c) => {
              editor.chain().focus().setHighlight({ color: c }).run();
              close();
            }}
            onClear={() => {
              editor.chain().focus().unsetHighlight().run();
              close();
            }}
          />
        )}
      </Popover>
      <Sep />
      <TB label="Aufzählung" active={s.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List />
      </TB>
      <TB label="Nummerierung" active={s.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered />
      </TB>
      {!minimal && (
        <>
          <TB label="Linksbündig" active={s.left} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
            <AlignLeft />
          </TB>
          <TB label="Zentriert" active={s.center} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
            <AlignCenter />
          </TB>
          <TB label="Rechtsbündig" active={s.right} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
            <AlignRight />
          </TB>
          <TB label="Blocksatz" active={s.justify} onClick={() => editor.chain().focus().setTextAlign('justify').run()}>
            <AlignJustify />
          </TB>
        </>
      )}
      <Sep />
      <TB label="Link (Strg+K)" active={s.link} onClick={openLink}>
        <Link2 />
      </TB>
      <TB label="Bild einfügen" onClick={onImage}>
        <ImagePlus />
      </TB>
      {!minimal && (
        <>
          <TB label="Tabelle einfügen" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            <TableIcon />
          </TB>
          <TB label="Zitat" active={s.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote />
          </TB>
          <TB label="Code" active={s.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code />
          </TB>
          <TB label="Trennlinie" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus />
          </TB>
        </>
      )}
      <TB label="Formatierung entfernen" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting />
      </TB>
      {s.table && (
        <>
          <Sep />
          <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-hover" onClick={() => editor.chain().focus().addRowAfter().run()}>
            + Zeile
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-hover" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            + Spalte
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-hover" onClick={() => editor.chain().focus().deleteRow().run()}>
            − Zeile
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-hover" onClick={() => editor.chain().focus().deleteColumn().run()}>
            − Spalte
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-hover" onClick={() => editor.chain().focus().deleteTable().run()}>
            Tabelle löschen
          </button>
        </>
      )}
      {extras && (
        <>
          <Sep />
          <div className="flex items-center gap-0.5">{extras}</div>
        </>
      )}

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        size="sm"
        title="Link"
        footer={
          <>
            {s.link && (
              <Button
                variant="ghost"
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                Link entfernen
              </Button>
            )}
            <Button onClick={() => setLinkOpen(false)}>Abbrechen</Button>
            <Button variant="primary" onClick={applyLink}>
              Übernehmen
            </Button>
          </>
        }
      >
        <Field label="Adresse (URL oder E-Mail)">
          <Input
            autoFocus
            value={linkUrl}
            placeholder="https://…"
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
          />
        </Field>
      </Modal>
    </div>
  );
}
