import { useNavigate } from 'react-router-dom';
import { BookOpen, Boxes, Cpu, Link2, Server, Variable } from 'lucide-react';
import { useAppInfo } from '@/lib/queries';
import { Badge, Button, Card, CodeBox, PageHeader } from '@/components/ui';

const ENV_HINTS: { name: string; desc: string }[] = [
  { name: 'PUBLIC_URL', desc: 'Externe Adresse (OAuth-Redirects, sichere Cookies)' },
  { name: 'APP_SECRET', desc: 'Schlüssel für Sitzungen und verschlüsselte Zugangsdaten – sichern!' },
  { name: 'MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT', desc: 'Microsoft 365 – Vorgabe, auch unter „Dienste & Anmeldung“ einstellbar' },
  { name: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET', desc: 'Google – Vorgabe, auch unter „Dienste & Anmeldung“ einstellbar' },
  { name: 'AI_BACKEND / AI_BASE_URL / AI_MODEL', desc: 'KI-Assistent – Vorgabe, auch unter „Dienste & Anmeldung“ einstellbar' },
  { name: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY', desc: 'Web Push (leer = automatisch erzeugt)' },
  { name: 'KUVERT_MODULES / KUVERT_DISABLED_MODULES', desc: 'Module fest ein-/ausschalten (Vorrang vor „Module“ im Admin-Bereich)' },
  { name: 'KUVERT_RESTARTABLE', desc: 'Neustart aus der Oberfläche erlauben (true/false, Standard: nur im Container)' },
  { name: 'POLL_INTERVAL / UPLOAD_MAX_MB', desc: 'Abrufintervall (s) und maximale Upload-Größe' },
];

export function SystemSection() {
  const navigate = useNavigate();
  const { data: app } = useAppInfo();
  if (!app) return null;
  const redirect = `${app.publicUrl}/api/oauth/callback`;
  const features = Object.entries(app.features).filter(([, v]) => v);
  const oauthTypes = app.accountTypes.filter((t) => t.auth === 'oauth');

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Server />}
        title="System"
        description={`${app.name} ${app.version} – Module, Integrationen und Konfigurationshinweise.`}
        actions={
          <Button icon={<BookOpen className="h-4 w-4" />} onClick={() => window.open(app.apiDocsUrl, '_blank', 'noopener')}>
            API-Dokumentation
          </Button>
        }
      />

      <Card icon={<Link2 />} title="OAuth-Weiterleitungs-URI" description="In der Azure-/Entra-App-Registrierung (Plattform „Web“) und im Google-OAuth-Client eintragen.">
        <CodeBox value={redirect} />
        {oauthTypes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {oauthTypes.map((t) => (
              <Badge key={t.type} tone={t.configured ? 'success' : 'warning'}>
                {t.label}: {t.configured ? 'konfiguriert' : 'nicht konfiguriert'}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          icon={<Boxes />}
          title="Aktive Module"
          bodyClassName="p-0 pt-2"
          actions={
            <Button size="sm" variant="ghost" onClick={() => navigate('/admin/modules')}>
              Verwalten
            </Button>
          }
        >
          <ul className="divide-y divide-border">
            {app.modules.map((m) => (
              <li key={m.id} className="px-5 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {m.name}
                  <code className="font-mono text-[10px] text-subtle">{m.id}</code>
                </div>
                {m.description && <div className="text-xs text-muted">{m.description}</div>}
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-5">
          <Card icon={<Cpu />} title="Feature-Flags">
            <div className="flex flex-wrap gap-1.5">
              {features.length ? features.map(([k]) => <Badge key={k} tone="primary">{k}</Badge>) : <span className="text-sm text-muted">Keine</span>}
            </div>
          </Card>
          <Card icon={<Variable />} title="Konfiguration (Umgebungsvariablen)" description="Änderungen erfordern einen Neustart des Containers.">
            <dl className="space-y-2.5">
              {ENV_HINTS.map((e) => (
                <div key={e.name}>
                  <dt className="font-mono text-[11px] text-primary">{e.name}</dt>
                  <dd className="text-xs text-muted">{e.desc}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
