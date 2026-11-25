import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { useAppInfo } from '@/lib/queries';
import { Badge, IconButton } from '@/components/ui';
import { Card, SectionHeader } from '../ui';

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Strg', 'K'], label: 'Befehlspalette öffnen' },
  { keys: ['c'], label: 'Neue Nachricht verfassen' },
  { keys: ['j', 'k'], label: 'Nächste / vorherige Nachricht' },
  { keys: ['r'], label: 'Antworten' },
  { keys: ['a'], label: 'Allen antworten' },
  { keys: ['f'], label: 'Weiterleiten' },
  { keys: ['e'], label: 'Archivieren' },
  { keys: ['#', 'Entf'], label: 'Löschen' },
  { keys: ['s'], label: 'Markierung umschalten' },
  { keys: ['u'], label: 'Als ungelesen markieren' },
  { keys: ['/'], label: 'Suche fokussieren' },
  { keys: ['Strg', 'Enter'], label: 'Nachricht senden (im Editor)' },
  { keys: ['Esc'], label: 'Dialog schließen' },
];

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] shadow-sm">{children}</kbd>;
}

export function InfoSection() {
  const { data: app } = useAppInfo();
  if (!app) return null;
  const redirect = `${app.publicUrl}/api/oauth/callback`;
  const features = Object.entries(app.features).filter(([, v]) => v);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('In die Zwischenablage kopiert');
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="Info" description="Version, aktive Module und Hinweise für die Einrichtung." />

      <Card title="System">
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Anwendung</dt>
          <dd>
            {app.name} {app.version}
          </dd>
          <dt className="text-muted">Öffentliche URL</dt>
          <dd className="font-mono text-xs">{app.publicUrl}</dd>
          <dt className="text-muted">OAuth-Weiterleitung</dt>
          <dd className="flex items-center gap-2">
            <code className="truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{redirect}</code>
            <IconButton label="Kopieren" size="icon-sm" onClick={() => copy(redirect)}>
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          </dd>
          <dt className="text-muted">Funktionen</dt>
          <dd className="flex flex-wrap gap-1">
            {features.length === 0 && <span className="text-muted">–</span>}
            {features.map(([k]) => (
              <Badge key={k} color="var(--k-primary)">
                {k}
              </Badge>
            ))}
          </dd>
        </dl>
        <p className="mt-4 text-xs text-muted">
          Die OAuth-Weiterleitungs-URI muss in der Azure-App-Registrierung (Plattform „Web") bzw. im Google-Cloud-OAuth-Client als autorisierte
          Weiterleitungs-URI eingetragen sein.
        </p>
      </Card>

      <Card title="Aktive Module">
        <div className="divide-y divide-border">
          {app.modules.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-3 py-2">
              <div>
                <div className="text-sm font-medium">{m.name}</div>
                {m.description && <div className="text-xs text-muted">{m.description}</div>}
              </div>
              <code className="shrink-0 text-xs text-muted">{m.id}</code>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Tastenkürzel">
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-3 text-sm">
              <span>{s.label}</span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k, i) => (
                  <Kbd key={i}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
