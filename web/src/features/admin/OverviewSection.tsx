import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  CalendarClock,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Plug,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
} from 'lucide-react';
import type { AdminOverview } from '@kuvert/shared';
import { api } from '@/lib/api';
import { useAppInfo } from '@/lib/queries';
import { Badge, Button, Card, PageHeader, Progress, Skeleton, StatCard } from '@/components/ui';
import { formatBytes, formatDuration, relativeTime } from '@/features/profile/format';
import { auditLabel, auditTone } from './audit-labels';

export const overviewKey = ['admin', 'overview'] as const;

export function OverviewSection() {
  const navigate = useNavigate();
  const { data: app } = useAppInfo();
  const { data, isLoading } = useQuery({ queryKey: overviewKey, queryFn: () => api<AdminOverview>('/admin/overview'), refetchInterval: 60_000 });

  if (isLoading || !data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const twoFaPct = data.users.total ? Math.round((data.users.with2fa / data.users.total) * 100) : 0;
  const types = Object.entries(data.accounts.byType).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...types.map(([, n]) => n));
  const typeLabel = (t: string) => app?.accountTypes.find((x) => x.type === t)?.label ?? t;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<LayoutDashboard />}
        title="Übersicht"
        description="Zustand deiner Kuvert-Installation auf einen Blick."
        actions={
          <>
            <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => navigate('/admin/users?new=1')}>
              Benutzer anlegen
            </Button>
            <Button icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => navigate('/admin/policies')}>
              Richtlinien
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Benutzer" value={data.users.total} icon={<Users />} hint={`${data.users.admins} Admin(s) · ${data.users.disabled} deaktiviert`}>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted">
              <span>Mit 2FA</span>
              <span className="tabular-nums">{twoFaPct} %</span>
            </div>
            <Progress value={twoFaPct} tone={twoFaPct === 100 ? 'success' : twoFaPct >= 50 ? 'primary' : 'warning'} />
          </div>
        </StatCard>
        <StatCard label="Aktive Sitzungen" value={data.sessionsActive} icon={<Activity />} tone="info" hint="Angemeldete Browser & Geräte" />
        <StatCard
          label="Verbundene Konten"
          value={data.accounts.total}
          icon={<Plug />}
          tone={data.accounts.withErrors ? 'warning' : 'success'}
          hint={data.accounts.withErrors ? `${data.accounts.withErrors} mit Fehlern` : 'Alle Konten in Ordnung'}
        />
        <StatCard label="Geplanter Versand" value={data.scheduledPending} icon={<CalendarClock />} tone="neutral" hint="Ausstehende Nachrichten" />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3" icon={<Plug />} title="Konten nach Anbieter">
          {types.length === 0 ? (
            <p className="text-sm text-muted">Noch keine Konten verbunden.</p>
          ) : (
            <div className="space-y-3">
              {types.map(([t, n]) => (
                <div key={t} className="grid grid-cols-[120px_1fr_32px] items-center gap-3 text-sm">
                  <span className="truncate text-muted">{typeLabel(t)}</span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-gradient-to-r from-primary to-sky-500 transition-all duration-700" style={{ width: `${(n / maxType) * 100}%` }} />
                  </div>
                  <span className="text-right font-medium tabular-nums">{n}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2" icon={<Gauge />} title="System">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Item label="Version" value={data.version} />
            <Item label="Laufzeit" value={formatDuration(data.uptimeSec)} />
            <Item label="Node.js" value={data.nodeVersion} />
            <Item label="Module" value={String(data.modules.length)} />
            <Item label="Datenbank" value={formatBytes(data.dbSizeBytes)} icon={<Database className="h-3.5 w-3.5" />} />
            <Item label="Uploads" value={formatBytes(data.uploadsSizeBytes)} />
            <Item label="API-Tokens" value={String(data.apiTokens)} icon={<KeyRound className="h-3.5 w-3.5" />} />
            <Item label="2FA-Abdeckung" value={`${data.users.with2fa}/${data.users.total}`} icon={<ShieldCheck className="h-3.5 w-3.5" />} />
          </dl>
          <Button size="sm" variant="soft" className="mt-4" icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => window.open(app?.apiDocsUrl ?? '/api/docs', '_blank', 'noopener')}>
            API-Dokumentation
          </Button>
        </Card>
      </div>

      <Card
        icon={<ScrollText />}
        title="Letzte Ereignisse"
        actions={
          <Button size="sm" variant="ghost" onClick={() => navigate('/admin/audit')}>
            Alle anzeigen
          </Button>
        }
        bodyClassName="p-0 pt-2"
      >
        {data.recentAudit.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted">Noch keine Einträge.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.recentAudit.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <Badge tone={auditTone(e.action)}>{auditLabel(e.action)}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {e.actorEmail ?? (e.details?.email as string | undefined) ?? 'System'}
                  {e.userEmail && e.userEmail !== e.actorEmail && <> → {e.userEmail}</>}
                </span>
                <span className="shrink-0 text-xs text-subtle">{relativeTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Item({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-subtle">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-medium">{value}</dd>
    </div>
  );
}
