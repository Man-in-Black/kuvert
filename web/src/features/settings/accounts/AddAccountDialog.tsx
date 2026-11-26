import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ExternalLink, Wand2 } from 'lucide-react';
import type { AccountInfo, AccountTypeInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useAppInfo } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button, Modal, Spinner } from '@/components/ui';
import { DynamicForm, initialValues, normalizeValues, type FormValues } from '../DynamicForm';
import { HelpBox } from '../ui';
import { copyConsentLink } from './consent';
import { AccountTypeIcon, CapabilityChips, oauthEnvHint } from './shared';

interface AutoconfigResult {
  found: boolean;
  values?: Record<string, unknown>;
  source?: string;
}

export function AddAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: app } = useAppInfo();
  const { data: types = [], isLoading } = useQuery({
    queryKey: ['accounts', 'types'],
    queryFn: () => api<AccountTypeInfo[]>('/accounts/types'),
    enabled: open,
  });
  const [selected, setSelected] = useState<AccountTypeInfo | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState<{ state: 'idle' | 'loading' | 'found' | 'notfound' | 'hidden'; source?: string }>({ state: 'idle' });

  const close = () => {
    setSelected(null);
    setValues({});
    setError(null);
    setAuto({ state: 'idle' });
    onClose();
  };

  const choose = (t: AccountTypeInfo) => {
    if (t.auth === 'oauth') {
      if (!t.configured) return;
      window.location.href = `/api/accounts/oauth/${encodeURIComponent(t.type)}/start`;
      return;
    }
    setSelected(t);
    setValues(initialValues(t.fields));
    setError(null);
    setAuto({ state: 'idle' });
  };

  const emailValue = String(values.email ?? values.username ?? '');

  const runAutoconfig = async () => {
    if (!emailValue.includes('@')) return;
    setAuto({ state: 'loading' });
    try {
      const r = await api<AutoconfigResult>('/imap/autoconfig', { query: { email: emailValue } });
      if (r.found && r.values) {
        setValues((v) => {
          const next = { ...v };
          for (const [k, val] of Object.entries(r.values!)) if (val !== undefined && val !== null && val !== '') next[k] = val;
          return next;
        });
        setAuto({ state: 'found', source: r.source });
      } else setAuto({ state: 'notfound' });
    } catch {
      setAuto({ state: 'hidden' });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const acc = await api<AccountInfo>('/accounts', { method: 'POST', body: { type: selected.type, values: normalizeValues(selected.fields, values) } });
      toast.success(`Konto „${acc.name}" hinzugefügt`);
      await qc.invalidateQueries({ queryKey: qk.accounts });
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const redirectUri = `${app?.publicUrl ?? window.location.origin}/api/oauth/callback`;

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={
        selected ? (
          <span className="flex items-center gap-2">
            <button type="button" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => setSelected(null)} aria-label="Zurück">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <AccountTypeIcon type={selected.type} icon={selected.icon} capabilities={selected.capabilities} />
            {selected.label}
          </span>
        ) : (
          'Konto hinzufügen'
        )
      }
      footer={
        selected ? (
          <>
            <Button onClick={() => setSelected(null)}>Zurück</Button>
            <Button variant="primary" type="submit" form="add-account-form" loading={busy}>
              Verbinden &amp; speichern
            </Button>
          </>
        ) : undefined
      }
    >
      {!selected && (
        <>
          {isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {types.map((t) => {
              const disabled = t.auth === 'oauth' && !t.configured;
              return (
                <button
                  key={t.type}
                  type="button"
                  disabled={disabled}
                  onClick={() => choose(t)}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-xl border border-border p-4 text-left transition-colors',
                    disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-primary hover:bg-primary-soft/40',
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <AccountTypeIcon type={t.type} icon={t.icon} capabilities={t.capabilities} className="h-6 w-6" />
                    <span className="font-medium">{t.label}</span>
                    {t.auth === 'oauth' && !disabled && <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted" />}
                  </div>
                  {t.description && <p className="text-xs text-muted">{t.description}</p>}
                  <CapabilityChips caps={t.capabilities} />
                  {disabled && <p className="text-[11px] text-warning">Nicht konfiguriert: {oauthEnvHint(t)}</p>}
                </button>
              );
            })}
          </div>
          {types
            .filter((t) => t.auth === 'oauth' && t.configured && t.adminConsent)
            .map((t) => (
              <div key={`consent-${t.type}`} className="mt-4">
                <HelpBox>
                  <div className="font-medium">{t.label}: Konto einer anderen Organisation?</div>
                  <div className="mt-0.5">
                    Beim ersten Konto einer fremden Organisation muss deren Administrator Kuvert einmal zustimmen. Danach können sich alle Benutzer dieser
                    Organisation normal verbinden.
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => (window.location.href = `/api/accounts/oauth/${encodeURIComponent(t.type)}/consent?returnTo=${encodeURIComponent('/settings/accounts')}`)}
                    >
                      Als Administrator zustimmen
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void copyConsentLink(t.type)}>
                      Link für den Administrator kopieren
                    </Button>
                  </div>
                </HelpBox>
              </div>
            ))}
          {types.some((t) => t.auth === 'oauth') && (
            <div className="mt-4">
              <HelpBox>
                Für Microsoft 365 und Google muss in der jeweiligen App-Registrierung folgende Weiterleitungs-URI eingetragen sein:{' '}
                <code className="rounded bg-surface px-1 py-0.5 font-mono">{redirectUri}</code>
              </HelpBox>
            </div>
          )}
        </>
      )}

      {selected && (
        <form id="add-account-form" onSubmit={submit} className="space-y-4">
          {selected.description && <p className="text-sm text-muted">{selected.description}</p>}
          {selected.type === 'imap' && auto.state !== 'hidden' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
              <Button size="sm" icon={<Wand2 className="h-3.5 w-3.5" />} onClick={runAutoconfig} loading={auto.state === 'loading'} disabled={!emailValue.includes('@')}>
                Automatisch ermitteln
              </Button>
              <span className="text-xs text-muted">
                {auto.state === 'found' && `Servereinstellungen gefunden${auto.source ? ` (${auto.source})` : ''} – bitte prüfen.`}
                {auto.state === 'notfound' && 'Keine Einstellungen gefunden – bitte manuell eintragen.'}
                {auto.state === 'idle' && 'E-Mail-Adresse eingeben, dann Server automatisch ermitteln lassen.'}
              </span>
            </div>
          )}
          <DynamicForm fields={selected.fields ?? []} values={values} onChange={setValues} disabled={busy} />
          {error && <HelpBox tone="danger">{error}</HelpBox>}
        </form>
      )}
    </Modal>
  );
}
