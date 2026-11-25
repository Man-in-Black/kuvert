/**
 * KI-Aktionen für eine ganze Unterhaltung: Verlauf zusammenfassen, Antwort auf die
 * letzte eingehende Nachricht vorschlagen, Aufgaben & Termine aus dem Verlauf erkennen.
 */
import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import type { AiAction, AiRequest, MessageDetail, MessageSummary } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { Button, Dropdown, IconButton, Spinner } from '@/components/ui';
import type { ConversationExtensionProps } from '@/features/mail/extension-types';
import { useMailActions } from '@/features/mail/actions';
import { fetchMessage, mailKeys, toRef } from '@/features/mail/api';
import { useOwnAddresses } from '@/features/mail/hooks';
import { htmlToPlain } from '@/features/mail/sanitize';
import { AiResultModal, useAiDefaults } from './AiResultModal';
import { InstructionDialog } from './InstructionDialog';
import { openAiChat } from './chat-store';

/** Der Server kürzt den Text auf 16 000 Zeichen – ältere Nachrichten fallen zuerst weg */
const TOTAL_BUDGET = 15_000;
const PER_MESSAGE = 4_000;

const TITLES: Partial<Record<AiAction, string>> = {
  summarize: 'Zusammenfassung der Unterhaltung',
  reply: 'Antwortvorschlag',
  extract_tasks: 'Aufgaben & Termine aus der Unterhaltung',
};

/** Zitierten Verlauf entfernen – der steht ohnehin als eigene Nachricht im Thread */
function stripQuoted(text: string): string {
  const cut = text.search(/^(-{2,}\s*(Original Message|Ursprüngliche Nachricht)\s*-{2,}|(Am|On)\s.{4,200}(schrieb|wrote).{0,80}:?\s*$)/im);
  const body = cut > 0 ? text.slice(0, cut) : text;
  return body
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadDetails(qc: QueryClient, messages: MessageSummary[]): Promise<MessageDetail[]> {
  return Promise.all(
    messages.map((m) =>
      qc.fetchQuery({ queryKey: mailKeys.message(m.accountId, m.folderId, m.id), queryFn: () => fetchMessage(toRef(m)), staleTime: 60_000 }),
    ),
  );
}

/** Verlauf als Text, älteste zuerst; bei zu viel Text fallen die ältesten Nachrichten weg */
function threadText(details: MessageDetail[], own: Set<string>): string {
  const sorted = [...details].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); // neueste zuerst
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const d of sorted) {
    const body = stripQuoted(d.text || (d.html ? htmlToPlain(d.html) : '') || d.preview || '').slice(0, PER_MESSAGE);
    const mine = own.has(d.from?.address?.toLowerCase() ?? '');
    const block = `Von: ${d.from?.name ?? ''} <${d.from?.address ?? ''}>${mine ? ' (ich)' : ''}\nDatum: ${d.date}\nBetreff: ${d.subject}\n\n${body}`;
    if (used + block.length > TOTAL_BUDGET && parts.length) {
      omitted++;
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  const chronological = parts.reverse().map((p, i) => `--- Nachricht ${i + 1 + omitted} ---\n${p}`);
  return [omitted ? `(${omitted} ältere Nachrichten ausgelassen)` : '', ...chronological].filter(Boolean).join('\n\n');
}

export function AiConversationActions({ messages }: ConversationExtensionProps) {
  const qc = useQueryClient();
  const defaults = useAiDefaults();
  const actions = useMailActions();
  const own = useOwnAddresses();
  const [request, setRequest] = useState<AiRequest | null>(null);
  const [replyTo, setReplyTo] = useState<MessageDetail | null>(null);
  const [askReply, setAskReply] = useState(false);
  const [loading, setLoading] = useState(false);

  /** Verlauf als Kontext in den KI-Chat; "Als Antwort" zielt auf die letzte fremde Nachricht */
  const openChat = async () => {
    setLoading(true);
    try {
      const details = await loadDetails(qc, messages);
      const sorted = [...details].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const target = sorted.find((d) => !own.has(d.from?.address?.toLowerCase() ?? '')) ?? sorted[0]!;
      const oldest = sorted[sorted.length - 1]!;
      openAiChat({
        key: `conversation|${oldest.accountId}|${oldest.threadId ?? oldest.id}`,
        context: { kind: 'conversation', title: `${oldest.subject} (${details.length} Nachrichten)`, text: threadText(details, own) },
        replyTo: { detail: target, ref: toRef(target) },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const run = async (action: AiAction, instruction?: string) => {
    setLoading(true);
    try {
      const details = await loadDetails(qc, messages);
      const text = threadText(details, own);
      if (action === 'reply') {
        // Antwort auf die neueste Nachricht, die nicht von mir ist
        const target = [...details].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).find((d) => !own.has(d.from?.address?.toLowerCase() ?? '')) ?? details[0]!;
        setReplyTo(target);
        const hint = 'Der Text ist ein E-Mail-Verlauf (älteste zuerst). Antworte auf die letzte Nachricht, die nicht mit „(ich)“ markiert ist, und berücksichtige den gesamten Verlauf.';
        setRequest({ action, text, instruction: instruction ? `${hint} ${instruction}` : hint, language: defaults.language, model: defaults.model, html: true });
      } else {
        setRequest({ action, text, language: defaults.language, model: defaults.model, html: true });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Dropdown
        trigger={
          <IconButton label="KI-Assistent für die Unterhaltung" size="icon-sm" className="text-primary" disabled={loading}>
            {loading ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </IconButton>
        }
        items={[
          { label: 'Unterhaltung zusammenfassen', onClick: () => void run('summarize') },
          { label: 'Antwort vorschlagen …', onClick: () => setAskReply(true) },
          { label: 'Aufgaben & Termine erkennen', onClick: () => void run('extract_tasks') },
          { divider: true, label: '' },
          { label: 'Im KI-Chat fragen …', onClick: () => void openChat() },
        ]}
      />
      <InstructionDialog
        open={askReply}
        kind="instruction"
        title="Antwort auf die Unterhaltung vorschlagen"
        placeholder="Optional: Worauf soll die Antwort hinauslaufen? z. B. „höflich absagen“ oder „Termin bestätigen“"
        onClose={() => setAskReply(false)}
        onSubmit={(v) => void run('reply', v || undefined)}
      />
      <AiResultModal
        open={!!request}
        request={request}
        title={request ? (TITLES[request.action] ?? 'KI-Assistent') : ''}
        onClose={() => setRequest(null)}
        renderActions={(result, done) =>
          request?.action === 'reply' && replyTo ? (
            <Button
              variant="primary"
              disabled={!done}
              onClick={() => {
                actions.reply(replyTo, toRef(replyTo), 'reply', result);
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
