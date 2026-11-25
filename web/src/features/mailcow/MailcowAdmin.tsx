/**
 * Admin-Bereich „mailcow": Instanzen verbinden, Serverstatus, Postfächer, Domains,
 * Aliasse, Quarantäne, Sync-Jobs und Verknüpfungen mit Kuvert-Benutzern.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, CheckCircle2, HardDrive, Pencil, Plug, Plus, Server, Trash2, XCircle } from 'lucide-react';
import type { MailcowInstanceInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Progress,
  Select,
  Skeleton,
  StatCard,
  Tabs,
  useConfirm,
} from '@/components/ui';
import { instPath, mk, useInstances, useMailboxes, useStatus } from './api';
import { AliasesTab, DomainsTab, LinksTab, MailboxesTab, QuarantineTab, SyncJobsTab } from './AdminTabs';

type Tab = 'overview' | 'mailboxes' | 'domains' | 'aliases' | 'quarantine' | 'sync' | 'links';

export function MailcowAdmin() {
  const { data: instances, isLoading } = useInstances();
  const [selected, setSelected] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState<MailcowInstanceInfo | 'new' | null>(null);
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();

  useEffect(() => {
    if (!instances?.length) setSelected(undefined);
    else if (!selected || !instances.some((i) => i.id === selected)) setSelected(instances[0]!.id);
  }, [instances, selected]);

  const current = instances?.find((i) => i.id === selected);

  const remove = async () => {
    if (!current) return;
    if (!(await confirm(`Verbindung zu „${current.name}" entfernen? Verknüpfungen von Benutzern mit Postfächern dieser Instanz werden ebenfalls gelöscht.`, { danger: true }))) return;
    try {
      await api(instPath(current.id), { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: mk.all });
      toast.success('Instanz entfernt');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const test = async () => {
    if (!current) return;
    try {
      const r = await api<{ ok: boolean; version?: string | null }>(instPath(current.id, '/test'), { method: 'POST', body: {} });
      toast.success(`Verbindung erfolgreich${r.version ? ` – mailcow ${r.version}` : ''}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Server />}
        title="mailcow"
        description="Postfächer, Aliasse und Quarantäne deines mailcow-Servers direkt aus Kuvert verwalten. Benutzer erhalten Self-Service für ihre verknüpften Postfächer."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
            Instanz verbinden
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : !instances?.length ? (
        <Card>
          <EmptyState icon={<Plug />} title="Noch keine mailcow-Instanz verbunden">
            Lege in mailcow unter <em>System → Konfiguration → Zugang → API</em> einen <strong>Lese-/Schreib-Schlüssel</strong> an und gib die IP-Adresse
            des Kuvert-Servers frei.
            <div className="mt-4">
              <Button variant="primary" onClick={() => setEditing('new')}>
                Instanz verbinden
              </Button>
            </div>
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card bodyClassName="flex flex-wrap items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
              <Server className="h-4 w-4" />
            </span>
            {instances.length > 1 ? (
              <Select className="w-64" value={selected} onChange={(e) => setSelected(e.target.value)}>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.hostname})
                  </option>
                ))}
              </Select>
            ) : (
              <div className="min-w-0">
                <div className="text-sm font-semibold">{current?.name}</div>
                <div className="text-xs text-muted">{current?.baseUrl}</div>
              </div>
            )}
            <Badge tone="neutral">Schlüssel {current?.keyHint}</Badge>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" icon={<Activity className="h-3.5 w-3.5" />} onClick={test}>
                Testen
              </Button>
              <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => current && setEditing(current)}>
                Bearbeiten
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
                Entfernen
              </Button>
            </div>
          </Card>

          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'overview', label: 'Übersicht' },
              { value: 'mailboxes', label: 'Postfächer' },
              { value: 'domains', label: 'Domains' },
              { value: 'aliases', label: 'Aliasse' },
              { value: 'quarantine', label: 'Quarantäne' },
              { value: 'sync', label: 'Sync-Jobs' },
              { value: 'links', label: 'Verknüpfungen' },
            ]}
          />

          {current && (
            <div key={current.id} className="animate-fade-in">
              {tab === 'overview' && <Overview instance={current} />}
              {tab === 'mailboxes' && <MailboxesTab instance={current} />}
              {tab === 'domains' && <DomainsTab instance={current} />}
              {tab === 'aliases' && <AliasesTab instance={current} />}
              {tab === 'quarantine' && <QuarantineTab instance={current} />}
              {tab === 'sync' && <SyncJobsTab instance={current} />}
              {tab === 'links' && <LinksTab instance={current} />}
            </div>
          )}
        </>
      )}

      {editing && <InstanceDialog instance={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => setSelected(id)} />}
      {dialog}
    </div>
  );
}

/* ───────────────────────────── Übersicht ───────────────────────────── */

