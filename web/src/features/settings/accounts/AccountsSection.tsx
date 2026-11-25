import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Pencil, Plug, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import type { AccountInfo, AccountTypeInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useAccounts } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, IconButton, Spinner, useConfirm } from '@/components/ui';
import { HelpBox, SectionHeader } from '../ui';
import { AddAccountDialog } from './AddAccountDialog';
import { EditAccountDialog } from './EditAccountDialog';
import { AccountTypeIcon, CAPABILITY_LABELS, CapabilityChips } from './shared';

type TestResult = { ok: boolean; results: Record<string, { ok: boolean; message?: string }> };

export function AccountsSection() {
  const qc = useQueryClient();
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: types = [] } = useQuery({ queryKey: ['accounts', 'types'], queryFn: () => api<AccountTypeInfo[]>('/accounts/types'), staleTime: 300_000 });
  const typeMap = new Map(types.map((t) => [t.type, t]));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccountInfo | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const { confirm, dialog } = useConfirm();

  const move = async (index: number, dir: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      qc.setQueryData<AccountInfo[]>(qk.accounts, (old) => (old ? ids.map((id) => old.find((a) => a.id === id)!).filter(Boolean) : old));
      await api('/accounts/order', { method: 'PUT', body: { ids } });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      qc.invalidateQueries({ queryKey: qk.accounts });
    }
  };

  const test = async (acc: AccountInfo) => {
    setTesting(acc.id);
    try {
      const r = await api<TestResult>(`/accounts/${acc.id}/test`, { method: 'POST' });
      setTests((t) => ({ ...t, [acc.id]: r }));
      if (r.ok) toast.success(`„${acc.name}": Verbindung erfolgreich`);
      else toast.error(`„${acc.name}": Verbindungstest mit Fehlern`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(null);
      qc.invalidateQueries({ queryKey: qk.accounts });
    }
  };

  const remove = async (acc: AccountInfo) => {
    const ok = await confirm(
      <>
        Konto <strong>{acc.name}</strong> ({acc.email}) wirklich entfernen? Die Daten beim Anbieter bleiben unverändert, nur die Verbindung in Kuvert wird
        gelöscht.
      </>,
      { danger: true },
    );
    if (!ok) return;
    try {
      await api(`/accounts/${acc.id}`, { method: 'DELETE' });
      toast.success('Konto entfernt');
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['mail'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const reconnect = (acc: AccountInfo) => {
    const t = typeMap.get(acc.type);
    if (t?.auth === 'oauth') {
      window.location.href = `/api/accounts/oauth/${encodeURIComponent(acc.type)}/start?accountId=${encodeURIComponent(acc.id)}`;
    } else setEditing(acc);
  };

  return (
    <div>
      <SectionHeader
        title="Konten"
        description="E-Mail-, Kalender-, Kontakt-, Aufgaben- und Speicherkonten. Die Reihenfolge bestimmt die Anzeige in der Seitenleiste."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Konto hinzufügen
          </Button>
        }
      />

      {isLoading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {!isLoading && accounts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState icon={<Plug />} title="Noch keine Konten verbunden">
            Verbinde Microsoft 365, Google, ein IMAP-Postfach oder einen CalDAV-/Nextcloud-Server.
            <div className="mt-4">
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                Erstes Konto hinzufügen
              </Button>
            </div>
          </EmptyState>
        </div>
      )}

      <div className="space-y-3">
        {accounts.map((acc, i) => {
          const t = typeMap.get(acc.type);
          const result = tests[acc.id];
          return (
            <div key={acc.id} className={cn('overflow-hidden rounded-xl border border-border bg-surface', !acc.enabled && 'opacity-70')}>
              <div className="flex items-stretch">
                <div className="w-1.5 shrink-0" style={{ backgroundColor: acc.color }} />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 p-4">
                  <AccountTypeIcon type={acc.type} icon={t?.icon} capabilities={acc.capabilities} className="h-7 w-7" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{acc.name}</span>
                      <span className="text-xs text-muted">{t?.label ?? acc.type}</span>
                      {!acc.enabled && <Badge>Deaktiviert</Badge>}
                      {acc.status === 'ok' && acc.enabled && (
                        <Badge color="var(--k-success)">
                          <CheckCircle2 className="h-3 w-3" /> Verbunden
                        </Badge>
                      )}
                      {acc.status === 'error' && (
                        <Badge color="var(--k-warning)">
                          <AlertTriangle className="h-3 w-3" /> Fehler
                        </Badge>
                      )}
                      {acc.status === 'reauth' && (
                        <Badge color="var(--k-danger)">
                          <XCircle className="h-3 w-3" /> Anmeldung erforderlich
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-sm text-muted">{acc.email}</div>
                    <CapabilityChips caps={acc.capabilities} className="mt-1.5" />
                    {acc.settings.sharedMailboxes && acc.settings.sharedMailboxes.length > 0 && (
                      <div className="mt-1 text-xs text-muted">Freigegeben: {acc.settings.sharedMailboxes.join(', ')}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {acc.status === 'reauth' && (
                      <Button size="sm" variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => reconnect(acc)}>
                        Neu verbinden
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => test(acc)} loading={testing === acc.id} disabled={!acc.enabled}>
                      Testen
                    </Button>
                    <IconButton label="Nach oben" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Nach unten" size="icon-sm" onClick={() => move(i, 1)} disabled={i === accounts.length - 1}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Bearbeiten" size="icon-sm" onClick={() => setEditing(acc)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Entfernen" size="icon-sm" onClick={() => remove(acc)} className="hover:text-danger">
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </div>
              </div>
              {(acc.status === 'error' || acc.status === 'reauth') && acc.statusMessage && (
                <div className="border-t border-border bg-surface-2 px-4 py-2 text-xs text-muted">{acc.statusMessage}</div>
              )}
              {result && (
                <div className="flex flex-wrap gap-2 border-t border-border bg-surface-2 px-4 py-2 text-xs">
                  {Object.entries(result.results).map(([cap, r]) => (
                    <span key={cap} className={cn('inline-flex items-center gap-1', r.ok ? 'text-success' : 'text-danger')} title={r.message}>
                      {r.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                      {CAPABILITY_LABELS[cap as keyof typeof CAPABILITY_LABELS] ?? cap}
                      {!r.ok && r.message && <span className="text-muted">– {r.message}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {accounts.length > 0 && (
        <div className="mt-6">
          <HelpBox>
            Tipp: Über „Bearbeiten" legst du fest, ob ein Konto im gemeinsamen Posteingang erscheint und ob es Benachrichtigungen auslöst. Bei
            Microsoft-365-Konten können dort auch freigegebene Postfächer hinzugefügt werden.
          </HelpBox>
        </div>
      )}

      <AddAccountDialog open={adding} onClose={() => setAdding(false)} />
      {editing && <EditAccountDialog account={editing} type={typeMap.get(editing.type)} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}
