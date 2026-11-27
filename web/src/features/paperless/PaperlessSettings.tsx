/**
 * Einstellungen für Paperless-ngx: persönlicher API-Token (Benutzer) und
 * Standard-URL/Aktivierung (Admin).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, FileText, Inbox, KeyRound, Leaf, Link2, PlugZap, Tags, Trash2 } from 'lucide-react';
import type { PaperlessAdminConfig, PaperlessStats, PaperlessUserConfig } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, StatCard, Switch, useConfirm } from '@/components/ui';
import { pk, usePaperlessAdminConfig, usePaperlessConfig, usePaperlessStatus } from './api';

/* ───────────────────────────── Token-Formular ───────────────────────────── */

function TokenForm({ config, onSaved, compact }: { config: PaperlessUserConfig; onSaved?: () => void; compact?: boolean }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [url, setUrl] = useState(config.overrideUrl ?? '');
  const [showUrl, setShowUrl] = useState(!config.defaultBaseUrl || !!config.overrideUrl);

  const save = useMutation({
    mutationFn: () =>
      api<PaperlessUserConfig>('/paperless/me/config', {
        method: 'PUT',
        body: { ...(token ? { token } : {}), baseUrl: showUrl ? url || null : null },
      }),
    onSuccess: (cfg) => {
      qc.setQueryData(pk.config, cfg);
      qc.invalidateQueries({ queryKey: pk.all });
      setToken('');
      toast.success('Verbindung zu Paperless hergestellt');
      onSaved?.();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        label="Persönlicher API-Token"
        hint={
          config.configured
            ? `Hinterlegt: ${config.tokenHint} – leer lassen, um ihn zu behalten.`
            : 'In Paperless oben rechts unter „Mein Profil“ → „API-Auth-Token“ erzeugen und hier einfügen.'
        }
      >
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" autoComplete="off" className="font-mono" />
      </Field>
      {showUrl ? (
        <Field label="Adresse von Paperless" hint={config.defaultBaseUrl ? `Leer = Standard (${config.defaultBaseUrl})` : undefined}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://paperless.example.com" />
        </Field>
      ) : (
        <button type="button" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg" onClick={() => setShowUrl(true)}>
          <Link2 className="h-3.5 w-3.5" /> Anderen Server verwenden (Standard: {config.defaultBaseUrl})
        </button>
      )}
      <Button
        type="submit"
        variant="primary"
        icon={<PlugZap className="h-4 w-4" />}
        loading={save.isPending}
        disabled={(!token && !config.configured) || (!config.defaultBaseUrl && !url)}
        className={compact ? 'w-full justify-center' : undefined}
      >
        {config.configured ? 'Speichern & prüfen' : 'Verbinden'}
      </Button>
    </form>
  );
}

/** Einstieg (z. B. im Auswahldialog des Editors), solange kein Token hinterlegt ist */
export function PaperlessSetup() {
  const { data: config } = usePaperlessConfig();
  if (!config) return <Skeleton className="h-56 w-full rounded-2xl" />;
  return (
    <div className="mx-auto max-w-md py-4">
      <div className="mb-6 flex flex-col items-center text-center">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/10">
          <Leaf className="h-7 w-7" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">Paperless verbinden</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
          Hänge Dokumente aus Paperless-ngx direkt an Mails an. Dein persönlicher Token sorgt dafür, dass du nur siehst, was du in Paperless sehen darfst.
        </p>
      </div>
      <TokenForm config={config} compact />
    </div>
  );
}

/* ───────────────────────────── Benutzer-Einstellungen ───────────────────────────── */

export function PaperlessSettingsSection() {
  const { data: config, isLoading } = usePaperlessConfig();
  const status = usePaperlessStatus(!!config?.configured);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const remove = async () => {
    if (!(await confirm('Verbindung zu Paperless trennen? Der gespeicherte Token wird gelöscht.', { danger: true }))) return;
    try {
      await api('/paperless/me/config', { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: pk.all });
      toast.success('Verbindung getrennt');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const fmt = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString('de-DE'));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Leaf />}
        title="Paperless"
        description="Dokumente aus Paperless-ngx im Editor anhängen oder verlinken und Mail-Anhänge an Paperless übergeben."
      />
      {isLoading || !config ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !config.enabled ? (
        <Card>
          <p className="text-sm text-muted">Die Paperless-Anbindung ist vom Administrator deaktiviert.</p>
        </Card>
      ) : (
        <>
          {config.configured && (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Dokumente" value={status.data ? fmt(status.data.documents) : status.error ? '–' : <Skeleton className="h-7 w-16" />} icon={<FileText />} />
              <StatCard label="Im Posteingang" value={fmt(status.data?.inbox)} tone="info" icon={<Inbox />} />
              <StatCard label="Tags" value={fmt(status.data?.tags)} tone="neutral" icon={<Tags />} />
            </div>
          )}
          <Card
            title="Zugang"
            icon={<KeyRound />}
            description={config.baseUrl ? `Server: ${config.baseUrl}` : undefined}
            actions={
              config.configured ? (
                <div className="flex items-center gap-2">
                  {status.error ? <Badge tone="danger">Fehler</Badge> : <Badge tone="success">Verbunden</Badge>}
                  <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
                    Trennen
                  </Button>
                </div>
              ) : null
            }
          >
            {status.error && <p className="mb-4 text-sm text-danger">{errorMessage(status.error)}</p>}
            <TokenForm config={config} />
          </Card>
          <Card title="So funktioniert's" icon={<Leaf />}>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
              <li>
                Im Editor unter <strong className="text-fg">Anhängen → Aus Paperless …</strong> Dokumente suchen und anhängen – als durchsuchbares Archiv-PDF oder
                im Original – oder einen Freigabelink mit Ablaufdatum einfügen.
              </li>
              <li>
                In einer Mail am Anhang auf das Blatt-Symbol klicken, um ihn an Paperless zu übergeben. Titel, Korrespondent, Dokumenttyp und Tags sind
                optional – ohne Angaben ordnet Paperless selbst zu.
              </li>
            </ul>
          </Card>
        </>
      )}
      {dialog}
    </div>
  );
}

/* ───────────────────────────── Admin ───────────────────────────── */

export function PaperlessAdminSection() {
  const { data, isLoading } = usePaperlessAdminConfig();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; stats?: PaperlessStats } | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setBaseUrl(data.baseUrl);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api<PaperlessAdminConfig>('/paperless/admin/config', { method: 'PUT', body: { enabled, baseUrl } }),
    onSuccess: (cfg) => {
      qc.setQueryData(pk.adminConfig, cfg);
      qc.invalidateQueries({ queryKey: pk.config });
      qc.invalidateQueries({ queryKey: qk.app }); // Feature-Flag aktualisieren
      toast.success('Gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string; stats?: PaperlessStats }>('/paperless/admin/test', { method: 'POST', body: { baseUrl } }),
    onSuccess: setTestResult,
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err) }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Leaf />}
        title="Paperless-ngx"
        description="Anbindung an Paperless-ngx (docs.paperless-ngx.com). Jeder Benutzer hinterlegt seinen eigenen API-Token – so gelten die Berechtigungen aus Paperless."
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <Card title="Verbindung" icon={<PlugZap />}>
          <div className="space-y-4">
            <Switch checked={enabled} onChange={setEnabled} label="Paperless für alle Benutzer anbieten" />
            <Field label="Standard-Adresse" hint="Adresse der Paperless-Oberfläche, ohne /api">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://paperless.example.com" />
            </Field>
            {testResult && (
              <div
                className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
                  testResult.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5 text-danger'
                }`}
              >
                {testResult.ok && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />}
                <span>
                  {testResult.message}
                  {testResult.stats && <> – {testResult.stats.documents.toLocaleString('de-DE')} Dokumente sichtbar</>}
                </span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Speichern
              </Button>
              <Button loading={test.isPending} disabled={!baseUrl} onClick={() => test.mutate()}>
                Verbindung testen
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
