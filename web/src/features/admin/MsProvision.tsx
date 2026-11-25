/**
 * Microsoft 365 automatisch einrichten: Ein Microsoft-365-Administrator meldet sich per
 * Gerätecode bei Microsoft an, Kuvert legt daraufhin App-Registrierung, Berechtigungen,
 * Administratorzustimmung und geheimen Clientschlüssel selbst an und übernimmt sie.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, TriangleAlert, Wand2 } from 'lucide-react';
import type { MsAppAudience, MsProvisionOverview, MsProvisionStatus, MsProvisionStep } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button, CopyButton, Field, Input, Modal, Select, Spinner } from '@/components/ui';
import { HelpBox } from '@/features/settings/ui';

const overviewKey = ['admin', 'ms-provision'] as const;
const DAY = 24 * 60 * 60 * 1000;

const isActive = (job?: MsProvisionStatus | null) => job?.state === 'waiting' || job?.state === 'working';
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Hinweis-/Statusblock in der Microsoft-Karte mit Button zum automatischen Einrichten */
export function MsAutoSetup({ servicesKey }: { servicesKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: overviewKey,
    queryFn: () => api<MsProvisionOverview>('/microsoft/provision'),
    // Läuft die Einrichtung im Hintergrund weiter, Status regelmäßig abfragen
    refetchInterval: (q) => (isActive(q.state.data?.job) ? 3000 : false),
  });
  const [open, setOpen] = useState(false);
  const app = data?.active ? data.app : null;
  const running = isActive(data?.job);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: overviewKey });
    qc.invalidateQueries({ queryKey: servicesKey });
    qc.invalidateQueries({ queryKey: qk.app });
    qc.invalidateQueries({ queryKey: ['admin', 'account-types'] });
  };

  // Im Hintergrund abgeschlossen → Einstellungen neu laden
  const prevState = useRef(data?.job?.state);
  useEffect(() => {
    const state = data?.job?.state;
    if (prevState.current === 'working' && state === 'done' && !open) refreshAll();
    prevState.current = state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.job?.state]);

  const daysLeft = app ? Math.floor((new Date(app.secretExpiresAt).getTime() - Date.now()) / DAY) : null;

  return (
    <div className="mb-2 rounded-xl border border-primary/30 bg-primary-soft/60 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-xs leading-relaxed">
          {app ? (
            <>
              <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <CircleCheck className="h-4 w-4 text-success" /> Automatisch eingerichtet
              </div>
              <div className="mt-1 text-muted">
                App „{app.displayName}“{app.tenantName ? ` in „${app.tenantName}“` : ''} · {app.audience === 'tenant' ? 'nur diese Organisation' : 'alle Microsoft-Konten'}
                {app.provisionedBy ? ` · eingerichtet von ${app.provisionedBy}` : ''} am {fmtDate(app.provisionedAt)}
              </div>
              <div className={cn('mt-0.5', daysLeft !== null && daysLeft < 30 ? 'font-medium text-warning' : 'text-muted')}>
                {daysLeft !== null && daysLeft < 0
                  ? `Clientschlüssel seit ${fmtDate(app.secretExpiresAt)} abgelaufen – bitte erneuern.`
                  : `Clientschlüssel gültig bis ${fmtDate(app.secretExpiresAt)}${daysLeft !== null && daysLeft < 30 ? ' – bald erneuern' : ''}.`}
              </div>
              {!app.consentGranted && (
                <div className="mt-0.5 text-warning">Administratorzustimmung fehlt – Benutzer müssen beim Verbinden einzeln zustimmen oder sie wird im Entra-Portal erteilt.</div>
              )}
              <a className="mt-1 inline-flex items-center gap-1 text-primary hover:underline" href={app.portalUrl} target="_blank" rel="noreferrer">
                Im Entra-Portal öffnen <ExternalLink className="h-3 w-3" />
              </a>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <Wand2 className="h-4 w-4 text-primary" /> Automatisch einrichten
              </div>
              <div className="mt-1 text-muted">
                Mit einem Microsoft-365-Administrator anmelden – Kuvert legt die App-Registrierung mit allen nötigen Berechtigungen, Administratorzustimmung und
                Clientschlüssel selbst an und trägt alles hier ein.
              </div>
            </>
          )}
        </div>
        <Button variant={app ? 'secondary' : 'primary'} size="sm" icon={running ? <Spinner className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
          {running ? 'Einrichtung anzeigen' : app ? 'Schlüssel erneuern' : 'Automatisch einrichten'}
        </Button>
      </div>
      {open && (
        <MsProvisionDialog
          initialJob={running ? data?.job ?? null : null}
          defaultAudience={app?.audience ?? 'tenant'}
          onClose={() => {
            setOpen(false);
            qc.invalidateQueries({ queryKey: overviewKey });
          }}
          onDone={refreshAll}
        />
      )}
    </div>
  );
}

