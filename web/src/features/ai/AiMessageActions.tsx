/**
 * KI-Aktionen in der Leseansicht: Zusammenfassen, Antwort vorschlagen, Aufgaben extrahieren.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import type { AiAction, AiRequest } from '@kuvert/shared';
import { Button, Dropdown, IconButton } from '@/components/ui';
import type { MessageExtensionProps } from '@/features/mail/extension-types';
import { useMailActions } from '@/features/mail/actions';
import { htmlToPlain } from '@/features/mail/sanitize';
import { AiResultModal, useAiDefaults } from './AiResultModal';
import { InstructionDialog } from './InstructionDialog';
import { openAiChat } from './chat-store';

const TITLES: Partial<Record<AiAction, string>> = {
  summarize: 'Zusammenfassung',
  reply: 'Antwortvorschlag',
  extract_tasks: 'Aufgaben & Termine',
};

export function AiMessageActions({ accountId, folderId, message }: MessageExtensionProps) {
  const defaults = useAiDefaults();
  const actions = useMailActions();
  const [request, setRequest] = useState<AiRequest | null>(null);
  const [askReply, setAskReply] = useState(false);

  const mailText = () => {
    const body = message.text || (message.html ? htmlToPlain(message.html) : '');
    return `Von: ${message.from?.name ?? ''} <${message.from?.address ?? ''}>\nBetreff: ${message.subject}\nDatum: ${message.date}\n\n${body}`.slice(0, 16_000);
  };

  const run = (action: AiAction, instruction?: string) =>
    setRequest({ action, text: mailText(), instruction, language: defaults.language, model: defaults.model, html: true });

  return (
    <>
      <Dropdown
        trigger={
          <IconButton label="KI-Assistent" size="icon-sm" className="text-primary">
            <Sparkles className="h-4 w-4" />
          </IconButton>
        }
        items={[
          { label: 'Zusammenfassen', onClick: () => run('summarize') },
          { label: 'Antwort vorschlagen …', onClick: () => setAskReply(true) },
          { label: 'Aufgaben & Termine erkennen', onClick: () => run('extract_tasks') },
          { divider: true, label: '' },
          {
            label: 'Im KI-Chat fragen …',
            onClick: () =>
              openAiChat({
                key: `message|${accountId}|${folderId}|${message.id}`,
                context: { kind: 'message', title: message.subject, text: mailText() },
                replyTo: { detail: message, ref: { accountId, folderId, id: message.id } },
              }),
          },
        ]}
      />
      <InstructionDialog
        open={askReply}
        kind="instruction"
        title="Antwort vorschlagen"
        placeholder="Optional: Worauf soll die Antwort hinauslaufen? z. B. „höflich absagen“ oder „Termin bestätigen“"
        onClose={() => setAskReply(false)}
        onSubmit={(v) => run('reply', v || undefined)}
      />
      <AiResultModal
        open={!!request}
        request={request}
        title={request ? (TITLES[request.action] ?? 'KI-Assistent') : ''}
        onClose={() => setRequest(null)}
        renderActions={(result, done) =>
          request?.action === 'reply' ? (
            <Button
              variant="primary"
              disabled={!done}
              onClick={() => {
                actions.reply(message, { accountId, folderId, id: message.id }, 'reply', result);
                setRequest(null);
              }}
            >
              Als Antwort öffnen
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!done}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(htmlToPlain(result));
                  toast.success('In die Zwischenablage kopiert');
                } catch {
                  toast.error('Kopieren nicht möglich');
                }
              }}
            >
              Kopieren
            </Button>
          )
        }
      />
    </>
  );
}
