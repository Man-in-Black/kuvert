import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Code2, FileSignature, PenLine, Plus, Trash2 } from 'lucide-react';
import type { MailIdentity, Signature } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useAccountsWith, useSignatures } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RichEditor } from '@/components/editor/RichEditor';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Select, Spinner, Tabs, Textarea, useConfirm } from '@/components/ui';
import { HelpBox, SectionHeader } from '../ui';

type Draft = Omit<Signature, 'id'> & { id?: string };

const EMPTY: Draft = { name: '', mode: 'html', content: '', accountId: null, identityAddress: null, defaultNew: false, defaultReply: false };

export function SignaturesSection() {
  const qc = useQueryClient();
  const { data: signatures = [], isLoading } = useSignatures();
  const mailAccounts = useAccountsWith('mail');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog } = useConfirm();

  const open = (d: Draft) => {
    setDraft({ ...d });
    setEditorKey((k) => k + 1);
  };

  const accountName = (id?: string | null) => (id ? (mailAccounts.find((a) => a.id === id)?.name ?? 'Unbekanntes Konto') : 'Alle Konten');

  const { data: identities = [] } = useQuery({
    queryKey: ['mail', 'identities', draft?.accountId],
    queryFn: () => api<MailIdentity[]>(`/mail/accounts/${draft!.accountId}/identities`),
    enabled: !!draft?.accountId,
    retry: false,
    staleTime: 300_000,
  });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error('Bitte einen Namen vergeben');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        mode: draft.mode,
        content: draft.content,
        accountId: draft.accountId || null,
        identityAddress: draft.identityAddress?.trim() || null,
        defaultNew: draft.defaultNew,
        defaultReply: draft.defaultReply,
      };
      const saved = draft.id
        ? await api<Signature>(`/signatures/${draft.id}`, { method: 'PUT', body })
        : await api<Signature>('/signatures', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: qk.signatures });
      setDraft({ ...saved });
      toast.success('Signatur gespeichert');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Signature) => {
    if (!(await confirm(`Signatur „${s.name}" löschen?`, { danger: true }))) return;
    try {
      await api(`/signatures/${s.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: qk.signatures });
      if (draft?.id === s.id) setDraft(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const switchMode = async (mode: Draft['mode']) => {
    if (!draft || mode === draft.mode) return;
    if (mode === 'html' && draft.content.trim()) {
      const ok = await confirm(
        'Beim Wechsel in den Editor-Modus wird der Quelltext vom Editor interpretiert. Spezielle Formatierungen (Tabellen-Layouts, Inline-Styles) können dabei verloren gehen. Fortfahren?',
      );
      if (!ok) return;
    }
    setDraft({ ...draft, mode });
    setEditorKey((k) => k + 1);
  };

  const sorted = useMemo(() => [...signatures].sort((a, b) => a.name.localeCompare(b.name, 'de')), [signatures]);

  return (
    <div>
      <SectionHeader
        title="Signaturen"
        description="Signaturen werden beim Verfassen automatisch eingefügt – je nach Konto und Art (neue Nachricht / Antwort)."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => open(EMPTY)}>
            Neue Signatur
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[240px_1fr]">
        <div className="space-y-1">
          {isLoading && <Spinner />}
          {!isLoading && sorted.length === 0 && <p className="text-sm text-muted">Noch keine Signaturen.</p>}
          {sorted.map((s) => (
            <div
              key={s.id}
              className={cn(
                'group flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors',
                draft?.id === s.id ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-hover',
              )}
              onClick={() => open(s)}
            >
              {s.mode === 'raw' ? <Code2 className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <PenLine className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{s.name}</div>
                <div className="truncate text-xs text-muted">{accountName(s.accountId)}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.defaultNew && <Badge>Neu</Badge>}
                  {s.defaultReply && <Badge>Antwort</Badge>}
                  {s.mode === 'raw' && <Badge>RAW</Badge>}
                </div>
              </div>
              <button
                type="button"
                className="rounded p-1 text-muted opacity-0 hover:bg-hover hover:text-danger group-hover:opacity-100"
                aria-label="Löschen"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s);
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
              <EmptyState icon={<FileSignature />} title="Signatur auswählen oder neu anlegen" />
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="z. B. Geschäftlich" />
                </Field>
                <Field label="Gilt für">
                  <Select value={draft.accountId ?? ''} onChange={(e) => setDraft({ ...draft, accountId: e.target.value || null, identityAddress: null })}>
                    <option value="">Alle Konten</option>
                    {mailAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.email})
                      </option>
                    ))}
                  </Select>
                </Field>
                {draft.accountId && (
                  <Field label="Nur für Absenderadresse (optional)" hint="Z. B. für ein freigegebenes Postfach oder einen Alias" className="sm:col-span-2">
                    <Input
                      list="signature-identities"
                      value={draft.identityAddress ?? ''}
                      onChange={(e) => setDraft({ ...draft, identityAddress: e.target.value })}
                      placeholder="Alle Absender dieses Kontos"
                    />
                    <datalist id="signature-identities">
                      {identities.map((i) => (
                        <option key={i.id} value={i.address}>
                          {i.name}
                        </option>
                      ))}
                    </datalist>
                  </Field>
                )}
              </div>

              <div className="flex flex-wrap gap-5">
                <Checkbox checked={draft.defaultNew} onChange={(v) => setDraft({ ...draft, defaultNew: v })} label="Standard für neue Nachrichten" />
                <Checkbox checked={draft.defaultReply} onChange={(v) => setDraft({ ...draft, defaultReply: v })} label="Standard für Antworten/Weiterleitungen" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs
                  value={draft.mode}
                  onChange={(m) => void switchMode(m)}
                  tabs={[
                    { value: 'html', label: 'HTML (Editor)' },
                    { value: 'raw', label: 'RAW (Quelltext)' },
                  ]}
                />
              </div>
              <HelpBox>
                <strong>HTML (Editor):</strong> komfortabel mit dem Editor gestalten; die Signatur wird in den Nachrichtentext eingefügt und kann dort
                noch angepasst werden. <strong>RAW (Quelltext):</strong> der HTML- oder Text-Quelltext wird Byte für Byte unverändert an die Nachricht
                angehängt – ideal für gestaltete Firmensignaturen mit Tabellen, Inline-Styles oder Bannern, die ein Editor verändern würde.
              </HelpBox>

              {draft.mode === 'html' ? (
                <RichEditor
                  key={editorKey}
                  value={draft.content}
                  onChange={(html) => setDraft((d) => (d ? { ...d, content: html } : d))}
                  minimal
                  minHeight={160}
                  imageMode="dataurl"
                  className="overflow-hidden rounded-md border border-border"
                  placeholder="Mit freundlichen Grüßen …"
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <Field label="Quelltext">
                    <Textarea
                      value={draft.content}
                      onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                      spellCheck={false}
                      className="min-h-64 font-mono text-xs"
                      placeholder={'<table style="font-family:Arial">…</table>'}
                    />
                  </Field>
                  <Field label="Vorschau">
                    <iframe
                      title="Signaturvorschau"
                      sandbox=""
                      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:8px;font-family:Arial,sans-serif;font-size:14px;color:#111;background:#fff}</style></head><body>${
                        /<[a-z][\s\S]*>/i.test(draft.content) ? draft.content : `<pre style="font-family:inherit;white-space:pre-wrap">${draft.content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
                      }</body></html>`}
                      className="h-64 w-full rounded-md border border-border bg-white"
                    />
                  </Field>
                </div>
              )}

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
