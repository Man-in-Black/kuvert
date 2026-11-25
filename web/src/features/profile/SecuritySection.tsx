import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, LockKeyhole, LogOut, Monitor, ShieldCheck, ShieldOff, Smartphone, Tablet, Terminal } from 'lucide-react';
import type { SessionInfo, TwoFactorStatus } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Skeleton, useConfirm } from '@/components/ui';
import { TwoFactorWizard, RecoveryCodes } from '@/pages/TwoFactorWizard';
import { PasswordStrength } from '@/pages/PasswordStrength';
import { CodeInput } from '@/pages/CodeInput';
import { parseUserAgent, relativeTime, absoluteTime } from './format';

const twoFaKey = ['auth', '2fa'] as const;
const sessionsKey = ['profile', 'sessions'] as const;

export function SecuritySection() {
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LockKeyhole />}
        title="Sicherheit"
        description="Passwort, Zwei-Faktor-Authentifizierung und angemeldete Geräte verwalten."
      />
      <TwoFactorCard />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}

/* ───────────────────────────── Passwort ───────────────────────────── */

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError('Das neue Passwort muss mindestens 8 Zeichen haben.');
    if (next !== repeat) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { current, next } });
      toast.success('Passwort geändert. Andere Sitzungen wurden abgemeldet.');
      setCurrent('');
      setNext('');
      setRepeat('');
      qc.invalidateQueries({ queryKey: sessionsKey });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card icon={<KeyRound />} title="Passwort ändern" description="Nach der Änderung werden alle anderen Sitzungen abgemeldet.">
      <form onSubmit={submit} className="grid max-w-md gap-3">
        <Field label="Aktuelles Passwort">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label="Neues Passwort">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
        </Field>
        <PasswordStrength value={next} />
        <Field label="Neues Passwort wiederholen">
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required autoComplete="new-password" />
        </Field>
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Passwort ändern
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ───────────────────────────── Zwei-Faktor ───────────────────────────── */

function TwoFactorCard() {
  const qc = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: twoFaKey, queryFn: () => api<TwoFactorStatus>('/auth/2fa') });
  const [wizard, setWizard] = useState(false);
  const [disable, setDisable] = useState(false);
  const [regen, setRegen] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: twoFaKey });
    qc.invalidateQueries({ queryKey: qk.app });
    qc.invalidateQueries({ queryKey: ['profile'] });
  };

  return (
    <Card
      icon={<ShieldCheck />}
      title="Zwei-Faktor-Authentifizierung"
      description="Schützt dein Konto zusätzlich mit einem Einmalcode aus einer Authenticator-App."
      actions={
        status && (
          <Badge tone={status.enabled ? 'success' : 'warning'} className="text-xs">
            {status.enabled ? 'Aktiv' : 'Nicht eingerichtet'}
          </Badge>
        )
      }
    >
      {isLoading || !status ? (
        <Skeleton className="h-16 w-full" />
      ) : status.enabled ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <div className="font-medium">Authenticator-App verbunden</div>
            <div className={cn('mt-0.5 text-xs', status.recoveryCodesLeft <= 3 ? 'text-warning' : 'text-muted')}>
              {status.recoveryCodesLeft} Wiederherstellungscodes übrig
              {status.recoveryCodesLeft <= 3 && ' – bitte neue erzeugen'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setRegen(true)}>
              Neue Wiederherstellungscodes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger/10"
              icon={<ShieldOff className="h-3.5 w-3.5" />}
              disabled={status.required}
              title={status.required ? 'Per Richtlinie vorgeschrieben' : undefined}
              onClick={() => setDisable(true)}
            >
              Deaktivieren
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-lg text-sm leading-relaxed text-muted">
            Nach der Einrichtung wird bei jeder Anmeldung zusätzlich ein 6-stelliger Code abgefragt. Für den Notfall erhältst du
            Wiederherstellungscodes.
          </p>
          <Button variant="primary" onClick={() => setWizard(true)}>
            Jetzt einrichten
          </Button>
        </div>
      )}
      {status?.required && <p className="mt-3 text-xs text-muted">Hinweis: Die Zwei-Faktor-Authentifizierung ist per Richtlinie für alle Benutzer vorgeschrieben.</p>}

      <Modal open={wizard} onClose={() => setWizard(false)} title="Zwei-Faktor-Authentifizierung einrichten" size="lg">
        <TwoFactorWizard
          onCancel={() => setWizard(false)}
          onDone={() => {
            setWizard(false);
            refresh();
            toast.success('Zwei-Faktor-Authentifizierung ist aktiv');
          }}
        />
      </Modal>
      <DisableDialog
        open={disable}
        onClose={() => setDisable(false)}
        onDone={() => {
          setDisable(false);
          refresh();
        }}
      />
      <RegenerateDialog open={regen} onClose={() => setRegen(false)} onDone={refresh} />
    </Card>
  );
}

function DisableDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => api('/auth/2fa/disable', { method: 'POST', body: { password } }),
    onSuccess: () => {
      toast.success('Zwei-Faktor-Authentifizierung deaktiviert');
      setPassword('');
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="2FA deaktivieren"
      description="Dein Konto ist danach nur noch durch das Passwort geschützt."
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" loading={m.isPending} disabled={!password} onClick={() => m.mutate()}>
            Deaktivieren
          </Button>
        </>
      }
    >
      <Field label="Passwort zur Bestätigung">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
      </Field>
    </Modal>
  );
}

function RegenerateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const m = useMutation({
    mutationFn: (c: string) => api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST', body: { code: c } }),
    onSuccess: (res) => {
      setCodes(res.recoveryCodes);
      onDone();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      setCode('');
    },
  });
  const close = () => {
    setCode('');
    setCodes(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Neue Wiederherstellungscodes" size="md">
      {codes ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Die bisherigen Codes sind ab sofort ungültig. Bitte speichere die neuen Codes sicher.</p>
          <RecoveryCodes codes={codes} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Fertig
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">Bestätige mit einem aktuellen Code aus deiner Authenticator-App.</p>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => m.mutate(v)} disabled={m.isPending} />
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Abbrechen</Button>
            <Button variant="primary" loading={m.isPending} disabled={code.length < 6} onClick={() => m.mutate(code)}>
              Codes erzeugen
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────────── Sitzungen ───────────────────────────── */

function DeviceIcon({ device }: { device: string }) {
  const Icon = device === 'mobile' ? Smartphone : device === 'tablet' ? Tablet : device === 'api' ? Terminal : Monitor;
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted ring-1 ring-border">
      <Icon className="h-5 w-5" />
    </span>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { data: sessions, isLoading } = useQuery({ queryKey: sessionsKey, queryFn: () => api<SessionInfo[]>('/profile/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/profile/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionsKey }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api('/profile/sessions/revoke-others', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Alle anderen Sitzungen wurden abgemeldet');
      qc.invalidateQueries({ queryKey: sessionsKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <Card
      icon={<Monitor />}
      title="Angemeldete Geräte"
      description="Hier siehst du, wo dein Konto gerade angemeldet ist."
      actions={
        others > 0 && (
          <Button
            size="sm"
            icon={<LogOut className="h-3.5 w-3.5" />}
            loading={revokeOthers.isPending}
            onClick={async () => {
              if (await confirm(`${others} andere Sitzung(en) abmelden?`)) revokeOthers.mutate();
            }}
          >
            Alle anderen abmelden
          </Button>
        )
      }
      bodyClassName="p-0 pt-2"
    >
      {isLoading ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {(sessions ?? []).map((s) => {
            const ua = parseUserAgent(s.userAgent);
            return (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <DeviceIcon device={ua.device} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {ua.browser}
                    {ua.os && <span className="font-normal text-muted">auf {ua.os}</span>}
                    {s.current && <Badge tone="success">Diese Sitzung</Badge>}
                    {s.twoFactor && <Badge tone="primary">2FA</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted" title={`Angemeldet ${absoluteTime(s.createdAt)} · gültig bis ${absoluteTime(s.expiresAt)}`}>
                    {s.ip ?? 'IP unbekannt'} · zuletzt aktiv {relativeTime(s.lastSeenAt ?? s.createdAt)}
                  </div>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>
                    Abmelden
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </Card>
  );
}
