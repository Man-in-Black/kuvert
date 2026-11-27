/**
 * „An Paperless senden“ am Mail-Anhang: Titel, Korrespondent, Dokumenttyp und Tags
 * optional vorgeben – ohne Angaben ordnet Paperless selbst zu (Zuordnungsregeln).
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Leaf, X } from 'lucide-react';
import type { PaperlessUploadResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge, Button, Field, Input, Modal, Select, Skeleton } from '@/components/ui';
import type { AttachmentExtensionProps } from '@/features/mail/extension-types';
import { trackPaperlessTask, usePaperlessConfig, usePaperlessMeta } from './api';

const stripExt = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');

function SaveDialog({ attachment, msgRef, onClose }: AttachmentExtensionProps & { onClose: () => void }) {
  const { data: config } = usePaperlessConfig();
  const meta = usePaperlessMeta(true);
  const [title, setTitle] = useState('');
  const [correspondent, setCorrespondent] = useState<number | null>(null);
  const [documentType, setDocumentType] = useState<number | null>(null);
  const [tags, setTags] = useState<number[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => setTitle(stripExt(attachment.filename)), [attachment.filename]);

  const submit = async () => {
    setSending(true);
    try {
      const r = await api<PaperlessUploadResult>('/paperless/upload-attachment', {
        method: 'POST',
        body: {
          mail: { accountId: msgRef.accountId, folderId: msgRef.folderId, messageId: msgRef.id, attachmentId: attachment.id },
          title: title.trim() || undefined,
          correspondent,
          documentType,
          tags,
        },
      });
      onClose();
      void trackPaperlessTask(r.taskId, title.trim() || attachment.filename, config?.baseUrl ?? null);
    } catch (err) {
      toast.error(`Übergabe an Paperless fehlgeschlagen: ${errorMessage(err)}`);
    } finally {
      setSending(false);
    }
  };

  const tagById = new Map((meta.data?.tags ?? []).map((t) => [t.id, t]));
  const freeTags = (meta.data?.tags ?? []).filter((t) => !tags.includes(t.id));

  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title="An Paperless senden"
      description={attachment.filename}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={<Leaf className="h-4 w-4" />} loading={sending} onClick={() => void submit()}>
            Senden
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Titel" hint="Leer = Paperless vergibt den Titel selbst">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        {meta.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : meta.error ? (
          <p className="text-sm text-danger">{errorMessage(meta.error)}</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Korrespondent">
                <Select value={correspondent ?? ''} onChange={(e) => setCorrespondent(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Automatisch</option>
                  {meta.data?.correspondents.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Dokumenttyp">
                <Select value={documentType ?? ''} onChange={(e) => setDocumentType(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Automatisch</option>
                  {meta.data?.documentTypes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Tags" hint="Zusätzlich zu den Tags, die Paperless automatisch vergibt">
              <div className="space-y-2">
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((id) => {
                      const t = tagById.get(id);
                      return (
                        <Badge key={id} color={t?.color ?? undefined}>
                          {t?.name ?? `#${id}`}
                          <button type="button" aria-label="Tag entfernen" className="-mr-0.5 opacity-70 hover:opacity-100" onClick={() => setTags((p) => p.filter((x) => x !== id))}>
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                )}
                <Select
                  value=""
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id) setTags((p) => [...p, id]);
                  }}
                  disabled={freeTags.length === 0}
                >
                  <option value="">Tag hinzufügen …</option>
                  {freeTags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

/** Knopf an jedem Anhang – nur sichtbar, wenn der Benutzer Paperless verbunden hat */
export function SaveToPaperlessAction(props: AttachmentExtensionProps) {
  const { data: config } = usePaperlessConfig();
  const [open, setOpen] = useState(false);
  if (!config?.enabled || !config.configured) return null;
  return (
    <>
      <button
        type="button"
        title="An Paperless senden"
        aria-label="An Paperless senden"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg hover:bg-hover"
      >
        <Leaf className="h-4 w-4" />
      </button>
      {open && <SaveDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
