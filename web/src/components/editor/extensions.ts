/**
 * TipTap-Erweiterungen für den Mail-Editor.
 */
import { Node, mergeAttributes, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Image } from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';

/**
 * Signatur-Block: <div data-signature="true">…</div>.
 * Bleibt beim Bearbeiten erhalten, damit der Composer die Signatur beim
 * Absenderwechsel gezielt austauschen kann.
 */
export const SignatureBlock = Node.create({
  name: 'signatureBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: false,
  parseHTML() {
    return [{ tag: 'div[data-signature]', priority: 100 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-signature': 'true', class: 'kuvert-signature' }), 0];
  },
});

/**
 * Allgemeiner Div-Container (z. B. aus eingefügten HTML-Inhalten), damit
 * Strukturen nicht komplett verloren gehen. Wird nach Signatur geprüft.
 */
export const GenericDiv = Node.create({
  name: 'genericDiv',
  group: 'block',
  content: 'block+',
  parseHTML() {
    return [{ tag: 'div', priority: 10 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', HTMLAttributes, 0];
  },
});

/** Bild mit erhaltenen width/height/style-Attributen */
const MailImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null },
      height: { default: null },
      style: { default: null },
    };
  },
});

export function buildExtensions(placeholder?: string): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    MailImage.configure({ inline: true, allowBase64: true }),
    Table.configure({ resizable: false, HTMLAttributes: { class: 'kuvert-table' } }),
    TableRow,
    TableHeader,
    TableCell,
    SignatureBlock,
    GenericDiv,
    Placeholder.configure({ placeholder: placeholder ?? 'Nachricht schreiben …' }),
  ];
}
