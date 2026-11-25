/**
 * Erzwungene Sicherheitsschritte nach der Anmeldung:
 *  - neues Passwort festlegen (Admin hat ein Startpasswort vergeben)
 *  - Zwei-Faktor-Authentifizierung einrichten (Richtlinie)
 */
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button, Field, Input } from '@/components/ui';
import { AuthHeading, AuthLayout, ErrorBox } from './AuthLayout';
import { TwoFactorWizard } from './TwoFactorWizard';
import { PasswordStrength } from './PasswordStrength';

function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    await qc.invalidateQueries({ queryKey: qk.app });
  };
}

function LogoutLink() {
  const logout = useLogout();
  return (
    <button type="button" onClick={() => void logout()} className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
      <LogOut className="h-3.5 w-3.5" /> Abmelden
    </button>
  );
}

export function ForcedPasswordPage() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError('Das neue Passwort muss mindestens 8 Zeichen haben.');
    if (next !== repeat) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { current, next } });
      await qc.invalidateQueries({ queryKey: qk.app });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <AuthHeading
        icon={<KeyRound />}
        title="Neues Passwort festlegen"
        subtitle="Dein Konto wurde mit einem vorläufigen Passwort angelegt oder zurückgesetzt. Bitte wähle jetzt ein eigenes Passwort."
      />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Vorläufiges Passwort">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus autoComplete="current-password" className="h-10" />
        </Field>
        <Field label="Neues Passwort">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" className="h-10" />
        </Field>
        <PasswordStrength value={next} />
        <Field label="Neues Passwort wiederholen">
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required autoComplete="new-password" className="h-10" />
        </Field>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={busy}>
          Passwort speichern
        </Button>
      </form>
      <LogoutLink />
    </AuthLayout>
  );
}

export function ForcedTwoFactorPage() {
  const qc = useQueryClient();
  return (
    <AuthLayout wide>
      <AuthHeading
        icon={<ShieldCheck />}
        title="Zwei-Faktor-Authentifizierung einrichten"
        subtitle="Dein Administrator schreibt für alle Konten einen zweiten Faktor vor. Die Einrichtung dauert etwa eine Minute."
      />
      <TwoFactorWizard onDone={() => void qc.invalidateQueries({ queryKey: qk.app })} />
      <LogoutLink />
    </AuthLayout>
  );
}
