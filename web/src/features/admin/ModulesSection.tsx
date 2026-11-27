import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plug, Puzzle, RotateCcw } from 'lucide-react';
import type { AdminModulesView, AdminModuleState } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge, Button, Card, CodeBox, Modal, PageHeader, Skeleton, Spinner, Switch, useConfirm } from '@/components/ui';
import { HelpBox } from '@/features/settings/ui';

export const modulesKey = ['admin', 'modules'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wartet, bis der Server nach dem Neustart wieder antwortet, und lädt dann die Seite neu */
async function waitForRestart(): Promise<boolean> {
  const started = Date.now();
  let wentDown = false;
  await sleep(1500);
  while (Date.now() - started < 120_000) {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      // Antwortet noch der alte Prozess? Erst nach einer Unterbrechung (oder spätestens nach 8 s) neu laden.
      if (r.ok && (wentDown || Date.now() - started > 8000)) {
        window.location.reload();
        return true;
      }
      if (!r.ok) wentDown = true;
    } catch {
      wentDown = true;
    }
    await sleep(1500);
  }
  return false;
}

export function ModulesSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [restarting, setRestarting] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: modulesKey, queryFn: () => api<AdminModulesView>('/admin/modules') });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<AdminModulesView>(`/admin/modules/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } }),
    onSuccess: (res) => qc.setQueryData(modulesKey, res),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const onToggle = async (m: AdminModuleState, enabled: boolean) => {
    if (!enabled && m.accounts > 0) {
      const ok = await confirm(
        <>
          <p>
            <strong>{m.name}</strong> wird von {m.accounts === 1 ? 'einem verbundenen Konto' : `${m.accounts} verbundenen Konten`} genutzt.
          </p>
          <p className="mt-2">Nach dem Neustart lassen sich diese Konten nicht mehr abrufen, bis das Modul wieder aktiviert wird. Die Konten selbst bleiben erhalten.</p>
        </>,
        { danger: true },
      );
      if (!ok) return;
    }
    toggle.mutate({ id: m.id, enabled });
  };

  const restart = async () => {
    const ok = await confirm('Kuvert jetzt neu starten? Alle Benutzer werden für einige Sekunden getrennt; laufende Uploads brechen ab.');
    if (!ok) return;
    setRestarting(true);
    try {
      await api('/admin/restart', { method: 'POST' });
    } catch (err) {
      toast.error(errorMessage(err));
      setRestarting(false);
      return;
    }
    if (!(await waitForRestart())) {
      setRestarting(false);
      toast.error('Kuvert antwortet nach dem Neustart nicht – bitte den Container prüfen.');
    }
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Puzzle />}
        title="Module"
        description="Funktionen von Kuvert für alle Benutzer ein- oder ausschalten. Änderungen wirken nach einem Neustart."
        actions={
          data.restartable && (
            <Button variant={data.pending ? 'primary' : 'secondary'} icon={<RotateCcw className="h-4 w-4" />} loading={restarting} onClick={restart}>
              Neu starten
            </Button>
          )
        }
      />

      {data.pending && (
        <HelpBox tone="warning">
          <div className="space-y-2">
            <p>
              <strong>Änderungen warten auf einen Neustart.</strong> Bis dahin läuft Kuvert mit den bisherigen Modulen.
            </p>
            {data.restartable ? (
              <Button size="sm" variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={restarting} onClick={restart}>
                Jetzt neu starten
              </Button>
            ) : (
              <>
                <p>Kuvert kann sich hier nicht selbst neu starten. Bitte den Dienst neu starten, z. B.:</p>
                <CodeBox value="docker compose restart kuvert" />
              </>
            )}
          </div>
        </HelpBox>
      )}

      <Card bodyClassName="p-0">
        <ul className="divide-y divide-border">
          {data.modules.map((m) => (
            <ModuleRow key={m.id} m={m} busy={toggle.isPending && toggle.variables?.id === m.id} onToggle={(v) => void onToggle(m, v)} />
          ))}
        </ul>
      </Card>

      <p className="text-xs text-muted">
        Module, die per <code className="font-mono">KUVERT_MODULES</code> oder <code className="font-mono">KUVERT_DISABLED_MODULES</code> festgelegt sind, lassen sich hier
        nicht ändern. Beim Abschalten bleiben die Daten eines Moduls erhalten.
      </p>

      <Modal open={restarting} onClose={() => undefined} size="sm">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <Spinner className="h-6 w-6" />
          <div className="text-sm font-medium">Kuvert startet neu …</div>
          <div className="text-xs text-muted">Die Seite lädt automatisch neu, sobald der Server wieder erreichbar ist.</div>
        </div>
      </Modal>
      {dialog}
    </div>
  );
}

function ModuleRow({ m, busy, onToggle }: { m: AdminModuleState; busy: boolean; onToggle: (enabled: boolean) => void }) {
  const on = m.status === 'active';
  return (
    <li className="flex items-start gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {m.name}
          <code className="font-mono text-[10px] font-normal text-subtle">{m.id}</code>
          <StatusBadge m={m} />
        </div>
        {m.description && <div className="mt-0.5 text-xs text-muted">{m.description}</div>}
        {m.accounts > 0 && (
          <div className={`mt-1 flex items-center gap-1 text-xs ${on ? 'text-subtle' : 'text-warning'}`}>
            <Plug className="h-3 w-3" />
            {m.accounts === 1 ? '1 verbundenes Konto' : `${m.accounts} verbundene Konten`}
            {!on && ' – nicht abrufbar, solange das Modul aus ist'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {busy && <Spinner className="h-4 w-4" />}
        <Switch checked={on} disabled={!m.toggleable || busy} onChange={onToggle} />
      </div>
    </li>
  );
}

function StatusBadge({ m }: { m: AdminModuleState }) {
  if (m.status === 'env') return <Badge>per Umgebungsvariable aus</Badge>;
  if (m.status === 'unavailable') return <Badge tone="warning">nicht verfügbar</Badge>;
  if (m.pending) return <Badge tone="warning">{m.status === 'active' ? 'an nach Neustart' : 'aus nach Neustart'}</Badge>;
  return m.loaded ? <Badge tone="success">aktiv</Badge> : <Badge>aus</Badge>;
}
