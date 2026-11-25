import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import type { LoginResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button, Field, Input } from '@/components/ui';
import { AuthHeading, AuthLayout, ErrorBox } from './AuthLayout';
import { CodeInput } from './CodeInput';

/** Anmeldung (inkl. zweitem Faktor), Registrierung bzw. Ersteinrichtung (erster Benutzer = Administrator). */
export function LoginPage({ setup, allowRegistration }: { setup: boolean; allowRegistration: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>(setup ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: qk.app });
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        const res = await api<LoginResult>('/auth/login', { method: 'POST', body: { email, password } });
        if (res.twoFactorRequired) {
          setTicket(res.ticket);
          setCode('');
          return;
        }
      } else {
        await api(setup ? '/auth/setup' : '/auth/register', { method: 'POST', body: { email, name, password } });
      }
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value = code) => {
    if (!ticket || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login/2fa', { method: 'POST', body: { ticket, code: value } });
      await finish();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      setCode('');
      if (/abgelaufen/i.test(msg)) setTicket(null);
    } finally {
      setBusy(false);
    }
  };

  /* ───────────── Schritt 2: zweiter Faktor ───────────── */
  if (ticket) {
    return (
      <AuthLayout>
        <AuthHeading
          icon={<ShieldCheck />}
          title="Bestätigung erforderlich"
          subtitle={
            useRecovery
              ? 'Gib einen deiner Wiederherstellungscodes ein. Jeder Code ist nur einmal gültig.'
              : 'Gib den 6-stelligen Code aus deiner Authenticator-App ein.'
          }
        />
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode();
          }}
        >
          {useRecovery ? (
            <Field label="Wiederherstellungscode">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="xxxxx-xxxxx"
                autoFocus
                autoComplete="off"
                className="h-11 font-mono tracking-wider"
              />
            </Field>
          ) : (
            <CodeInput value={code} onChange={setCode} onComplete={(v) => void submitCode(v)} disabled={busy} />
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
          <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={busy} disabled={useRecovery ? code.trim().length < 10 : code.length < 6}>
            Bestätigen
          </Button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
              onClick={() => {
                setTicket(null);
                setError(null);
                setCode('');
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Zurück
            </button>
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Authenticator-Code verwenden' : 'Wiederherstellungscode verwenden'}
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  /* ───────────── Schritt 1: Zugangsdaten ───────────── */
  const isRegister = mode === 'register';
  return (
    <AuthLayout>
      <AuthHeading
        icon={setup ? <KeyRound /> : isRegister ? <UserPlus /> : <LogIn />}
        title={setup ? 'Willkommen bei Kuvert' : isRegister ? 'Konto erstellen' : 'Willkommen zurück'}
        subtitle={
          setup
            ? 'Lege das Administrator-Konto an. Weitere Benutzer verwaltest du anschließend im Admin-Bereich.'
            : isRegister
              ? 'Erstelle ein neues Benutzerkonto.'
              : 'Melde dich mit deiner E-Mail-Adresse an.'
        }
      />
      <form onSubmit={submit} className="space-y-4">
        {isRegister && (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" className="h-10" placeholder="Max Mustermann" />
          </Field>
        )}
        <Field label="E-Mail">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="username"
            className="h-10"
            placeholder="name@firma.de"
          />
        </Field>
        <Field label="Passwort" hint={isRegister ? 'Mindestens 8 Zeichen' : undefined}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isRegister ? 8 : undefined}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            className="h-10"
          />
        </Field>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Button type="submit" variant="primary" size="lg" className="mt-2 w-full justify-center" loading={busy}>
          {setup ? 'Einrichten & loslegen' : isRegister ? 'Registrieren' : 'Anmelden'}
        </Button>
        {!setup && allowRegistration && (
          <p className="pt-1 text-center text-xs text-muted">
            {isRegister ? 'Bereits registriert? ' : 'Noch kein Konto? '}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setMode(isRegister ? 'login' : 'register');
                setError(null);
              }}
            >
              {isRegister ? 'Anmelden' : 'Jetzt registrieren'}
            </button>
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
