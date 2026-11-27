/**
 * Admin-Bereich „Zeiterfassung“: zentrale Vorgaben für alle Benutzer –
 * zentraler Stundensatz und Währung, Rundung, Status-Schlagworte (jeweils optional festgelegt)
 * und wer Kunden, Projekte und Tätigkeiten ändern darf.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, CheckCircle2, Clock, Timer, Wallet } from 'lucide-react';
import type { TtAdminSettings } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Button, Card, Field, Input, PageHeader, Select, Skeleton, Switch } from '@/components/ui';
import { formatMoney, ttk } from './api';
import { ROUND_START_OPTIONS } from './KimaiImport';

const adminKey = ['timetrack', 'admin'] as const;

const ROUND_OPTIONS = [
  { value: 0, label: 'Nicht runden (minutengenau)' },
  { value: 5, label: 'Auf 5 Minuten aufrunden' },
  { value: 10, label: 'Auf 10 Minuten aufrunden' },
  { value: 15, label: 'Auf 15 Minuten aufrunden' },
  { value: 30, label: 'Auf 30 Minuten aufrunden' },
  { value: 60, label: 'Auf volle Stunden aufrunden' },
];

const toText = (n: number | null) => (n == null ? '' : String(n).replace('.', ','));
function parseRate(s: string): number | null | undefined {
  const t = s.trim().replace(/\s|€/g, '');
  if (!t) return null;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : undefined;
}

export function TimetrackAdminSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: adminKey, queryFn: () => api<TtAdminSettings>('/timetrack/admin/settings') });
  const [form, setForm] = useState<TtAdminSettings | null>(null);
  const [rateText, setRateText] = useState('');
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setRateText(toText(data.defaultHourlyRate));
    setTagsText(data.quickTags.join(', '));
  }, [data]);

  const save = useMutation({
    mutationFn: (body: TtAdminSettings) => api<TtAdminSettings>('/timetrack/admin/settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      qc.setQueryData(adminKey, s);
      void qc.invalidateQueries({ queryKey: ttk.settings });
      toast.success('Zentrale Vorgaben gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading || !form) {
    return (
      <div className="space-y-6">
        <PageHeader icon={<Timer />} title="Zeiterfassung" />
        <Skeleton className="h-60 w-full rounded-2xl" />
      </div>
    );
  }

  const rate = parseRate(rateText);
  const currencyOk = /^[A-Za-z]{3}$/.test(form.defaultCurrency);
  const quickTags = [...new Set(tagsText.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 8);
  const valid = rate !== undefined && currencyOk;
  const set = (patch: Partial<TtAdminSettings>) => setForm({ ...form, ...patch });

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ ...form, defaultHourlyRate: rate ?? null, defaultCurrency: form.defaultCurrency.toUpperCase(), quickTags });
      }}
    >
      <PageHeader
        icon={<Timer />}
        title="Zeiterfassung"
        description="Zentrale Vorgaben für alle Benutzer. Kunden, Projekte und Tätigkeiten mit ihren eigenen Stundensätzen pflegst du in der Zeiterfassung unter „Kunden & Projekte“."
        actions={
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
            Speichern
          </Button>
        }
      />

      <Card title="Stundensatz & Währung" icon={<Wallet />} description="Der zentrale Stundensatz ist die letzte Stufe: Tätigkeit → Projekt → Kunde → zentral. Er gilt für neue und neu gespeicherte Einträge.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={`Zentraler Stundensatz (${form.defaultCurrency.toUpperCase() || 'EUR'})`}
            hint={rate != null && rate !== undefined && currencyOk ? `= ${formatMoney(rate, form.defaultCurrency.toUpperCase())} pro Stunde` : 'Leer = kein zentraler Stundensatz'}
            error={rate === undefined ? 'Bitte eine Zahl angeben' : undefined}
          >
            <Input value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" placeholder="z. B. 95" />
          </Field>
          <Field label="Währung für neue Kunden" hint="ISO-Code, z. B. EUR oder CHF" error={currencyOk ? undefined : 'Drei Buchstaben, z. B. EUR'}>
            <Input value={form.defaultCurrency} onChange={(e) => set({ defaultCurrency: e.target.value.toUpperCase() })} maxLength={3} className="uppercase" />
          </Field>
        </div>
      </Card>

      <Card title="Rundung" icon={<Clock />} description="Dauer beim Stoppen/Speichern aufrunden, Start eines Timers abrunden (z. B. 13:59 → 13:55). Vorgabe für alle, die selbst nichts eingestellt haben; festgelegt gilt sie für alle ohne Ausnahme.">
        <div className="flex flex-wrap items-center gap-4">
          <Select value={String(form.roundUp)} onChange={(e) => set({ roundUp: Number(e.target.value) })} className="w-72 max-w-full" aria-label="Rundung der Dauer">
            {ROUND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Dauer: {o.label}
              </option>
            ))}
          </Select>
          <Select value={String(form.roundStart)} onChange={(e) => set({ roundStart: Number(e.target.value) })} className="w-72 max-w-full" aria-label="Rundung des Starts">
            {ROUND_START_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Start: {o.label}
              </option>
            ))}
          </Select>
          <Switch checked={form.roundUpLocked} onChange={(v) => set({ roundUpLocked: v })} label="Für alle festlegen" />
        </div>
      </Card>

      <Card
        title="Status-Schlagworte"
        icon={<CheckCircle2 />}
        description="An jedem Eintrag direkt abhakbar; das erste ist der Haken neben der Dauer (z. B. „gebucht“). Festgelegt können Benutzer keine eigenen wählen."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="gebucht, Rechnung, fakturiert" className="min-w-[16rem] flex-1" aria-label="Status-Schlagworte" />
          <Switch checked={form.quickTagsLocked} onChange={(v) => set({ quickTagsLocked: v })} label="Für alle festlegen" />
        </div>
        <p className="mt-2 text-xs text-muted">Durch Komma getrennt, höchstens 8.</p>
      </Card>

      <Card title="Kunden, Projekte & Tätigkeiten" icon={<Building2 />} description="Die Stammdaten sind für alle gemeinsam.">
        <Switch
          checked={form.masterDataAdminOnly}
          onChange={(v) => set({ masterDataAdminOnly: v })}
          label="Nur Administratoren dürfen Kunden, Projekte und Tätigkeiten anlegen, ändern und löschen"
        />
      </Card>
    </form>
  );
}
