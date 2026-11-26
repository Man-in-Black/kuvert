// Mitgelieferte Emoji-Schrift: Ohne installierte Emoji-Schrift (typisch auf Linux)
// erscheinen 📞 💬 🌐 📅 sonst als leere Kästchen. Die Schrift ist nach
// unicode-range aufgeteilt, geladen werden nur die Teile, die tatsächlich vorkommen.
import emojiFontFaces from '@fontsource/noto-color-emoji/index.css?inline';

/** @font-face-Regeln der Emoji-Schrift (für eigenständige Dokumente wie den Mail-iframe) */
export const EMOJI_FONT_FACES = emojiFontFaces;

/** Systemeigene Emoji-Schriften zuerst, sonst die mitgelieferte */
export const EMOJI_FONT_STACK = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";

// Emoji, die von sich aus bunt dargestellt werden, oder per U+FE0F dazu gemacht
// sind, samt Hautton, ZWJ-Folgen und Tag-Sequenzen. Reine Textsymbole wie ©, ™
// oder ✉ ohne U+FE0F bleiben in der Schrift der Mail.
const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[#*0-9]\uFE0F?\u20E3)(?:\p{Emoji_Modifier}|\uFE0F|[\u{E0020}-\u{E007F}]|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

const SKIP = new Set(['STYLE', 'SCRIPT', 'TEXTAREA', 'TITLE', 'NOSCRIPT']);

/**
 * Umschließt Emoji im Dokument mit <span class="…">. Nötig, weil Mails (v. a.
 * Signaturen) fast immer eine eigene font-family setzen – der Browser greift
 * dann nicht auf die Emoji-Schrift der Seite zurück, nur auf Systemschriften.
 */
export function wrapEmoji(doc: Document, className: string): void {
  const root = doc.body;
  if (!root) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement && SKIP.has(t.parentElement.tagName)) continue;
    // search() statt test(): lässt lastIndex der globalen RegExp unberührt
    if (t.data.search(EMOJI_RE) >= 0) nodes.push(t);
  }
  for (const node of nodes) {
    const text = node.data;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(EMOJI_RE)) {
      const i = m.index!;
      if (i > last) frag.appendChild(doc.createTextNode(text.slice(last, i)));
      const span = doc.createElement('span');
      span.className = className;
      span.textContent = m[0];
      frag.appendChild(span);
      last = i + m[0].length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}
