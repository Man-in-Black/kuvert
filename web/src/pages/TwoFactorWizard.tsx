import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Smartphone } from 'lucide-react';
import type { TwoFactorSetup } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Button, Checkbox, CodeBox, CopyButton, Skeleton } from '@/components/ui';
import { ErrorBox } from './AuthLayout';
import { CodeInput } from './CodeInput';

/**
 * Einrichtung der Zwei-Faktor-Authentifizierung (TOTP):
 * QR-Code scannen → Code bestätigen → Wiederherstellungscodes sichern.
 * Wird sowohl beim erzwungenen Einrichten als auch im Profil verwendet.
 */
export function TwoFactorWizard({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const start = async () => {
    setError(null);
    try {
      setSetup(await api<TwoFactorSetup>('/auth/2fa/setup', { method: 'POST', body: {} }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  const confirm = async (value = code) => {
    if (busy || value.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code: value } });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div className="space-y-5">
        <Steps step={3} />
        <div>
          <h3 className="text-sm font-semibold">Wiederherstellungscodes sichern</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Falls du keinen Zugriff auf deine Authenticator-App hast, kannst du dich mit einem dieser Codes anmelden. Jeder Code funktioniert
            nur einmal. Bewahre sie sicher auf (z. B. im Passwort-Manager) – sie werden nicht erneut angezeigt.
          </p>
        </div>
        <RecoveryCodes codes={codes} />
        <Checkbox checked={saved} onChange={setSaved} label="Ich habe die Codes sicher gespeichert" />
        <div className="flex justify-end">
          <Button variant="primary" disabled={!saved} onClick={onDone}>
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Steps step={setup ? 2 : 1} />
      <div className="grid gap-5 sm:grid-cols-[180px_1fr] sm:items-start">
        <div className="mx-auto flex h-[180px] w-[180px] items-center justify-center overflow-hidden rounded-2xl border border-border bg-white p-2.5 shadow-card">
          {setup ? (
            <div className="h-full w-full [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-2.5">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="leading-relaxed text-muted">
              Scanne den QR-Code mit einer Authenticator-App (z. B. Microsoft/Google Authenticator, Aegis, 2FAS, 1Password, Bitwarden).
            </p>
          </div>
          {setup && (
            <>
              <div className="text-xs font-medium text-muted">Oder Schlüssel manuell eingeben:</div>
              <CodeBox value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} />
              <a
                href={setup.otpauthUrl}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline sm:hidden"
              >
                <ExternalLink className="h-3.5 w-3.5" /> In Authenticator-App öffnen
              </a>
            </>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">Code aus der App zur Bestätigung</div>
        <CodeInput value={code} onChange={setCode} onComplete={(v) => void confirm(v)} disabled={!setup || busy} autoFocus={false} />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>Abbrechen</Button>}
        <Button variant="primary" loading={busy} disabled={!setup || code.length < 6} onClick={() => void confirm()}>
          Aktivieren
        </Button>
      </div>
    </div>
  );
}

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['Vorbereiten', 'Scannen & bestätigen', 'Codes sichern'];
  return (
    <ol className="flex items-center gap-2 text-xs">
      {labels.map((l, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : 'todo';
        return (
          <li key={l} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={
                state === 'todo'
                  ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-muted'
                  : 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-fg'
              }
            >
              {state === 'done' ? '✓' : n}
            </span>
            <span className={state === 'active' ? 'truncate font-medium text-fg' : 'truncate text-muted'}>{l}</span>
            {n < 3 && <span className="hidden h-px flex-1 bg-border sm:block" />}
          </li>
        );
      })}
    </ol>
  );
}

/** Raster der Wiederherstellungscodes mit Kopieren und Download */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  const download = () => {
    const blob = new Blob([`Kuvert – Wiederherstellungscodes\nErstellt: ${new Date().toLocaleString('de-DE')}\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kuvert-wiederherstellungscodes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-2xl border border-border bg-surface-2 p-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm tracking-wider">
        {codes.map((c) => (
          <span key={c} className="rounded-md bg-surface px-2 py-1 text-center ring-1 ring-border">
            {c}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <CopyButton value={text} label="Alle kopieren" />
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={download}>
          Als Datei speichern
        </Button>
      </div>
    </div>
  );
}
