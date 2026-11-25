/** Einstellungen → Suche: Index-Status pro Konto und Hilfe zu Suchbefehlen. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Search, Zap } from 'lucide-react';
import type { SearchAccountStatus, SearchStatus } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge, Button, Card, PageHeader, Progress, Skeleton, Switch } from '@/components/ui';
import { HelpBox } from '@/features/settings/ui';

const statusKey = ['search', 'status'] as const;

export const SEARCH_SYNTAX: { cmd: string; desc: string }[] = [
  { cmd: 'from:anna', desc: 'Absender (Name, Adresse oder Domain)' },
  { cmd: 'to:bob@firma.de', desc: 'Empfänger (An/Cc)' },
  { cmd: 'subject:rechnung', desc: 'Begriff (auch im Betreff)' },
  { cmd: 'has:attachment', desc: 'nur mit Anhang' },
  { cmd: 'is:unread · is:read · is:flagged', desc: 'Status' },
  { cmd: 'in:inbox · in:sent · in:archive', desc: 'Ordnerart (oder Ordnername)' },
  { cmd: 'after:2026-01-01 · before:31.12.2025', desc: 'Zeitraum' },
  { cmd: '"exakte phrase"', desc: 'Wortgruppe' },
];

export function SearchSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: statusKey,
    queryFn: () => api<SearchStatus>('/search/status'),
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.state === 'indexing' || a.state === 'pending' || a.bodiesPending > 0) ? 2500 : 20000),
  });

  const exclude = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) => api(`/search/accounts/${id}/excluded`, { method: 'PUT', body: { excluded } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: statusKey });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reindex = useMutation({
    mutationFn: (id: string) => api(`/search/accounts/${id}/reindex`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success('Konto wird neu indiziert');
      qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Search />}
        title="Suche"
        description="Kuvert legt einen Suchindex über alle Konten an. Damit findest du Nachrichten in Millisekunden – auch mit Tippfehlern und über alle Postfächer hinweg."
      />

      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !data?.enabled ? (
        <HelpBox>Der Suchindex ist auf diesem Server nicht eingerichtet. Die Suche läuft live beim jeweiligen Anbieter. Ein Administrator kann ihn unter Admin → Dienste &amp; Anmeldung aktivieren.</HelpBox>
      ) : (
        <Card title="Konten im Suchindex" description="Neue Mails, Verschieben und Löschen werden automatisch übernommen.">
          {!data.available && (
            <div className="mb-3">
              <HelpBox tone="warning">Suchindex zurzeit nicht erreichbar{data.error ? `: ${data.error}` : ''}. Bis dahin wird live beim Anbieter gesucht.</HelpBox>
            </div>
          )}
          <div className="divide-y divide-border">
            {data.accounts.map((a) => (
              <AccountRow
                key={a.accountId}
                a={a}
                onToggle={(on) => exclude.mutate({ id: a.accountId, excluded: !on })}
                onReindex={() => reindex.mutate(a.accountId)}
                busy={exclude.isPending || reindex.isPending}
              />
            ))}
            {!data.accounts.length && <div className="py-6 text-center text-sm text-muted">Noch keine Mail-Konten verbunden.</div>}
          </div>
        </Card>
      )}

      <Card title="Suchbefehle" description="Lassen sich frei kombinieren, z. B. „from:anna has:attachment angebot after:2026-01-01“.">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {SEARCH_SYNTAX.map((s) => (
            <div key={s.cmd} className="flex flex-col">
              <code className="text-[13px] font-medium text-primary">{s.cmd}</code>
              <span className="text-xs text-muted">{s.desc}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AccountRow({ a, onToggle, onReindex, busy }: { a: SearchAccountStatus; onToggle: (on: boolean) => void; onReindex: () => void; busy: boolean }) {
  const indexing = a.state === 'indexing' || a.state === 'pending';
  const folderPct = a.foldersTotal ? (a.foldersDone / a.foldersTotal) * 100 : 0;
  const bodyPct = a.documents ? ((a.documents - a.bodiesPending) / a.documents) * 100 : 0;
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{a.name}</span>
          <StateBadge a={a} />
        </div>
        <div className="truncate text-xs text-muted">{a.email}</div>
        {!a.excluded && (
          <div className="mt-1.5 text-xs text-muted">
            {a.documents.toLocaleString('de-DE')} Nachrichten
            {a.lastSyncAt && ` · aktualisiert ${formatDistanceToNow(new Date(a.lastSyncAt), { locale: de, addSuffix: true })}`}
            {indexing && a.currentFolder && ` · ${a.currentFolder}`}
          </div>
        )}
        {!a.excluded && a.state !== 'ready' && a.foldersTotal > 0 && <Progress value={folderPct} className="mt-2 max-w-sm" />}
        {!a.excluded && a.state === 'ready' && a.bodiesPending > 0 && (
          <div className="mt-2 max-w-sm">
            <Progress value={bodyPct} tone="success" />
            <div className="mt-1 text-[11px] text-muted">Volltext wird ergänzt – noch {a.bodiesPending.toLocaleString('de-DE')} Nachrichten</div>
          </div>
        )}
        {a.error && <div className="mt-1 text-xs text-danger">{a.error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={busy || a.excluded} onClick={onReindex}>
          Neu indizieren
        </Button>
        <Switch checked={!a.excluded} onChange={onToggle} disabled={busy} />
      </div>
    </div>
  );
}

function StateBadge({ a }: { a: SearchAccountStatus }) {
  if (a.excluded || a.state === 'disabled') return <Badge>Nicht im Index</Badge>;
  if (a.state === 'error')
    return (
      <Badge tone="danger">
        <AlertTriangle className="h-3 w-3" /> Fehler
      </Badge>
    );
  if (a.state === 'ready')
    return a.bodiesPending > 0 ? (
      <Badge tone="success">
        <Zap className="h-3 w-3" /> Durchsuchbar
      </Badge>
    ) : (
      <Badge tone="success">
        <CheckCircle2 className="h-3 w-3" /> Bereit
      </Badge>
    );
  return (
    <Badge tone="info">
      <Loader2 className="h-3 w-3 animate-spin" /> Wird indiziert
    </Badge>
  );
}
