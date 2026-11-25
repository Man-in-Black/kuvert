/**
 * KI-Menü in der Editor-Werkzeugleiste des Verfassen-Fensters.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import type { AiAction, AiRequest } from '@kuvert/shared';
import { Button, Dropdown, type MenuItem } from '@/components/ui';
import type { ComposerExtensionProps } from '@/features/mail/extension-types';
import { htmlToPlain } from '@/features/mail/sanitize';
import { AiResultModal, useAiDefaults } from './AiResultModal';
import { InstructionDialog } from './InstructionDialog';

const LABELS: Partial<Record<AiAction, string>> = {
  rewrite: 'Umschreiben',
  formal: 'Formeller',
  friendly: 'Freundlicher',
  shorter: 'Kürzer',
  longer: 'Länger',
  fix: 'Rechtschreibung & Grammatik korrigieren',
  translate: 'Übersetzen',
  subject: 'Betreff vorschlagen',
  custom: 'Freie Anweisung',
  compose: 'Entwurf schreiben',
};

export function AiComposerButton(props: ComposerExtensionProps) {
  const defaults = useAiDefaults();
  const [request, setRequest] = useState<AiRequest | null>(null);
  const [usedSelection, setUsedSelection] = useState(false);
  const [ask, setAsk] = useState<{ action: AiAction; kind: 'instruction' | 'language' } | null>(null);

  const originalText = () => {
    const o = props.draft.original;
    if (!o) return undefined;
    const body = o.text || (o.html ? htmlToPlain(o.html) : '');
    return `Von: ${o.from?.name ?? ''} <${o.from?.address ?? ''}>\nBetreff: ${o.subject}\n\n${body}`.slice(0, 12_000);
  };

  const start = (action: AiAction, extra: { instruction?: string; language?: string } = {}) => {
    const selection = props.getSelectedText();
    const text = action === 'subject' ? props.getText() : selection || props.getText();
    if (!text.trim() && action !== 'compose') {
      toast.info('Es gibt noch keinen Text, mit dem die KI arbeiten kann.');
      return;
    }
    setUsedSelection(!!selection && action !== 'subject' && action !== 'compose');
    setRequest({
      action,
      text,
      instruction: extra.instruction,
      language: extra.language ?? defaults.language,
      context: originalText(),
      model: defaults.model,
      html: action !== 'subject',
    });
  };

  const choose = (action: AiAction) => {
    if (action === 'translate') setAsk({ action, kind: 'language' });
    else if (action === 'custom' || action === 'compose') setAsk({ action, kind: 'instruction' });
    else start(action);
  };

  const items: MenuItem[] = [
    { label: 'Entwurf schreiben …', onClick: () => choose('compose') },
    { divider: true, label: '' },
    ...(['rewrite', 'formal', 'friendly', 'shorter', 'longer', 'fix'] as AiAction[]).map((a) => ({ label: LABELS[a], onClick: () => choose(a) })),
    { label: 'Übersetzen …', onClick: () => choose('translate') },
    { divider: true, label: '' },
    { label: 'Betreff vorschlagen', onClick: () => choose('subject') },
    { label: 'Freie Anweisung …', onClick: () => choose('custom') },
  ];

  const action = request?.action;
  const editorEmpty = () => !props.getText().trim();

  return (
    <>
      <Dropdown
        trigger={
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-primary" title="KI-Assistent" onMouseDown={(e) => e.preventDefault()}>
            <Sparkles className="h-4 w-4" /> KI
          </Button>
        }
        items={items}
      />
      <InstructionDialog
        open={!!ask}
        kind={ask?.kind ?? 'instruction'}
        defaultLanguage={defaults.language}
        title={ask?.action === 'translate' ? 'Übersetzen' : ask?.action === 'compose' ? 'Entwurf schreiben' : 'Freie Anweisung'}
        placeholder={
          ask?.action === 'compose'
            ? props.draft.original
              ? 'z. B. „Termin am Dienstag freundlich zusagen und nach der Agenda fragen“'
              : 'z. B. „Angebot für 20 Lizenzen anfragen, Lieferung bis Monatsende“'
            : 'z. B. „In Stichpunkten zusammenfassen“'
        }
        onClose={() => setAsk(null)}
        onSubmit={(v) => {
          const a = ask!.action;
          if (ask!.kind === 'language') start(a, { language: v });
          else start(a, { instruction: v });
        }}
      />
      <AiResultModal
        open={!!request}
        request={request}
        title={action ? (LABELS[action] ?? 'KI-Assistent') : 'KI-Assistent'}
        onClose={() => setRequest(null)}
        renderActions={(result, done) =>
          action === 'subject' ? (
            <Button
              variant="primary"
              disabled={!done}
              onClick={() => {
                props.updateMessage({ subject: result.split('\n')[0]!.replace(/^(betreff|subject)\s*:\s*/i, '').replace(/^["„“]|["“”]$/g, '').trim() });
                setRequest(null);
              }}
            >
              Als Betreff übernehmen
            </Button>
          ) : (
            <>
              <Button
                disabled={!done}
                onClick={() => {
                  props.insertHtml(result);
                  setRequest(null);
                }}
              >
                Einfügen
              </Button>
              <Button
                variant="primary"
                disabled={!done}
                onClick={() => {
                  if (action === 'compose' && !editorEmpty()) props.insertHtml(result);
                  else props.replaceContent(result, usedSelection);
                  setRequest(null);
                }}
              >
                {action === 'compose' ? 'Übernehmen' : 'Ersetzen'}
              </Button>
            </>
          )
        }
      />
    </>
  );
}
