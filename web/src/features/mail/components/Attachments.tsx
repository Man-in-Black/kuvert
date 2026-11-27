import { useState } from 'react';
import { toast } from 'sonner';
import { CloudUpload, Download, Eye, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo } from 'lucide-react';
import type { AttachmentInfo, StorageItem } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAccountsWith } from '@/lib/queries';
import { formatSize } from '@/lib/utils';
import { IconButton } from '@/components/ui';
import { StoragePickerDialog } from '@/features/files/StorageBrowser';
import { useExtensions } from '@/modules/context';
import { attachmentUrl, type MessageRef } from '../api';
import { AttachmentPreview, previewKind, type PreviewFile } from './AttachmentPreview';

function iconFor(ct: string, name: string) {
  const t = ct.toLowerCase();
  const n = name.toLowerCase();
  if (t.startsWith('image/')) return FileImage;
  if (t.startsWith('video/')) return FileVideo;
  if (t.startsWith('audio/')) return FileAudio;
  if (t === 'application/pdf' || n.endsWith('.pdf') || t.startsWith('text/') || /\.(docx?|odt|rtf)$/.test(n)) return FileText;
  if (/zip|rar|7z|tar|gzip/.test(t) || /\.(zip|rar|7z|tgz|gz)$/.test(n)) return FileArchive;
  if (/sheet|excel|csv/.test(t) || /\.(xlsx?|ods|csv)$/.test(n)) return FileSpreadsheet;
  return File;
}

const previewable = (a: AttachmentInfo) => previewKind(a) !== null;

export function AttachmentList({ attachments, msgRef }: { attachments: AttachmentInfo[]; msgRef: MessageRef }) {
  const storage = useAccountsWith('storage');
  const actionExt = useExtensions('attachmentActions');
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [saving, setSaving] = useState<AttachmentInfo | null>(null);
  const visible = attachments.filter((a) => !a.inline || !a.contentId);
  if (!visible.length) return null;

  const total = visible.reduce((s, a) => s + (a.size || 0), 0);

  const saveToCloud = async (accountId: string, folderId: string | null, a: AttachmentInfo) => {
    try {
      const item = await api<StorageItem>(`/storage/accounts/${accountId}/save-attachment`, {
        method: 'POST',
        body: { folderId, mail: { accountId: msgRef.accountId, folderId: msgRef.folderId, messageId: msgRef.id, attachmentId: a.id } },
      });
      toast.success(`„${item.name || a.filename}“ in der Cloud gespeichert`);
    } catch (err) {
      toast.error(`Speichern fehlgeschlagen: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="mt-4">
      <div className="mb-2 text-xs text-muted">
        {visible.length} {visible.length === 1 ? 'Anhang' : 'Anhänge'} · {formatSize(total)}
        {visible.length > 1 && (
          <button
            type="button"
            className="ml-2 text-primary hover:underline"
            onClick={() =>
              visible.forEach((a, i) =>
                setTimeout(() => {
                  const link = document.createElement('a');
                  link.href = attachmentUrl(msgRef, a.id);
                  link.download = a.filename;
                  link.click();
                }, i * 300),
              )
            }
          >
            Alle herunterladen
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((a) => {
          const Icon = iconFor(a.contentType, a.filename);
          return (
            <div key={a.id} className={`group flex ${actionExt.length ? 'w-72' : 'w-64'} items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2`}>
              <Icon className="h-8 w-8 shrink-0 text-muted" strokeWidth={1.5} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm" title={a.filename}>
                  {a.filename}
                </div>
                <div className="text-xs text-muted">{formatSize(a.size)}</div>
              </div>
              <div className="flex shrink-0 items-center">
                {previewable(a) && (
                  <IconButton label="Vorschau" size="icon-sm" onClick={() => setPreview({ ...a, url: attachmentUrl(msgRef, a.id), inlineUrl: attachmentUrl(msgRef, a.id, true) })}>
                    <Eye className="h-4 w-4" />
                  </IconButton>
                )}
                {storage.length > 0 && (
                  <IconButton label="In Cloud speichern" size="icon-sm" onClick={() => setSaving(a)}>
                    <CloudUpload className="h-4 w-4" />
                  </IconButton>
                )}
                {actionExt.map((Action, i) => (
                  <Action key={i} attachment={a} msgRef={msgRef} />
                ))}
                <a
                  href={attachmentUrl(msgRef, a.id)}
                  download={a.filename}
                  title="Herunterladen"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg hover:bg-hover"
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <AttachmentPreview file={preview} onClose={() => setPreview(null)} />

      <StoragePickerDialog
        open={!!saving}
        mode="folder"
        title={saving ? `„${saving.filename}“ in Cloud speichern` : undefined}
        onClose={() => setSaving(null)}
        onPick={(picked) => {
          const target = picked[0];
          const att = saving;
          setSaving(null);
          if (target && att) void saveToCloud(target.accountId, target.item.id || null, att);
        }}
      />
    </div>
  );
}