function Overview({ instance }: { instance: MailcowInstanceInfo }) {
  const status = useStatus(instance.id);
  const mailboxes = useMailboxes(instance.id);

  if (status.error) {
    return (
      <Card>
        <EmptyState icon={<XCircle />} title="Server nicht erreichbar">
          {errorMessage(status.error)}
        </EmptyState>
      </Card>
    );
  }
  const s = status.data;
  const running = s?.containers.filter((c) => c.running).length ?? 0;
  const total = s?.containers.length ?? 0;
  const mbs = mailboxes.data ?? [];
  const used = mbs.reduce((sum, m) => sum + m.quotaUsed, 0);
  const near = mbs.filter((m) => m.quota > 0 && m.percentInUse >= 90).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Version" value={status.isLoading ? <Skeleton className="h-7 w-24" /> : (s?.version ?? '–')} icon={<Server />} />
        <StatCard
          label="Container"
          value={status.isLoading ? <Skeleton className="h-7 w-16" /> : `${running}/${total}`}
          hint={running === total ? 'Alle Dienste laufen' : `${total - running} Dienst(e) gestoppt`}
          icon={running === total ? <CheckCircle2 /> : <XCircle />}
          tone={running === total ? 'success' : 'danger'}
        />
        <StatCard label="Postfächer" value={mailboxes.isLoading ? <Skeleton className="h-7 w-12" /> : mbs.length} hint={`${formatGB(used)} belegt`} icon={<HardDrive />} tone="info" />
        <StatCard label="Fast voll (≥ 90 %)" value={near} icon={<Activity />} tone={near ? 'warning' : 'neutral'} />
      </div>

      {s?.vmail && (
        <Card title="Mail-Speicher" description={`${s.vmail.used ?? '?'} von ${s.vmail.total ?? '?'} belegt`} icon={<HardDrive />}>
          <Progress value={s.vmail.usedPercent ?? 0} tone={(s.vmail.usedPercent ?? 0) > 85 ? 'danger' : (s.vmail.usedPercent ?? 0) > 70 ? 'warning' : 'primary'} className="h-2" />
        </Card>
      )}

      {total > 0 && (
        <Card title="Dienste" icon={<Activity />}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {s!.containers.map((c) => (
              <div key={c.name} className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2/50 px-3 py-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.running ? 'bg-success' : 'bg-danger'}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.name.replace(/-mailcow$/, '')}</span>
                <span className={`text-[11px] font-medium ${c.running ? 'text-success' : 'text-danger'}`}>{c.state}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const formatGB = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;

/* ───────────────────────────── Instanz-Dialog ───────────────────────────── */

function InstanceDialog({ instance, onClose, onSaved }: { instance: MailcowInstanceInfo | null; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(instance?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(instance?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, baseUrl, ...(apiKey ? { apiKey } : {}) };
      const saved = instance
        ? await api<MailcowInstanceInfo>(instPath(instance.id), { method: 'PATCH', body })
        : await api<MailcowInstanceInfo>('/mailcow/instances', { method: 'POST', body });
      // Verbindung direkt prüfen
      const t = await api<{ version?: string | null }>(instPath(saved.id, '/test'), { method: 'POST', body: {} }).catch((err) => {
        toast.warning(`Gespeichert, aber Test fehlgeschlagen: ${errorMessage(err)}`);
        return null;
      });
      if (t) toast.success(`Verbunden${t.version ? ` – mailcow ${t.version}` : ''}`);
      return saved;
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: mk.all });
      onSaved(saved.id);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={instance ? 'Instanz bearbeiten' : 'mailcow-Instanz verbinden'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={save.isPending} disabled={!baseUrl || (!instance && apiKey.length < 8)} onClick={() => save.mutate()}>
            Speichern & testen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Bezeichnung">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Produktion" />
        </Field>
        <Field label="Adresse der mailcow-Oberfläche" hint="Gleicher Hostname wird für IMAP/SMTP und SOGo (Kalender/Kontakte) verwendet.">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mail.example.com" />
        </Field>
        <Field label="API-Schlüssel (Lesen & Schreiben)" hint={instance ? `Leer lassen, um den bestehenden Schlüssel (${instance.keyHint}) zu behalten.` : 'mailcow → System → Konfiguration → Zugang → API'}>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" placeholder={instance ? '••••••••' : 'XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX'} />
        </Field>
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs leading-relaxed text-muted">
          Wichtig: In mailcow muss die IP-Adresse des Kuvert-Servers für den API-Zugriff freigegeben sein. Der Schlüssel wird verschlüsselt gespeichert.
        </div>
      </div>
    </Modal>
  );
}
