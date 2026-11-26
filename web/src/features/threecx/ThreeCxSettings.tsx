/**
 * 3CX: Benutzer-Einstellungen (zugeordnete Nebenstelle, bevorzugtes Gerät, Probeanruf) und
 * Admin-Seite (Verbindung zur Anlage, Nebenstellen der Benutzer).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, PhoneCall, PhoneOutgoing, PlugZap, Smartphone, Sparkles, Users } from 'lucide-react';
import type { ThreeCxAdminConfig, ThreeCxAssignment, ThreeCxAutoAssignResult, ThreeCxTestResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useFeature } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Switch, Table, Td, Th } from '@/components/ui';
import { callViaThreeCx, tk, useThreeCxAdminConfig, useThreeCxAssignments, useThreeCxMe } from './api';

const SETUP_HINT = (
  <>
    In 3CX unter <b>Integrationen → API</b> eine Anwendung anlegen, „3CX Call Control API Access“ aktivieren und die Nebenstellen der Benutzer als
    zu überwachende Nebenstellen eintragen. Für die automatische Zuordnung zusätzlich „3CX Configuration API Access“ (Rolle mit Leserechten).
    Voraussetzung ist eine 8SC+-Lizenz der Edition Enterprise bzw. AI.
  </>
);

/* ───────────────────────────── Benutzer ───────────────────────────── */

