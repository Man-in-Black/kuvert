import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Settings as SettingsIcon } from 'lucide-react';
import { qk } from '@/lib/queries';
import { useExtensions } from '@/modules/context';
import { SectionLayout } from '@/layout/SectionLayout';
import { copyConsentLink } from './accounts/consent';

/**
 * Einstellungen: links die Abschnitte aller aktiven Module (nach `order`),
 * rechts der gewählte Abschnitt unter /settings/:sectionId.
 */
export function SettingsPage() {
  const sections = useExtensions('settings');
  useOAuthResult();
  return <SectionLayout title="Einstellungen" subtitle="Persönlich & Konten" icon={<SettingsIcon />} basePath="/settings" sections={sections} />;
}

/** Ergebnis der OAuth-Anmeldung (?connected=… / ?error=…) anzeigen und URL bereinigen */
function useOAuthResult() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const handled = useRef<string | null>(null);
  const connected = params.get('connected');
  const error = params.get('error');
  const consentType = params.get('consent');
  const consentState = params.get('consentState');
  const tenant = params.get('tenant');

  useEffect(() => {
    const key = `${connected ?? ''}|${error ?? ''}`;
    if ((!connected && !error) || handled.current === key) return;
    handled.current = key;
    if (connected) {
      toast.success('Konto erfolgreich verbunden');
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['mail'] });
    }
    if (error && consentType && consentState) {
      // Die Organisation des Kontos hat Kuvert noch nicht freigegeben → Administratorzustimmung anbieten
      toast.error('Diese Organisation hat Kuvert noch nicht freigegeben', {
        description: `Ein Administrator der Organisation muss Kuvert einmal zustimmen – entweder direkt hier anmelden oder den Link an ihn weitergeben. (${error})`,
        duration: 60_000,
        action: {
          label: 'Als Admin zustimmen',
          onClick: () => {
            window.location.href = `/api/accounts/oauth/${encodeURIComponent(consentType)}/consent?resume=${encodeURIComponent(consentState)}`;
          },
        },
        cancel: {
          label: 'Link kopieren',
          onClick: () => void copyConsentLink(consentType, tenant),
        },
      });
    } else if (error) toast.error(`Verbindung fehlgeschlagen: ${error}`, { duration: 10_000 });
    const next = new URLSearchParams(params);
    for (const k of ['connected', 'error', 'consent', 'consentState', 'tenant']) next.delete(k);
    setParams(next, { replace: true });
  }, [connected, error, consentType, consentState, tenant, params, setParams, qc]);
}
