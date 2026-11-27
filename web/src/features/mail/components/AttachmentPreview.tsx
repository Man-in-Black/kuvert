/**
 * Vorschau einer Datei im Dialog: Bilder, PDF, Audio/Video, Textdateien und
 * (bei hochgeladenen Dateien) .eml-Nachrichten. Für alles andere ein Download-Link.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Download, ExternalLink, Loader2, Paperclip } from 'lucide-react';
import type { EmailAddress, MessageDetail } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { escapeHtml, formatAddress, formatSize } from '@/lib/utils';
import { Modal } from '@/components/ui';
import { ZoomableImage } from '@/components/ZoomableImage';
import { buildMailSrcDoc, hasRemoteContent } from '../sanitize';
import { MailFrame } from './MailFrame';

export interface PreviewFile {
  filename: string;
  contentType: string;
  size?: number;
  /** Download-URL */
  url: string;
  /** URL für die Anzeige im Browser (inline) */
  inlineUrl: string;
  /** Nur für .eml: API-Pfad der geparsten Nachricht und URL-Bauer für deren Anhänge */
  message?: { api: string; partUrl: (attachmentId: string, inline?: boolean) => string };
}

type Kind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'message';

const TEXT_LIMIT = 2 * 1024 * 1024;
const TEXT_EXT = /\.(txt|log|csv|tsv|json|xml|md|ini|conf|cfg|yml|yaml|ics|vcf)$/i;

export function previewKind(f: Pick<PreviewFile, 'filename' | 'contentType' | 'size' | 'message'>): Kind | null {
  const ct = f.contentType.toLowerCase();
  const name = f.filename.toLowerCase();
  if (f.message && (ct === 'message/rfc822' || name.endsWith('.eml'))) return 'message';
  if (ct.startsWith('image/') && !ct.includes('svg')) return 'image';
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  const textual = (ct.startsWith('text/') && !ct.startsWith('text/html')) || /^application\/(json|xml)/.test(ct) || TEXT_EXT.test(name);
  if (textual && (f.size ?? 0) <= TEXT_LIMIT) return 'text';
  return null;
}

export function AttachmentPreview({ file, onClose }: { file: PreviewFile | null; onClose: () => void }) {
  const kind = file ? previewKind(file) : null;
  return (
    <Modal open={!!file} onClose={onClose} title={file?.filename} size={kind === 'audio' ? 'lg' : 'full'}>
      {file && (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <div className="flex items-center gap-4 text-sm">
            {file.size !== undefined && <span className="text-muted">{formatSize(file.size)}</span>}
            {(kind === 'pdf' || kind === 'image') && (
              <a href={file.inlineUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                <ExternalLink className="h-4 w-4" /> In neuem Tab öffnen
              </a>
            )}
            <a href={file.url} download={file.filename} className="inline-flex items-center gap-1 text-primary hover:underline">
              <Download className="h-4 w-4" /> Herunterladen
            </a>
          </div>
          <div className="min-h-0 flex-1">
            <PreviewBody file={file} kind={kind} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function PreviewBody({ file, kind }: { file: PreviewFile; kind: Kind | null }) {
  switch (kind) {
    case 'image':
      return (
        <ZoomableImage src={file.inlineUrl} alt={file.filename} className="h-[75vh] w-full" />
      );
    case 'pdf':
      return (
        <object data={file.inlineUrl} type="application/pdf" className="h-full min-h-[70vh] w-full rounded border border-border">
          <p className="p-4 text-sm text-muted">Die PDF-Vorschau ist in diesem Browser nicht verfügbar.</p>
        </object>
      );
    case 'audio':
      return <audio src={file.inlineUrl} controls className="w-full" />;
    case 'video':
      return (
        <div className="flex h-full items-center justify-center">
          <video src={file.inlineUrl} controls className="max-h-[78vh] max-w-full" />
        </div>
      );
    case 'text':
      return <TextPreview url={file.url} />;
    case 'message':
      return <MessagePreview message={file.message!} />;
    default:
      return <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted">Für diesen Dateityp gibt es keine Vorschau.</div>;
  }
}

function Pending({ error }: { error?: unknown }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted">
      {error ? `Vorschau fehlgeschlagen: ${errorMessage(error)}` : <Loader2 className="h-5 w-5 animate-spin" />}
    </div>
  );
}

function TextPreview({ url }: { url: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['file-preview', 'text', url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    staleTime: 60_000,
  });
  if (isLoading || error) return <Pending error={error} />;
  return <pre className="h-full min-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-2 p-3 font-mono text-xs">{data}</pre>;
}

const addrList = (list?: EmailAddress[]) => (list ?? []).map(formatAddress).join(', ');

function MessagePreview({ message }: { message: NonNullable<PreviewFile['message']> }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const { data: msg, error, isLoading } = useQuery({
    queryKey: ['file-preview', 'message', message.api],
    queryFn: () => api<Omit<MessageDetail, 'id' | 'accountId' | 'folderId' | 'seen' | 'flagged'>>(message.api),
    staleTime: 60_000,
  });

  const srcDoc = useMemo(() => {
    if (!msg) return '';
    const cidMap = new Map<string, string>();
    for (const a of msg.attachments) if (a.contentId) cidMap.set(a.contentId.toLowerCase(), message.partUrl(a.id, true));
    const html = msg.html ?? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(msg.text ?? '')}</pre>`;
    return buildMailSrcDoc(html, { allowRemote, cidMap });
  }, [msg, allowRemote, message]);

  if (isLoading || error || !msg) return <Pending error={error} />;
  const files = msg.attachments.filter((a) => !a.inline || !a.contentId);
  const rows: [string, string][] = [
    ['Von', msg.from ? formatAddress(msg.from) : ''],
    ['An', addrList(msg.to)],
    ['Cc', addrList(msg.cc)],
    ['Datum', msg.date ? format(new Date(msg.date), "EEEE, d. MMMM yyyy 'um' HH:mm", { locale: de }) : ''],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
        <div className="mb-1 font-semibold">{msg.subject || '(kein Betreff)'}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words">{v}</dd>
              </div>
            ))}
        </dl>
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((a) => (
              <a
                key={a.id}
                href={message.partUrl(a.id)}
                download={a.filename}
                className="inline-flex max-w-60 items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs hover:bg-hover"
                title={`${a.filename} herunterladen`}
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate">{a.filename}</span>
                <span className="shrink-0 text-muted">{formatSize(a.size)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
      {!allowRemote && msg.html && hasRemoteContent(msg.html) && (
        <div className="flex items-center gap-2 text-xs text-muted">
          Externe Inhalte wurden blockiert.
          <button type="button" className="text-primary hover:underline" onClick={() => setAllowRemote(true)}>
            Trotzdem laden
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
        <MailFrame srcDoc={srcDoc} minHeight={200} title="Nachricht" />
      </div>
    </div>
  );
}