export function ThreeCxSettingsSection() {
  const feature = useFeature('threecx');
  const { data: me, isLoading, refetch, isFetching } = useThreeCxMe();
  const qc = useQueryClient();
  const [testNumber, setTestNumber] = useState('');

  const setDevice = useMutation({
    mutationFn: (deviceId: string | null) => api('/threecx/me/device', { method: 'PUT', body: { deviceId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tk.me });
      toast.success('Gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <PageHeader icon={<PhoneCall />} title="Telefonie" description="Anrufe aus Kuvert über deine 3CX-Nebenstelle starten – ein Klick auf eine Telefonnummer genügt." />
      {!feature ? (
        <Card>
          <p className="text-sm text-muted">Die 3CX-Anbindung ist nicht eingerichtet. Telefonnummern öffnen weiterhin das Standardprogramm für tel:-Links.</p>
        </Card>
      ) : isLoading || !me ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !me.extension ? (
        <Card>
          <EmptyState icon={<PhoneCall />} title="Keine Nebenstelle zugeordnet">
            Der Administrator legt fest, welche 3CX-Nebenstelle zu deinem Kuvert-Benutzer gehört. Bis dahin öffnen Telefonnummern das Standardprogramm für tel:-Links.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card
            title={`Nebenstelle ${me.extension}`}
            icon={<Smartphone />}
            description="Von welchem Gerät aus Kuvert anrufen soll. „Automatisch“ nimmt das einzige angemeldete Gerät oder überlässt 3CX die Wahl."
            actions={
              <Button size="sm" variant="ghost" loading={isFetching} onClick={() => void refetch()}>
                Aktualisieren
              </Button>
            }
          >
            {me.devicesError ? (
              <p className="text-sm text-danger">{me.devicesError}</p>
            ) : (
              <div className="space-y-3">
                <Field label="Bevorzugtes Gerät" hint={me.devices.length ? `${me.devices.length} Gerät${me.devices.length === 1 ? '' : 'e'} angemeldet` : 'Gerade ist kein Gerät angemeldet – 3CX-App oder Telefon starten.'}>
                  <Select value={me.deviceId ?? ''} disabled={setDevice.isPending} onChange={(e) => setDevice.mutate(e.target.value || null)}>
                    <option value="">Automatisch</option>
                    {me.devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.userAgent}
                      </option>
                    ))}
                    {me.deviceId && !me.devices.some((d) => d.deviceId === me.deviceId) && <option value={me.deviceId}>Gespeichertes Gerät (gerade nicht angemeldet)</option>}
                  </Select>
                </Field>
              </div>
            )}
          </Card>
          <Card title="Probeanruf" icon={<PhoneOutgoing />} description="Je nach Gerät klingelt zuerst dein Telefon; nach dem Abheben wird die Nummer gewählt.">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (testNumber.trim()) void callViaThreeCx(testNumber.trim());
              }}
            >
              <Input className="min-w-0 flex-1" value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="+49 30 1234567 oder Nebenstelle" inputMode="tel" />
              <Button type="submit" variant="primary" icon={<PhoneOutgoing className="h-4 w-4" />} disabled={!testNumber.trim()}>
                Anrufen
              </Button>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── Admin ───────────────────────────── */

function ConnectionCard({ data }: { data: ThreeCxAdminConfig }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(data.enabled);
  const [baseUrl, setBaseUrl] = useState(data.baseUrl);
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState('');
  const [plusPrefix, setPlusPrefix] = useState(data.plusPrefix);
  const [testResult, setTestResult] = useState<ThreeCxTestResult | null>(null);

  useEffect(() => {
    setEnabled(data.enabled);
    setBaseUrl(data.baseUrl);
    setClientId(data.clientId);
    setPlusPrefix(data.plusPrefix);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api<ThreeCxAdminConfig>('/threecx/admin/config', { method: 'PUT', body: { enabled, baseUrl, clientId, plusPrefix, ...(secret ? { secret } : {}) } }),
    onSuccess: (cfg) => {
      qc.setQueryData(tk.adminConfig, cfg);
      qc.invalidateQueries({ queryKey: tk.all });
      qc.invalidateQueries({ queryKey: qk.app }); // Feature-Flag aktualisieren
      setSecret('');
      toast.success('Gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api<ThreeCxTestResult>('/threecx/admin/test', { method: 'POST', body: { baseUrl, clientId, ...(secret ? { secret } : {}) } }),
    onSuccess: setTestResult,
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err) }),
  });

  return (
    <Card title="Verbindung" icon={<PlugZap />} description={SETUP_HINT}>
      <div className="space-y-4">
        <Switch checked={enabled} onChange={setEnabled} label="Click-to-Call für alle Benutzer anbieten" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse der Anlage" hint="Wie im Browser für die 3CX-Verwaltung, inkl. Port falls nötig">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://firma.3cx.de" />
          </Field>
          <Field label="Client-ID" hint="Die bei der API-Anwendung vergebene Client-ID">
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="kuvert" autoComplete="off" />
          </Field>
          <Field label="API-Schlüssel" hint={data.secretConfigured ? 'Hinterlegt – leer lassen, um ihn zu behalten.' : 'Wird von 3CX nur einmal angezeigt. Verschlüsselt gespeichert.'}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" className="font-mono" placeholder={data.secretConfigured ? '••••••••' : ''} />
          </Field>
          <Field label="„+“ beim Wählen ersetzen durch" hint="Leer lassen, wenn die Ausgangsregeln der Anlage +49… verstehen; sonst z. B. 00">
            <Input value={plusPrefix} onChange={(e) => setPlusPrefix(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="(unverändert)" inputMode="numeric" />
          </Field>
        </div>
        {testResult && (
          <div className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${testResult.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5 text-danger'}`}>
            {testResult.ok && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />}
            <span>
              {testResult.message}
              {!!testResult.monitored?.length && <span className="text-muted"> ({testResult.monitored.join(', ')})</span>}
            </span>
          </div>
        )}
        {testResult?.configApi && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
              testResult.configApi.ok ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'
            }`}
          >
            {testResult.configApi.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
            <span>{testResult.configApi.message}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
          <Button loading={test.isPending} disabled={!baseUrl || !clientId || (!secret && !data.secretConfigured)} onClick={() => test.mutate()}>
            Verbindung testen
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AssignmentRow({ user, monitored }: { user: ThreeCxAssignment; monitored: string[] | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(user.extension ?? '');
  useEffect(() => setValue(user.extension ?? ''), [user.extension]);
  const dirty = value.trim() !== (user.extension ?? '');

  const save = useMutation({
    mutationFn: () => api(`/threecx/admin/assignments/${user.userId}`, { method: 'PUT', body: { extension: value.trim() || null } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tk.assignments });
      toast.success(value.trim() ? `${user.name}: Nebenstelle ${value.trim()}` : `${user.name}: Zuordnung entfernt`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const notMonitored = !!user.extension && !!monitored && !monitored.includes(user.extension);

  return (
    <tr>
      <Td>
        <div className="font-medium">{user.name}</div>
        <div className="text-xs text-muted">{user.email}</div>
      </Td>
      <Td>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <Input className="w-28" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="–" inputMode="numeric" aria-label={`Nebenstelle von ${user.name}`} />
          {dirty && (
            <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
              Speichern
            </Button>
          )}
        </form>
      </Td>
      <Td>
        {notMonitored ? (
          <Badge tone="warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            nicht überwacht
          </Badge>
        ) : user.extension && monitored ? (
          <Badge tone="success">bereit</Badge>
        ) : null}
      </Td>
    </tr>
  );
}

function AssignmentsCard({ ready }: { ready: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useThreeCxAssignments(true);

  const auto = useMutation({
    mutationFn: () => api<ThreeCxAutoAssignResult>('/threecx/admin/auto-assign', { method: 'POST' }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: tk.assignments });
      toast.success(`${r.assigned} Benutzer zugeordnet${r.unmatched ? `, ${r.unmatched} ohne passende E-Mail-Adresse in 3CX` : ''}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card
      title="Nebenstellen der Benutzer"
      icon={<Users />}
      description="Nur hier zugeordnete Benutzer können über 3CX anrufen – und nur von ihrer eigenen Nebenstelle aus. Die Nebenstelle muss in 3CX bei der API-Anwendung als überwacht eingetragen sein."
      actions={
        <Button size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} loading={auto.isPending} disabled={!ready} onClick={() => auto.mutate()}>
          Per E-Mail zuordnen
        </Button>
      }
    >
      {data?.monitoredError && <p className="mb-3 text-sm text-danger">Überwachte Nebenstellen nicht abrufbar: {data.monitoredError}</p>}
      {isLoading || !data ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Benutzer</Th>
              <Th>Nebenstelle</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <AssignmentRow key={u.userId} user={u} monitored={data.monitored} />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function ThreeCxAdminSection() {
  const { data, isLoading } = useThreeCxAdminConfig();
  const ready = !!data && data.enabled && !!data.baseUrl && !!data.clientId && data.secretConfigured;
  return (
    <div className="space-y-6">
      <PageHeader icon={<PhoneCall />} title="3CX" description="Anbindung an die 3CX-Telefonanlage (V20, Call Control API): Telefonnummern in Kuvert starten Anrufe über die Nebenstelle des Benutzers." />
      {isLoading || !data ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <>
          <ConnectionCard data={data} />
          <AssignmentsCard ready={ready} />
        </>
      )}
    </div>
  );
}
