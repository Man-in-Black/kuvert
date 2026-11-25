/**
 * Detailansicht einer archivierten Nachricht: HTML bereinigt (DOMPurify) in einem
 * Sandbox-iframe ohne Skripte, externe Bilder standardmäßig blockiert.
 */
import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { toast } from 'sonner';
import { ArrowDownToLine, ArrowUpRight, Forward, ImageOff, Paperclip, Reply, X } from 'lucide-react';
import type { ArchiverEmailDetail, UploadInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useSettings } from '@/lib/queries';
import { escapeHtml, formatSize, parseAddressList, textToHtml } from '@/lib/utils';
import { openCompose } from '@/features/mail/compose-api';
import { MailFrame } from '@/features/mail/components/MailFrame';
import { Avatar, Badge, Button, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { attachmentUrl, emlUrl, formatArchiveDate, useArchiverEmail } from './api';

/* ───────────────────────────── HTML-Aufbereitung ───────────────────────────── */

function prepareHtml(html: string, allowRemote: boolean): { html: string; blocked: number } {
  let blocked = 0;
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    ADD_ATTR: ['target'],
  });
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${clean}</body></html>`, 'text/html');
  if (!allowRemote) {
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        img.setAttribute('data-blocked-src', src);
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        blocked++;
      }
    });
    doc.querySelectorAll<HTMLElement>('[style*="url("]').forEach((el) => {
      el.style.backgroundImage = 'none';
      blocked++;
    });
  }
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return { html: doc.body.innerHTML, blocked };
}

function frameDocument(body: string, allowRemote: boolean): string {
  const img = allowRemote ? "img-src data: https: http: 'self'" : "img-src data: 'self'";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; ${img}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#111827;}
  body{font:14px/1.55 -apple-system,'Segoe UI',Roboto,Inter,Arial,sans-serif;padding:20px 22px;word-wrap:break-word;overflow-wrap:anywhere;}
  img{max-width:100%;height:auto;}
  img:not([src]){display:none;}
  blockquote{margin:0 0 0 .8em;padding-left:.9em;border-left:3px solid #d1d5db;color:#4b5563;}
  pre{white-space:pre-wrap;}
  table{max-width:100%;}
  a{color:#4f46e5;}
</style></head><body>${body}</body></html>`;
}

function HtmlFrame({ html }: { html: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      <MailFrame srcDoc={html} minHeight={120} title="Nachricht" />
    </div>
  );
}

/* ───────────────────────────── Ansicht ───────────────────────────── */

export function ArchiveMessage({ id, onClose }: { id: number; onClose?: () => void }) {
  const { data: msg, isLoading, error } = useArchiverEmail(id);
  const { settings } = useSettings();
  const [allowRemote, setAllowRemote] = useState(false);
  const [busy, setBusy] = useState<'forward' | null>(null);

  useEffect(() => setAllowRemote(!settings.blockRemoteContent), [id, settings.blockRemoteContent]);

  const prepared = useMemo(() => {
    if (!msg) return null;
    if (msg.htmlBody?.trim()) {
      const p = prepareHtml(msg.htmlBody, allowRemote);
      return { doc: frameDocument(p.html, allowRemote), blocked: p.blocked };
    }
    return { doc: frameDocument(`<div style="white-space:pre-wrap">${escapeHtml(msg.textBody ?? '')}</div>`, false), blocked: 0 };
  }, [msg, allowRemote]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (error || !msg) {
    return <EmptyState title="Nachricht nicht verfügbar">{errorMessage(error)}</EmptyState>;
  }

  const quoteHtml = () => {
    const body = msg.htmlBody?.trim() ? prepareHtml(msg.htmlBody, false).html : textToHtml(msg.textBody ?? '');
    return `<p></p><p>Am ${escapeHtml(formatArchiveDate(msg.sentDate, true))} schrieb ${escapeHtml(msg.from)}:</p><blockquote>${body}</blockquote>`;
  };
  const strip = (s: string) => s.replace(/^((re|aw|fw|fwd|wg)\s*:\s*)+/i, '');

  const reply = () => {
    openCompose({
      to: msg.isOutgoing ? parseAddressList(msg.to) : parseAddressList(msg.from),
      subject: `AW: ${strip(msg.subject)}`,
      html: quoteHtml(),
    });
  };

  const forward = async () => {
    setBusy('forward');
    try {
      const up = await api<UploadInfo>(`/mailarchiver/emails/${msg.id}/to-upload`, { method: 'POST' });
      openCompose({
        subject: `WG: ${strip(msg.subject)}`,
        html: `<p></p><p>Weitergeleitete Nachricht aus dem Archiv: „${escapeHtml(msg.subject)}“ vom ${escapeHtml(formatArchiveDate(msg.sentDate, true))}</p>`,
        attachments: [{ uploadId: up.id, filename: up.filename, contentType: up.contentType }],
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const fromName = msg.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || msg.from;
  const fromAddr = parseAddressList(msg.from)[0]?.address ?? msg.from;

  return (
    <article className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-6 pb-4 pt-5">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug tracking-tight">{msg.subject || '(kein Betreff)'}</h2>
          {onClose && (
            <IconButton label="Schließen" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <div className="mt-3 flex items-start gap-3">
          <Avatar name={fromName} email={fromAddr} size={38} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="truncate font-medium">{fromName}</span>
              {fromAddr !== fromName && <span className="truncate text-xs text-muted">{fromAddr}</span>}
            </div>
            <div className="truncate text-xs text-muted">an {msg.to}</div>
            {msg.cc && <div className="truncate text-xs text-muted">cc {msg.cc}</div>}
          </div>
          <div className="shrink-0 text-right text-xs text-muted">
            <div title={formatArchiveDate(msg.sentDate, true)}>{new Date(msg.sentDate).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            <div className="mt-1 flex justify-end gap-1">
              <Badge tone={msg.isOutgoing ? 'info' : 'neutral'}>{msg.isOutgoing ? 'Gesendet' : 'Empfangen'}</Badge>
              {msg.folderName && <Badge tone="neutral">{msg.folderName}</Badge>}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" icon={<Reply className="h-3.5 w-3.5" />} onClick={reply}>
            Antworten
          </Button>
          <Button size="sm" icon={<Forward className="h-3.5 w-3.5" />} loading={busy === 'forward'} onClick={forward}>
            Weiterleiten
          </Button>
          <a href={emlUrl(msg.id)} download>
            <Button size="sm" variant="ghost" icon={<ArrowDownToLine className="h-3.5 w-3.5" />}>
              Als .eml herunterladen
            </Button>
          </a>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-surface-2/40 px-6 py-5">
        {prepared && prepared.blocked > 0 && !allowRemote && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm shadow-soft">
            <ImageOff className="h-4 w-4 shrink-0 text-muted" />
            <span className="flex-1 text-muted">Externe Inhalte wurden zum Schutz vor Tracking blockiert.</span>
            <Button size="sm" variant="soft" onClick={() => setAllowRemote(true)}>
              Einmal laden
            </Button>
          </div>
        )}

        {msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {msg.attachments.map((a) => (
              <a
                key={a.id}
                href={attachmentUrl(msg.id, a.id)}
                className="group inline-flex max-w-xs items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-soft transition-colors hover:border-border-strong"
                download
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                  <Paperclip className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{a.fileName}</span>
                  <span className="block text-xs text-muted">{formatSize(a.size)}</span>
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-subtle transition-colors group-hover:text-fg" />
              </a>
            ))}
          </div>
        )}

        {prepared && <HtmlFrame html={prepared.doc} />}
      </div>
    </article>
  );
}
