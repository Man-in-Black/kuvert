import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plane } from 'lucide-react';
import type { AccountInfo, OutOfOfficeSettings } from '@kuvert/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAccountsWith } from '@/lib/queries';
import { Badge, Button, ColorDot, EmptyState, Field, Input, Spinner, Switch, Textarea } from '@/components/ui';
import { Card, HelpBox, SectionHeader, isoToLocalInput, localInputToIso } from '../ui';

export function OutOfOfficeSection() {
  const accounts = useAccountsWith('mail');
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Abwesenheitsnotiz"
        description="Automatische Antworten während Urlaub oder Abwesenheit – direkt beim jeweiligen Anbieter hinterlegt, funktioniert also auch, wenn Kuvert geschlossen ist."
      />
      {accounts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState icon={<Plane />} title="Keine E-Mail-Konten vorhanden" />
        </div>
      )}
      {accounts.map((a) => (
        <OooCard key={a.id} account={a} />
      ))}
    </div>
  );
}

function OooCard({ account }: { account: AccountInfo }) {
  const qc = useQueryClient();
  const key = ['mail', 'ooo', account.id];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api<OutOfOfficeSettings>(`/mail/accounts/${account.id}/out-of-office`),
    retry: false,
    staleTime: 60_000,
  });
  const [form, setForm] = useState<OutOfOfficeSettings | null>(null);
  const [sameReply, setSameReply] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({ ...data });
      setSameReply(!data.externalReply || data.externalReply === data.internalReply);
    }
  }, [data]);

  const unsupported = error instanceof ApiError && (error.status === 501 || error.status === 400);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const body: OutOfOfficeSettings = {
        enabled: form.enabled,
        internalReply: form.internalReply ?? '',
        externalReply: sameReply ? (form.internalReply ?? '') : (form.externalReply ?? ''),
        start: form.start || null,
        end: form.end || null,
      };
      await api(`/mail/accounts/${account.id}/out-of-office`, { method: 'PUT', body });
      await qc.invalidateQueries({ queryKey: key });
      toast.success(`Abwesenheitsnotiz für „${account.name}" gespeichert`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ColorDot color={account.color} />
          {account.name}
          <span className="font-normal text-muted">{account.email}</span>
          {data?.enabled && <Badge color="var(--k-warning)">Aktiv</Badge>}
        </span>
      }
    >
      {isLoading && <Spinner />}
      {unsupported && <p className="text-sm text-muted">Für diesen Kontotyp nicht unterstützt.</p>}
      {error && !unsupported && <HelpBox tone="danger">{errorMessage(error)}</HelpBox>}
      {form && (
        <div className="space-y-4">
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Automatische Antworten senden" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Beginn (optional)">
              <Input type="datetime-local" value={isoToLocalInput(form.start)} onChange={(e) => setForm({ ...form, start: localInputToIso(e.target.value) })} />
            </Field>
            <Field label="Ende (optional)">
              <Input type="datetime-local" value={isoToLocalInput(form.end)} onChange={(e) => setForm({ ...form, end: localInputToIso(e.target.value) })} />
            </Field>
          </div>
          <Field label={sameReply ? 'Antworttext' : 'Antwort an interne Absender'}>
            <Textarea
              value={form.internalReply ?? ''}
              onChange={(e) => setForm({ ...form, internalReply: e.target.value })}
              className="min-h-28"
              placeholder="Vielen Dank für Ihre Nachricht. Ich bin bis … nicht erreichbar."
            />
          </Field>
          <Switch checked={sameReply} onChange={setSameReply} label="Gleicher Text für externe Absender" />
          {!sameReply && (
            <Field label="Antwort an externe Absender">
              <Textarea value={form.externalReply ?? ''} onChange={(e) => setForm({ ...form, externalReply: e.target.value })} className="min-h-28" />
            </Field>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onClick={save} loading={saving}>
              Speichern
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
