import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Plus, Trash2 } from 'lucide-react';
import type { Template } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RichEditor } from '@/components/editor/RichEditor';
import { Button, EmptyState, Field, Input, Spinner, useConfirm } from '@/components/ui';
import { SectionHeader } from '../ui';

type Draft = Omit<Template, 'id'> & { id?: string };

export function TemplatesSection() {
  const qc = useQueryClient();
  const { data: templates = [], isLoading } = useQuery({ queryKey: qk.templates, queryFn: () => api<Template[]>('/templates') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog } = useConfirm();

  const open = (d: Draft) => {
    setDraft({ ...d });
    setEditorKey((k) => k + 1);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error('Bitte einen Namen vergeben');
      return;
    }
    setSaving(true);
    try {
      const body = { name: draft.name.trim(), subject: draft.subject?.trim() || undefined, html: draft.html };
      const saved = draft.id
        ? await api<Template>(`/templates/${draft.id}`, { method: 'PUT', body })
        : await api<Template>('/templates', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: qk.templates });
      setDraft({ ...saved });
      toast.success('Vorlage gespeichert');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: Template) => {
    if (!(await confirm(`Vorlage „${t.name}" löschen?`, { danger: true }))) return;
    try {
      await api(`/templates/${t.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: qk.templates });
      if (draft?.id === t.id) setDraft(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div>
      <SectionHeader
        title="Vorlagen & Textbausteine"
        description="Wiederkehrende Texte, die beim Verfassen mit einem Klick eingefügt werden können."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => open({ name: '', subject: '', html: '' })}>
            Neue Vorlage
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[240px_1fr]">
        <div className="space-y-1">
          {isLoading && <Spinner />}
          {!isLoading && templates.length === 0 && <p className="text-sm text-muted">Noch keine Vorlagen.</p>}
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => open(t)}
              className={cn(
                'group flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2',
                draft?.id === t.id ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-hover',
              )}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                {t.subject && <div className="truncate text-xs text-muted">{t.subject}</div>}
              </div>
              <button
                type="button"
                aria-label="Löschen"
                className="rounded p-1 text-muted opacity-0 hover:bg-hover hover:text-danger group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(t);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="min-w-0">
          {!draft ? (
            <div className="rounded-xl border border-dashed border-border bg-surface">
              <EmptyState icon={<FileText />} title="Vorlage auswählen oder neu anlegen" />
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="z. B. Terminbestätigung" />
                </Field>
                <Field label="Betreff (optional)" hint="Wird beim Einfügen übernommen, falls der Betreff leer ist">
                  <Input value={draft.subject ?? ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                </Field>
              </div>
              <RichEditor
                key={editorKey}
                value={draft.html}
                onChange={(html) => setDraft((d) => (d ? { ...d, html } : d))}
                minHeight={220}
                imageMode="dataurl"
                className="overflow-hidden rounded-md border border-border"
                placeholder="Text der Vorlage …"
              />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setDraft(null)}>Schließen</Button>
                <Button variant="primary" onClick={save} loading={saving}>
                  Speichern
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}
