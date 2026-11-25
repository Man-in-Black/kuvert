/**
 * HTML-Bereinigung für E-Mail-Inhalte (DOMPurify) und Aufbau des
 * isolierten iframe-Dokuments für die Anzeige.
 */
import DOMPurify from 'dompurify';
import { escapeHtml } from '@/lib/utils';

const FORBID_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link', 'noscript', 'portal'];
const FORBID_ATTR = ['action', 'formaction', 'srcdoc', 'ping'];

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (href && !href.startsWith('#')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

/** Bereinigt ein komplettes Mail-HTML-Dokument (inkl. <style> im <head>). */
export function sanitizeDocument(html: string): Document {
  ensureHooks();
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target'],
    ALLOW_DATA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  }) as unknown as string;
  return new DOMParser().parseFromString(String(clean), 'text/html');
}

/** Bereinigt ein HTML-Fragment (für Zitate, KI-Ausgaben …) */
export function sanitizeFragment(html: string): string {
  ensureHooks();
  return String(
    DOMPurify.sanitize(html, {
      FORBID_TAGS: [...FORBID_TAGS, 'style'],
      FORBID_ATTR,
      ALLOW_DATA_ATTR: true,
    }),
  );
}

/** Enthält das HTML externe Ressourcen (Bilder, Hintergründe, CSS-URLs)? */
export function hasRemoteContent(html: string): boolean {
  return /(src|background|poster)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\//i.test(html);
}

export interface MailDocOptions {
  allowRemote: boolean;
  /** cid → URL der Inline-Anlage */
  cidMap?: Map<string, string>;
  /** Hintergrund weiß erzwingen (Lesbarkeit im Dunkelmodus) */
  extraCss?: string;
}

function normalizeCid(v: string): string {
  try {
    v = decodeURIComponent(v);
  } catch {
    /* kein gültiges Percent-Encoding */
  }
  return v.replace(/^<|>$/g, '').toLowerCase();
}

/** Baut das srcdoc für den sandboxed iframe */
export function buildMailSrcDoc(html: string, opts: MailDocOptions): string {
  const doc = sanitizeDocument(html);

  if (opts.cidMap) {
    // „CID:“ in Großbuchstaben und percent-kodierte Content-IDs (RFC 2392) kommen in der Praxis vor
    doc.querySelectorAll<HTMLElement>('[src^="cid:" i], [background^="cid:" i]').forEach((el) => {
      for (const attr of ['src', 'background']) {
        const v = el.getAttribute(attr)?.trim();
        if (v?.toLowerCase().startsWith('cid:')) {
          const url = opts.cidMap!.get(normalizeCid(v.slice(4)));
          if (url) el.setAttribute(attr, url);
        }
      }
    });
  }

  const imgSrc = opts.allowRemote ? "'self' data: blob: https: http:" : "'self' data: blob:";
  const styleSrc = opts.allowRemote ? "'unsafe-inline' https: http:" : "'unsafe-inline'";
  const fontSrc = opts.allowRemote ? 'data: https:' : 'data:';
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src ${styleSrc}; font-src ${fontSrc}; media-src ${imgSrc};`;

  const head = doc.head;
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', csp);
  head.prepend(meta);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset);
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  head.appendChild(base);
  const style = doc.createElement('style');
  style.textContent = `
    html { background: #ffffff; color: #1f2328; }
    /* Der Rahmen wächst mit dem Inhalt – Höhen relativ zum Fenster (height:100%, 100vh)
       würden die Messung verfälschen bzw. den Rahmen endlos wachsen lassen. */
    html, body { height: auto !important; min-height: 0 !important; }
    body { margin: 0; padding: 16px; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    pre { white-space: pre-wrap; }
    blockquote { margin: 0 0 0 .8ex; border-left: 2px solid #d0d7de; padding-left: 1ex; color: #57606a; }
    a { color: #0969da; }
    ${opts.extraCss ?? ''}
  `;
  head.prepend(style);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** Text → HTML mit klickbaren Links */
export function linkifyText(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/gi,
    (m) => `<a href="${m.startsWith('www.') ? 'https://' + m : m}" target="_blank" rel="noopener noreferrer">${m}</a>`,
  );
}

/** HTML → Klartext (für KI-Kontext, Plaintext-Modus) */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeFragment(html), 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, blockquote').forEach((el) => el.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
