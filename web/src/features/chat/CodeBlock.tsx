/**
 * Codeblock in Chat-Nachrichten und KI-Antworten: Kopfzeile mit Sprache (```json) und Kopierknopf.
 * Farben über currentColor, damit der Block in eigenen (farbigen) und fremden Blasen passt.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/** compact: kleinere Schrift, dezenter Hintergrund, ohne Außenabstand (KI-Antworten) */
export function CodeBlock({ code, lang, compact }: { code: string; lang?: string; compact?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  return (
    <div className={cn('overflow-hidden rounded-lg', compact ? 'bg-black/5 dark:bg-white/5' : 'my-1 bg-black/10 dark:bg-white/10')}>
      <div className="flex h-7 items-center gap-2 border-b border-current/10 pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-60">{lang || 'Code'}</span>
        <button
          type="button"
          onClick={copy}
          title="Code kopieren"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium opacity-70 transition hover:bg-black/[.07] hover:opacity-100 dark:hover:bg-white/10"
        >
          {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {done ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
      <pre className={cn('overflow-x-auto whitespace-pre px-3 py-2 font-mono leading-relaxed', compact ? 'text-xs' : 'text-[12.5px]')}>{code}</pre>
    </div>
  );
}
