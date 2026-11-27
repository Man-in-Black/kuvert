/**
 * Admin-Seite „Anrufe“: Anbindung an den LiveKit-Server und erlaubte Funktionen.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, PlugZap, Settings2, Video } from 'lucide-react';
import type { MeetAdminConfig, MeetTestResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button, Card, Field, Input, PageHeader, Skeleton, Switch } from '@/components/ui';

const key = ['meet', 'admin', 'config'] as const;

const SETUP_HINT = (
  <>
    Kuvert stellt nur die Zugangs-Tokens aus; Audio, Video und Bildschirmfreigabe laufen über einen selbst gehosteten{' '}
    <a href="https://docs.livekit.io/home/self-hosting/deployment/" target="_blank" rel="noopener noreferrer" className="underline">
      LiveKit-Server
    </a>{' '}
    (z. B. <code>docker compose --profile meet up -d</code>). Der Server braucht von außen erreichbar UDP 7882 und TCP 7881.
  </>
);

export function MeetAdminSection() {
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api<MeetAdminConfig>('/meet/admin/config') });
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Video />}
        title="Anrufe"
        description="Audio- und Videoanrufe mit Bildschirmfreigabe und Whiteboard im Team-Chat – über einen eigenen LiveKit-Server."
      />
      {isLoading || !data ? <Skeleton className="h-40 w-full rounded-2xl" /> : <ConnectionCard data={data} />}
    </div>
  );
}

function ConnectionCard({ data }: { data: MeetAdminConfig }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(data.enabled);
  const [url, setUrl] = useState(data.url);
  const [publicUrl, setPublicUrl] = useState(data.publicUrl);
  const [apiKey, setApiKey] = useState(data.apiKey);
  const [apiSecret, setApiSecret] = useState('');
  const [screenShare, setScreenShare] = useState(data.screenShare);
  const [whiteboard, setWhiteboard] = useState(data.whiteboard);
  const [testResult, setTestResult] = useState<MeetTestResult | null>(null);

  useEffect(() => {
    setEnabled(data.enabled);
    setUrl(data.url);
    setPublicUrl(data.publicUrl);
    setApiKey(data.apiKey);
    setScreenShare(data.screenShare);
    setWhiteboard(data.whiteboard);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api<MeetAdminConfig>('/meet/admin/config', {
        method: 'PUT',
        body: { enabled, url, publicUrl, apiKey, screenShare, whiteboard, ...(apiSecret ? { apiSecret } : {}) },
      }),
    onSuccess: (cfg) => {
      qc.setQueryData(key, cfg);
      qc.invalidateQueries({ queryKey: qk.app }); // Feature-Flags aktualisieren
      setApiSecret('');
      toast.success('Gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api<MeetTestResult>('/meet/admin/test', { method: 'POST', body: { url, apiKey, ...(apiSecret ? { apiSecret } : {}) } }),
    onSuccess: setTestResult,
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err) }),
  });

  return (
    <>
      <Card title="LiveKit-Server" icon={<PlugZap />} description={SETUP_HINT}>
        <div className="space-y-4">
          <Switch checked={enabled} onChange={setEnabled} label="Anrufe im Team-Chat anbieten" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Adresse für Kuvert" hint="Unter dieser Adresse erreicht der Kuvert-Server LiveKit, z. B. http://livekit:7880 im selben Docker-Netz">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://livekit:7880" />
            </Field>
            <Field
              label="Adresse für Browser (optional)"
              hint="Leer = über Kuvert selbst (wss://…/api/meet/lk) – dann braucht LiveKit keine eigene Domain. Ein vorgeschalteter Proxy muss WebSockets weiterleiten."
            >
              <Input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="(über Kuvert)" />
            </Field>
            <Field label="API-Schlüssel" hint="keys: in der LiveKit-Konfiguration (Schlüssel: Geheimnis)">
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" className="font-mono" />
            </Field>
            <Field label="API-Geheimnis" hint={data.secretConfigured ? 'Hinterlegt – leer lassen, um es zu behalten.' : 'Mindestens 32 Zeichen. Verschlüsselt gespeichert.'}>
              <Input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                autoComplete="off"
                className="font-mono"
                placeholder={data.secretConfigured ? '••••••••' : ''}
              />
            </Field>
          </div>
          {testResult && (
            <div
              className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${testResult.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5 text-danger'}`}
            >
              {testResult.ok && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />}
              <span>{testResult.message}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
            <Button loading={test.isPending} disabled={!url || !apiKey || (!apiSecret && !data.secretConfigured)} onClick={() => test.mutate()}>
              Verbindung testen
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Funktionen" icon={<Settings2 />} description="Gilt für alle Anrufe. Änderungen wirken beim nächsten Beitritt.">
        <div className="space-y-3">
          <Switch checked={screenShare} onChange={setScreenShare} label="Bildschirmfreigabe erlauben" />
          <Switch checked={whiteboard} onChange={setWhiteboard} label="Gemeinsames Whiteboard (Excalidraw) erlauben" />
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
        </div>
      </Card>
    </>
  );
}
