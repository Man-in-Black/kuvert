import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Isolierte Darstellung von Mail-HTML: sandboxed iframe OHNE Skripte
 * (allow-same-origin nur für die Höhenberechnung, Links öffnen in neuem Tab).
 */
export function MailFrame({
  srcDoc,
  className,
  minHeight = 60,
  maxHeight,
  title = 'Nachrichteninhalt',
}: {
  srcDoc: string;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
  title?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  // Das zu messende Dokument. Gesetzt, sobald das srcdoc geparst ist (siehe unten),
  // spätestens aber über den onLoad-Prop: React hängt diesen Listener schon beim
  // Anlegen des iframes an, ein schnelles srcdoc-Laden geht so nicht verloren.
  const [loadedDoc, setLoadedDoc] = useState<Document | null>(null);

  // 'load' feuert erst, wenn ALLE Unterressourcen da sind – externe Bilder,
  // Tracking-Pixel, Remote-CSS, Webfonts. Hängt davon eines, bliebe der Rahmen
  // so lange auf minHeight. Deshalb pro Frame nachsehen, ob das neue Dokument
  // schon geparst ist (readyState ≠ 'loading', entspricht DOMContentLoaded), und
  // dann sofort messen; Nachladendes fängt der ResizeObserver ab.
  useLayoutEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    // Vor der srcdoc-Navigation (die läuft asynchron) steht hier noch das alte
    // Dokument bzw. das initiale about:blank – darauf warten wir nicht.
    const previous = iframe.contentDocument;
    let raf = 0;
    const poll = () => {
      const doc = iframe.contentDocument;
      if (doc && doc !== previous && doc.readyState !== 'loading' && doc.documentElement) {
        setLoadedDoc(doc);
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    const stop = () => cancelAnimationFrame(raf);
    iframe.addEventListener('load', stop);
    return () => {
      stop();
      iframe.removeEventListener('load', stop);
    };
  }, [srcDoc]);

  useEffect(() => {
    const iframe = ref.current;
    const doc = loadedDoc;
    if (!iframe || !doc?.documentElement) return;
    const root = doc.documentElement;
    const measure = () => {
      // Rahmen des iframes und eine evtl. horizontale Scrollleiste: Außenhöhe minus sichtbarer Bereich
      const chrome = Math.max(0, iframe.offsetHeight - root.clientHeight);
      const h = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0) + chrome;
      setHeight(Math.max(minHeight, maxHeight ? Math.min(h, maxHeight) : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    if (doc.body) ro.observe(doc.body);
    const imgs = Array.from(doc.querySelectorAll('img'));
    imgs.forEach((img) => img.addEventListener('load', measure));
    return () => {
      ro.disconnect();
      imgs.forEach((img) => img.removeEventListener('load', measure));
    };
  }, [loadedDoc, minHeight, maxHeight]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={srcDoc}
      onLoad={(e) => setLoadedDoc(e.currentTarget.contentDocument)}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={cn('block w-full border-0 bg-white', className)}
      style={{ height, overflow: maxHeight ? 'auto' : 'hidden' }}
    />
  );
}
