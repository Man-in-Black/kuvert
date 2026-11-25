/**
 * Einstellungen für das Mail-Archiv: persönlicher API-Schlüssel (Benutzer) und
 * Standard-URL/Aktivierung (Admin).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, CheckCircle2, KeyRound, Link2, PlugZap, Trash2 } from 'lucide-react';
import type { ArchiverAdminConfig, ArchiverStats, ArchiverUserConfig } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, StatCard, Switch, useConfirm } from '@/components/ui';
import { ak, useArchiverAdminConfig, useArchiverConfig, useArchiverStatus } from './api';

/* ───────────────────────────── Schlüssel-Formular ───────────────────────────── */

function KeyForm({ config, onSaved, compact }: { config: ArchiverUserConfig; onSaved?: () => void; compact?: boolean }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState(config.overrideUrl ?? '');
  const [showUrl, setShowUrl] = useState(!config.defaultBaseUrl || !!config.overrideUrl);

  const save = useMutation({
    mutationFn: () =>
      api<ArchiverUserConfig>('/mailarchiver/me/config', {
        method: 'PUT',
        body: { ...(apiKey ? { apiKey } : {}), baseUrl: showUrl ? url || null : null },
      }),
    onSuccess: (cfg) => {
      qc.setQueryData(ak.config, cfg);
      qc.invalidateQueries({ queryKey: ak.all });
      setApiKey('');
      toast.success('Verbindung zum Archiv hergestellt');
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
        label="Persönlicher API-Schlüssel"
        hint={config.configured ? `Hinterlegt: ${config.keyHint} – leer lassen, um ihn zu behalten.` : 'Im Mail-Archiver unter „Profil → API-Schlüssel“ erstellen (beginnt mit ma_).'}
      >
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ma_…" autoComplete="off" className="font-mono" />
      </Field>
      {showUrl ? (
        <Field label="Adresse des Mail-Archivers" hint={config.defaultBaseUrl ? `Leer = Standard (${config.defaultBaseUrl})` : undefined}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://archiv.example.com" />
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
        disabled={(!apiKey && !config.configured) || (!config.defaultBaseUrl && !url)}
        className={compact ? 'w-full justify-center' : undefined}
      >
        {config.configured ? 'Speichern & prüfen' : 'Verbinden'}
      </Button>
    </form>
  );
}

/** Einstiegskarte auf der Archiv-Seite, solange kein Schlüssel hinterlegt ist */
export function ArchiveSetupCard() {
  const { data: config } = useArchiverConfig();
  if (!config) return <Skeleton className="h-56 w-full rounded-2xl" />;
  return (
    <Card bodyClassName="p-7">
      <div className="mb-6 flex flex-col items-center text-center">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/10">
          <Archive className="h-7 w-7" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Mail-Archiv verbinden</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
          Durchsuche archivierte E-Mails direkt in Kuvert. Dein persönlicher Schlüssel sorgt dafür, dass du nur siehst, was du im Archiv sehen darfst.
        </p>
      </div>
      <KeyForm config={config} compact />
    </Card>
  );
}

/* ───────────────────────────── Benutzer-Einstellungen ───────────────────────────── */

export function ArchiveSettingsSection() {
  const { data: config, isLoading } = useArchiverConfig();
  const status = useArchiverStatus(!!config?.configured);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const remove = async () => {
    if (!(await confirm('Verbindung zum Mail-Archiv trennen? Der gespeicherte Schlüssel wird gelöscht.', { danger: true }))) return;
    try {
      await api('/mailarchiver/me/config', { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ak.all });
      toast.success('Verbindung getrennt');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={<Archive />} title="Mail-Archiv" description="Verbindung zu Mail-Archiver für die Archiv-Suche in Kuvert." />
      {isLoading || !config ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !config.enabled ? (
        <Card>
          <p className="text-sm text-muted">Die Mail-Archiver-Anbindung ist vom Administrator deaktiviert.</p>
        </Card>
      ) : (
        <>
          {config.configured && (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Nachrichten" value={status.data ? status.data.emails.toLocaleString('de-DE') : status.error ? '–' : <Skeleton className="h-7 w-16" />} icon={<Archive />} />
              <StatCard label="Konten" value={status.data ? status.data.accounts : '–'} tone="info" icon={<Link2 />} />
              <StatCard label="Anhänge" value={status.data ? status.data.attachments.toLocaleString('de-DE') : '–'} tone="neutral" icon={<KeyRound />} />
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
            <KeyForm config={config} />
          </Card>
        </>
      )}
      {dialog}
    </div>
  );
}

/* ───────────────────────────── Admin ───────────────────────────── */

export function ArchiveAdminSection() {
  const { data, isLoading } = useArchiverAdminConfig();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; stats?: ArchiverStats } | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setBaseUrl(data.baseUrl);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api<ArchiverAdminConfig>('/mailarchiver/admin/config', { method: 'PUT', body: { enabled, baseUrl } }),
    onSuccess: (cfg) => {
      qc.setQueryData(ak.adminConfig, cfg);
      qc.invalidateQueries({ queryKey: ak.config });
      qc.invalidateQueries({ queryKey: qk.app }); // Feature-Flag (Navigation) aktualisieren
      toast.success('Gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string; stats?: ArchiverStats }>('/mailarchiver/admin/test', { method: 'POST', body: { baseUrl } }),
    onSuccess: setTestResult,
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err) }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Archive />}
        title="Mail-Archiver"
        description="Anbindung an Mail-Archiver (github.com/s1t5/mail-archiver). Jeder Benutzer hinterlegt seinen eigenen API-Schlüssel – so gelten die Berechtigungen des Archivs."
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <Card title="Verbindung" icon={<PlugZap />}>
          <div className="space-y-4">
            <Switch checked={enabled} onChange={setEnabled} label="Archiv-Suche für alle Benutzer anbieten" />
            <Field label="Standard-Adresse" hint="Die REST-API muss im Mail-Archiver aktiviert sein: Api__Enabled=true">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://archiv.example.com" />
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
                  {testResult.stats && <> – {testResult.stats.emails.toLocaleString('de-DE')} Nachrichten sichtbar</>}
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
