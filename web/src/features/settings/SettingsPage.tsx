import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Settings as SettingsIcon } from 'lucide-react';
import { qk } from '@/lib/queries';
import { useExtensions } from '@/modules/context';
import { SectionLayout } from '@/layout/SectionLayout';

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

  useEffect(() => {
    const key = `${connected ?? ''}|${error ?? ''}`;
    if ((!connected && !error) || handled.current === key) return;
    handled.current = key;
    if (connected) {
      toast.success('Konto erfolgreich verbunden');
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['mail'] });
    }
    if (error) toast.error(`Verbindung fehlgeschlagen: ${error}`, { duration: 10_000 });
    const next = new URLSearchParams(params);
    next.delete('connected');
    next.delete('error');
    setParams(next, { replace: true });
  }, [connected, error, params, setParams, qc]);
}
