/**
 * Streamt eine KI-Antwort (POST /api/ai/run) und zeigt sie live an.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { AiRequest } from '@kuvert/shared';
import { errorMessage, streamText } from '@/lib/api';
import { useSettings } from '@/lib/queries';
import { Button, Modal, Spinner } from '@/components/ui';
import { sanitizeFragment } from '@/features/mail/sanitize';

/** Entfernt Markdown-Codezäune, die manche Modelle um HTML legen */
export function cleanAiOutput(s: string, html: boolean): string {
  let out = s.trim();
  out = out.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  if (!html) return out.trim();
  // Falls das Modell doch Klartext liefert → Absätze bilden
  if (!/<[a-z][\s\S]*>/i.test(out)) {
    return out
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  return sanitizeFragment(out);
}

export function useAiDefaults() {
  const { settings } = useSettings();
  return { model: settings.ai.model ?? undefined, language: settings.ai.defaultLanguage || 'Deutsch' };
}

export function AiResultModal({
  open,
  title,
  request,
  onClose,
  renderActions,
}: {
  open: boolean;
  title: string;
  request: AiRequest | null;
  onClose: () => void;
  /** Buttons im Fuß, erhalten das fertige Ergebnis (bereinigt) */
  renderActions: (result: string, done: boolean) => ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const html = request?.html !== false;

  useEffect(() => {
    if (!open || !request) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setText('');
    setError(null);
    setBusy(true);
    streamText('/ai/run', request, (full) => setText(full), ctrl.signal)
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [open, request, run]);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const result = cleanAiOutput(text, html);

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" /> {title}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} disabled={busy} onClick={() => setRun((r) => r + 1)} className="mr-auto">
            Neu generieren
          </Button>
          <Button onClick={close}>Verwerfen</Button>
          {renderActions(result, !busy && !error && !!text)}
        </>
      }
    >
      {error ? (
        <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">KI-Anfrage fehlgeschlagen: {error}</div>
      ) : !text && busy ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Spinner className="h-4 w-4" /> Die KI denkt nach …
        </div>
      ) : html ? (
        <div
          className="kuvert-ai-result max-h-[55vh] overflow-auto rounded-md border border-border bg-surface-2 px-4 py-3 text-sm leading-relaxed [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: result }}
        />
      ) : (
        <div className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-4 py-3 text-sm">{result}</div>
      )}
      {busy && text && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3 w-3" /> wird geschrieben …
        </div>
      )}
    </Modal>
  );
}
