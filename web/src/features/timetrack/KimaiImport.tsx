/**
 * Import aus Kimai 2: Adresse und API-Token eingeben, Verbindung testen, importieren.
 * Der Import läuft auf dem Server im Hintergrund; der Fortschritt wird abgefragt.
 * Zugangsdaten bleiben (verschlüsselt) gespeichert, damit sich der Import wiederholen lässt –
 * bereits übernommene Datensätze werden dabei aktualisiert statt verdoppelt.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, PlugZap, Timer, Trash2, Upload, XCircle } from 'lucide-react';
import type { TtImportStatus, TtKimaiInput, TtKimaiTestResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Button, Card, Field, Input, PageHeader, Progress, Skeleton, Tabs, useConfirm } from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import { ttk, useKimai } from './api';

const PHASES: Record<TtImportStatus['phase'], string> = {
  customers: 'Kunden',
  projects: 'Projekte',
  activities: 'Tätigkeiten',
  timesheets: 'Zeiteinträge',
  done: 'Fertig',
};

export function KimaiImportForm() {
  const qc = useQueryClient();
  const [poll, setPoll] = useState(false);
  const { data, isLoading } = useKimai(poll);
  const conn = data?.connection ?? null;
  const status = data?.status ?? null;
  const runningNow = status?.state === 'running';

  const [baseUrl, setBaseUrl] = useState('');
  const [mode, setMode] = useState<'token' | 'legacy'>('token');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [test, setTest] = useState<TtKimaiTestResult | null>(null);
  const { confirm, dialog } = useConfirm();

  // Gespeicherte Verbindung übernehmen
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !data) return;
    loaded.current = true;
    if (conn) {
      setBaseUrl(conn.baseUrl);
      if (conn.username) {
        setMode('legacy');
        setUsername(conn.username);
      }
    }
  }, [data, conn]);

  // Abfragen, solange der Import läuft; danach alles neu laden
  const wasRunning = useRef(false);
  useEffect(() => {
    setPoll(runningNow);
    if (runningNow) wasRunning.current = true;
    else if (wasRunning.current && status) {
      wasRunning.current = false;
      void qc.invalidateQueries({ queryKey: ttk.all });
      if (status.state === 'done') toast.success(`Kimai-Import abgeschlossen: ${status.counts.created} neue, ${status.counts.updated} aktualisierte Einträge`);
      else if (status.state === 'error') toast.error(`Kimai-Import fehlgeschlagen: ${status.error ?? 'unbekannter Fehler'}`);
    }
  }, [runningNow, status, qc]);

  const body = (): TtKimaiInput => ({ baseUrl: baseUrl.trim(), token: token.trim() || undefined, username: mode === 'legacy' ? username.trim() || null : null });
  const sameAsSaved = !!conn?.tokenConfigured && conn.baseUrl === baseUrl.trim().replace(/\/+$/, '') && (conn.username ?? '') === (mode === 'legacy' ? username.trim() : '');
  const canSubmit = !!baseUrl.trim() && (!!token.trim() || sameAsSaved) && (mode === 'token' || !!username.trim());

  const testM = useMutation({
    mutationFn: () => api<TtKimaiTestResult>('/timetrack/kimai/test', { method: 'POST', body: body() }),
    onSuccess: setTest,
    onError: (err) => {
      setTest({ ok: false, version: null, user: null, message: errorMessage(err) });
    },
  });

  const importM = useMutation({
    mutationFn: () => api<{ status: TtImportStatus }>('/timetrack/kimai/import', { method: 'POST', body: body() }),
    onSuccess: (r) => {
      setToken('');
      setTest(null);
      qc.setQueryData(ttk.kimai, (old: typeof data) => ({ connection: old?.connection ?? null, status: r.status }));
      void qc.invalidateQueries({ queryKey: ttk.kimai });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const removeM = useMutation({
    mutationFn: () => api('/timetrack/kimai', { method: 'DELETE' }),
    onSuccess: () => {
      setToken('');
      setBaseUrl('');
      setUsername('');
      void qc.invalidateQueries({ queryKey: ttk.kimai });
      toast.success('Gespeicherte Kimai-Zugangsdaten entfernt');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <Skeleton className="h-60 w-full rounded-2xl" />;

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted">
        Übernimmt alle Kunden, Projekte und Tätigkeiten, die dein Kimai-Zugang sieht (auch ausgeblendete), sowie deine eigenen Zeiteinträge. Der Import lässt sich jederzeit
        wiederholen – bereits übernommene Datensätze werden aktualisiert, nicht verdoppelt. Laufende Kimai-Timer werden übersprungen.
      </p>

      {status && <ImportStatusCard status={status} />}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit && !runningNow) importM.mutate();
        }}
      >
        <Field label="Adresse von Kimai" hint="z. B. https://zeit.example.de – ohne /api">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" inputMode="url" autoComplete="off" disabled={runningNow} />
        </Field>
        <div>
          <div className="mb-2 text-xs font-medium text-fg/80">Anmeldung</div>
          <Tabs<'token' | 'legacy'>
            value={mode}
            onChange={setMode}
            tabs={[
              { value: 'token', label: 'API-Token (Kimai 2)' },
              { value: 'legacy', label: 'Benutzer + API-Passwort (ältere Versionen)' },
            ]}
          />
        </div>
        {mode === 'legacy' && (
          <Field label="Kimai-Benutzername">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" disabled={runningNow} />
          </Field>
        )}
        <Field
          label={mode === 'token' ? 'API-Token' : 'API-Passwort'}
          hint={
            sameAsSaved
              ? 'Gespeichert – nur ausfüllen, um ihn zu ersetzen.'
              : mode === 'token'
                ? 'In Kimai: rechts oben auf dein Profil → „API-Zugang“ → neuen Token erstellen.'
                : 'In Kimai: Profil → „API“ → API-Passwort festlegen.'
          }
        >
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={sameAsSaved ? '••••••••' : ''} autoComplete="new-password" disabled={runningNow} />
        </Field>

        {test && (
          <div className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${test.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
            {test.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{test.message}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<PlugZap className="h-4 w-4" />} onClick={() => testM.mutate()} loading={testM.isPending} disabled={!canSubmit || runningNow}>
            Verbindung testen
          </Button>
          <Button type="submit" variant="primary" icon={<Upload className="h-4 w-4" />} loading={importM.isPending} disabled={!canSubmit || runningNow}>
            {status?.state === 'done' ? 'Erneut importieren' : 'Importieren'}
          </Button>
          {conn && !runningNow && (
            <Button
              variant="ghost"
              className="ml-auto text-danger"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={async () => {
                if (await confirm('Gespeicherte Kimai-Zugangsdaten entfernen? Bereits importierte Daten bleiben erhalten.')) removeM.mutate();
              }}
            >
              Zugang entfernen
            </Button>
          )}
        </div>
      </form>
      {dialog}
    </div>
  );
}

function ImportStatusCard({ status }: { status: TtImportStatus }) {
  const c = status.counts;
  const summary = `${c.customers} Kunden, ${c.projects} Projekte, ${c.activities} Tätigkeiten · ${c.created} neue und ${c.updated} aktualisierte Zeiteinträge${c.skipped ? `, ${c.skipped} übersprungen` : ''}`;
  if (status.state === 'running') {
    return (
      <div className="space-y-2 rounded-xl border border-primary/30 bg-primary-soft/40 p-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium">Import läuft: {PHASES[status.phase]} …</span>
          <span className="tabular-nums text-muted">
            {status.done}
            {status.total != null ? ` / ${status.total}` : ''}
          </span>
        </div>
        <Progress value={status.total ? status.done : 0} max={status.total ?? 1} />
        <div className="text-xs text-muted">{summary}</div>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border p-3 text-sm ${status.state === 'done' ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}>
      <div className="flex items-center gap-2 font-medium">
        {status.state === 'done' ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
        {status.state === 'done' ? 'Letzter Import erfolgreich' : 'Letzter Import fehlgeschlagen'}
        {status.finishedAt && <span className="font-normal text-muted">· {formatDateTime(status.finishedAt)}</span>}
      </div>
      {status.error && <div className="mt-1 text-danger">{status.error}</div>}
      <div className="mt-1 text-xs text-muted">{summary}</div>
    </div>
  );
}

/** Einstellungsseite „Zeiterfassung“ */
export function TimetrackSettingsSection() {
  return (
    <div>
      <PageHeader icon={<Timer />} title="Zeiterfassung" description="Daten aus Kimai übernehmen" />
      <Card title="Import aus Kimai" icon={<Upload />}>
        <KimaiImportForm />
      </Card>
    </div>
  );
}