function MsProvisionDialog({
  initialJob,
  defaultAudience,
  onClose,
  onDone,
}: {
  initialJob: MsProvisionStatus | null;
  defaultAudience: MsAppAudience;
  onClose: () => void;
  onDone: () => void;
}) {
  const [adminEmail, setAdminEmail] = useState('');
  const [audience, setAudience] = useState<MsAppAudience>(defaultAudience);
  const [displayName, setDisplayName] = useState('Kuvert');
  const [jobId, setJobId] = useState<string | null>(initialJob?.id ?? null);
  const qc = useQueryClient();

  const start = useMutation({
    mutationFn: () => api<MsProvisionStatus>('/microsoft/provision', { method: 'POST', body: { adminEmail, audience, displayName } }),
    onSuccess: (job) => {
      // Code sofort anzeigen, ohne auf die erste Statusabfrage zu warten
      qc.setQueryData(['admin', 'ms-provision-job', job.id], job);
      setJobId(job.id);
    },
  });

  const jobQuery = useQuery({
    queryKey: ['admin', 'ms-provision-job', jobId],
    queryFn: () => api<MsProvisionStatus>(`/microsoft/provision/${jobId}`),
    enabled: !!jobId,
    initialData: initialJob && initialJob.id === jobId ? initialJob : undefined,
    refetchInterval: (q) => (isActive(q.state.data) ? 2000 : false),
    retry: false,
  });
  const job = jobId ? jobQuery.data ?? null : null;

  // Nach erfolgreichem Abschluss einmalig Einstellungen neu laden
  const notified = useRef(false);
  useEffect(() => {
    if (job?.state === 'done' && !notified.current) {
      notified.current = true;
      onDone();
    }
  }, [job?.state, onDone]);

  const close = () => {
    if (job?.state === 'waiting') void api(`/microsoft/provision/${job.id}`, { method: 'DELETE' }).catch(() => undefined);
    onClose();
  };
  const restart = () => {
    setJobId(null);
    notified.current = false;
    start.reset();
  };

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim());

  let body: ReactNode;
  let footer: ReactNode;

  if (!job) {
    body = (
      <form
        id="ms-provision-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (validEmail) start.mutate();
        }}
      >
        <Field label="Microsoft-365-Administrator" hint="Die Domain bestimmt die Organisation (Tenant), in der die App angelegt wird.">
          <Input type="email" autoFocus autoComplete="off" placeholder="admin@firma.de" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
        </Field>
        <Field label="Wer darf sich anmelden?">
          <Select value={audience} onChange={(e) => setAudience(e.target.value as MsAppAudience)}>
            <option value="tenant">Nur Konten dieser Organisation (empfohlen)</option>
            <option value="multi">Alle Microsoft-Konten (andere Organisationen und private Outlook.com-Konten)</option>
          </Select>
        </Field>
        <Field label="Name der App in Entra ID">
          <Input value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <HelpBox>
          <div className="font-medium">So läuft es ab</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Kuvert zeigt einen Code an. Diesen auf der Microsoft-Anmeldeseite eingeben und mit dem Admin-Konto anmelden (MFA wird unterstützt).</li>
            <li>
              Microsoft fragt, ob <b>„Microsoft Graph Command Line Tools“</b> (ein Werkzeug von Microsoft) in deinem Namen Apps verwalten darf – zustimmen.
            </li>
            <li>Kuvert legt App-Registrierung, alle Graph-Berechtigungen, Administratorzustimmung und einen Clientschlüssel an und speichert sie.</li>
          </ol>
          <div className="mt-1.5 text-muted">
            Kuvert sieht dabei kein Passwort. Die Admin-Anmeldung wird nur für diesen Vorgang verwendet und nicht gespeichert. Benötigt wird die Rolle „Globaler
            Administrator“ (oder „Anwendungsadministrator“ + „Administrator für privilegierte Rollen“).
          </div>
        </HelpBox>
        {start.isError && <HelpBox tone="danger">{errorMessage(start.error)}</HelpBox>}
      </form>
    );
    footer = (
      <>
        <Button onClick={close}>Abbrechen</Button>
        <Button type="submit" form="ms-provision-form" variant="primary" disabled={!validEmail || !displayName.trim()} loading={start.isPending}>
          Weiter
        </Button>
      </>
    );
  } else if (job.state === 'waiting') {
    body = <WaitingForSignIn job={job} adminEmail={adminEmail} />;
    footer = <Button onClick={close}>Abbrechen</Button>;
  } else {
    body = (
      <div className="space-y-4">
        {job.signedInAs && <div className="text-xs text-muted">Angemeldet bei Microsoft als {job.signedInAs}</div>}
        <StepList steps={job.steps} working={job.state === 'working'} />
        {job.state === 'done' && job.result && (
          <HelpBox>
            <div className="font-medium">Microsoft 365 ist eingerichtet.</div>
            <div className="mt-0.5">
              Benutzer können jetzt unter <i>Einstellungen → Konten → Konto hinzufügen → Microsoft 365</i> ihr Konto verbinden. Clientschlüssel gültig bis{' '}
              {fmtDate(job.result.secretExpiresAt)}.
            </div>
            <a className="mt-1 inline-flex items-center gap-1 text-primary hover:underline" href={job.result.portalUrl} target="_blank" rel="noreferrer">
              App im Entra-Portal öffnen <ExternalLink className="h-3 w-3" />
            </a>
          </HelpBox>
        )}
        {(job.state === 'failed' || job.state === 'expired' || job.state === 'cancelled') && (
          <HelpBox tone="danger">{job.error ?? (job.state === 'cancelled' ? 'Der Vorgang wurde abgebrochen.' : 'Die Einrichtung ist fehlgeschlagen.')}</HelpBox>
        )}
        {jobQuery.isError && <HelpBox tone="danger">{errorMessage(jobQuery.error)}</HelpBox>}
      </div>
    );
    footer =
      job.state === 'working' ? (
        <Button onClick={close}>Im Hintergrund weiterlaufen lassen</Button>
      ) : job.state === 'done' ? (
        <Button variant="primary" onClick={close}>
          Fertig
        </Button>
      ) : (
        <>
          <Button onClick={close}>Schließen</Button>
          <Button variant="primary" onClick={restart}>
            Erneut versuchen
          </Button>
        </>
      );
  }

  return (
    <Modal open onClose={close} title="Microsoft 365 automatisch einrichten" description="App-Registrierung in Microsoft Entra ID anlegen lassen" footer={footer}>
      {body}
    </Modal>
  );
}

