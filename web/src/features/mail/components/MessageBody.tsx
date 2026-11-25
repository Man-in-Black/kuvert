import { useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { MessageDetail } from '@kuvert/shared';
import { useSettings, useUpdateSettings } from '@/lib/queries';
import { Button } from '@/components/ui';
import { attachmentUrl, type MessageRef } from '../api';
import { buildMailSrcDoc, hasRemoteContent, linkifyText } from '../sanitize';
import { MailFrame } from './MailFrame';

export function isTrustedSender(address: string | undefined, trusted: string[]): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  const domain = a.split('@')[1] ?? '';
  return trusted.some((t) => {
    const x = t.trim().toLowerCase();
    if (!x) return false;
    if (x.includes('@') && !x.startsWith('@')) return x === a;
    const d = x.replace(/^@/, '');
    return domain === d || domain.endsWith(`.${d}`);
  });
}

/** Baut das srcdoc für eine Nachricht (wird auch für den Druck genutzt) */
export function messageSrcDoc(message: MessageDetail, ref: MessageRef, allowRemote: boolean): string {
  const cidMap = new Map<string, string>();
  for (const a of message.attachments) if (a.contentId) cidMap.set(a.contentId.toLowerCase(), attachmentUrl(ref, a.id, true));
  const html = message.html ?? `<div style="white-space:pre-wrap;font-family:inherit">${linkifyText(message.text ?? '')}</div>`;
  return buildMailSrcDoc(html, { allowRemote, cidMap });
}

/** Nachrichteninhalt mit Schutz vor externen Inhalten (Tracking-Pixel) */
export function MessageBody({ message, msgRef }: { message: MessageDetail; msgRef: MessageRef }) {
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const [loadOnce, setLoadOnce] = useState(false);
  const from = message.from?.address;
  const trusted = isTrustedSender(from, settings.trustedSenders);
  const remote = !!message.html && hasRemoteContent(message.html);
  const allowRemote = !settings.blockRemoteContent || trusted || loadOnce;

  const srcDoc = useMemo(() => messageSrcDoc(message, msgRef, allowRemote), [message, msgRef, allowRemote]);

  return (
    <div>
      {remote && !allowRemote && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <ImageOff className="h-4 w-4 text-muted" />
          <span className="flex-1 text-muted">Externe Inhalte wurden blockiert, um Ihre Privatsphäre zu schützen.</span>
          <Button size="sm" onClick={() => setLoadOnce(true)}>
            Einmal laden
          </Button>
          {from && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update.mutate({ trustedSenders: [...settings.trustedSenders, from.toLowerCase()] })}
            >
              Absender immer vertrauen
            </Button>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <MailFrame srcDoc={srcDoc} minHeight={80} />
      </div>
    </div>
  );
}