function WaitingForSignIn({ job, adminEmail }: { job: MsProvisionStatus; adminEmail: string }) {
  const url = job.verificationUri ?? 'https://microsoft.com/devicelogin';
  const code = job.userCode ?? '';
  const until = job.expiresAt ? new Date(job.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border border-border bg-surface-2 p-4 text-center">
        <div className="text-xs text-muted">Anmeldecode</div>
        <div className="mt-1 select-all font-mono text-3xl font-semibold tracking-[0.25em]">{code}</div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button
            variant="primary"
            icon={<ExternalLink className="h-4 w-4" />}
            onClick={() => {
              void navigator.clipboard?.writeText(code).catch(() => undefined);
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
          >
            Code kopieren & Microsoft-Anmeldung öffnen
          </Button>
          <CopyButton value={code} label="Nur kopieren" className="h-9" />
        </div>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted">
        <li>
          Auf <span className="font-mono text-fg">{url.replace(/^https?:\/\//, '')}</span> den Code einfügen.
        </li>
        <li>Mit {adminEmail ? <b className="text-fg">{adminEmail}</b> : 'dem Admin-Konto'} anmelden.</li>
        <li>Die Anfrage von „Microsoft Graph Command Line Tools“ akzeptieren. Das Häkchen „Im Namen Ihrer Organisation zustimmen“ ist dafür nicht nötig.</li>
      </ol>
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" /> Warte auf die Anmeldung bei Microsoft{until ? ` … Code gültig bis ${until} Uhr` : ' …'}
      </div>
    </div>
  );
}

function StepList({ steps, working }: { steps: MsProvisionStep[]; working: boolean }) {
  if (!steps.length && working) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="h-4 w-4" /> Anmeldung erfolgreich – Einrichtung startet …
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm">
          <span className="mt-0.5 shrink-0">
            {s.status === 'running' ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
            ) : s.status === 'done' ? (
              <CircleCheck className="h-4 w-4 text-success" />
            ) : s.status === 'warning' ? (
              <TriangleAlert className="h-4 w-4 text-warning" />
            ) : (
              <CircleX className="h-4 w-4 text-danger" />
            )}
          </span>
          <div className="min-w-0">
            <div className={cn(s.status === 'failed' && 'text-danger')}>{s.label}</div>
            {s.detail && <div className={cn('mt-0.5 text-xs', s.status === 'warning' ? 'text-warning' : 'text-muted')}>{s.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
