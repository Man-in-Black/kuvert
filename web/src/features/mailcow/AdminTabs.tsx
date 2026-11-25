/** Reiter des mailcow-Admin-Bereichs. */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AtSign, Link2, Pencil, Plus, RefreshCw, Search, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import type { AdminUser, MailcowInstanceInfo, MailcowMailbox } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Progress,
  Select,
  Skeleton,
  Switch,
  Table,
  Td,
  Th,
  useConfirm,
} from '@/components/ui';
import { formatBytes, formatDate, generatePassword, instPath, mk, useAliases, useDomains, useLinks, useMailboxes, useQuarantine, useSyncJobs } from './api';
import { ProvisionDialog } from './ProvisionDialog';

type P = { instance: MailcowInstanceInfo };

function LoadingRows() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

function ErrorCard({ error }: { error: unknown }) {
  return (
    <Card>
      <EmptyState icon={<ShieldAlert />} title="Daten konnten nicht geladen werden">
        {errorMessage(error)}
      </EmptyState>
    </Card>
  );
}

function quotaTone(pct: number) {
  return pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'primary';
}

/* ═════════════════════════════ Postfächer ═════════════════════════════ */

export function MailboxesTab({ instance }: P) {
  const { data, isLoading, error, refetch, isFetching } = useMailboxes(instance.id);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<MailcowMailbox | null>(null);
  const [provision, setProvision] = useState(false);
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((m) => !s || m.username.toLowerCase().includes(s) || m.name.toLowerCase().includes(s));
  }, [data, q]);

  const remove = async (m: MailcowMailbox) => {
    if (!(await confirm(<>Postfach <strong>{m.username}</strong> mit allen E-Mails unwiderruflich löschen?</>, { danger: true }))) return;
    try {
      await api(instPath(instance.id, `/mailboxes/${encodeURIComponent(m.username)}`), { method: 'DELETE' });
      toast.success('Postfach gelöscht');
      qc.invalidateQueries({ queryKey: mk.inst(instance.id, 'mailboxes') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input className="pl-9" placeholder="Postfach suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <IconButton label="Aktualisieren" variant="outline" onClick={() => refetch()}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </IconButton>
        <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setProvision(true)}>
          Postfach anlegen
        </Button>
      </div>

      {isLoading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorCard error={error} />
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<AtSign />} title={q ? 'Keine Treffer' : 'Keine Postfächer'} />
        </Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Postfach</Th>
              <Th className="w-64">Kontingent</Th>
              <Th className="hidden md:table-cell">Nachrichten</Th>
              <Th>Status</Th>
              <Th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.username} className="transition-colors hover:bg-hover/50">
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={m.name || m.username} email={m.username} size={32} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{m.name || m.localPart}</div>
                      <div className="truncate text-xs text-muted">{m.username}</div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <div className="space-y-1.5">
                    <Progress value={m.quota ? m.percentInUse : 0} tone={quotaTone(m.percentInUse)} />
                    <div className="text-xs text-muted tabular-nums">
                      {formatBytes(m.quotaUsed)} / {m.quota ? formatBytes(m.quota) : 'unbegrenzt'}
                      {m.quota ? ` · ${m.percentInUse} %` : ''}
                    </div>
                  </div>
                </Td>
                <Td className="hidden tabular-nums text-muted md:table-cell">{m.messages.toLocaleString('de-DE')}</Td>
                <Td>{m.active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="neutral">Inaktiv</Badge>}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <IconButton label="Bearbeiten" size="icon-sm" onClick={() => setEdit(m)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label="Löschen" size="icon-sm" className="text-danger" onClick={() => remove(m)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {edit && <MailboxEditDialog instance={instance} mailbox={edit} onClose={() => setEdit(null)} />}
      {provision && <ProvisionDialog instance={instance} onClose={() => setProvision(false)} />}
      {dialog}
    </div>
  );
}

function MailboxEditDialog({ instance, mailbox, onClose }: P & { mailbox: MailcowMailbox; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(mailbox.name);
  const [quotaMb, setQuotaMb] = useState(Math.round(mailbox.quota / 1048576));
  const [active, setActive] = useState(mailbox.active);
  const [password, setPassword] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api(instPath(instance.id, `/mailboxes/${encodeURIComponent(mailbox.username)}`), {
        method: 'PATCH',
        body: { name, quotaMb, active, ...(password ? { password } : {}) },
      }),
    onSuccess: () => {
      toast.success('Postfach gespeichert');
      qc.invalidateQueries({ queryKey: mk.inst(instance.id, 'mailboxes') });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={mailbox.username}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={save.isPending} disabled={!!password && password.length < 8} onClick={() => save.mutate()}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Anzeigename">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Kontingent (MB)" hint={`Belegt: ${formatBytes(mailbox.quotaUsed)} · 0 = unbegrenzt`}>
          <Input type="number" min={0} value={quotaMb} onChange={(e) => setQuotaMb(Number(e.target.value))} />
        </Field>
        <Field label="Neues Passwort" hint="Leer lassen, um das Passwort nicht zu ändern">
          <div className="flex gap-2">
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="font-mono" />
            <Button onClick={() => setPassword(generatePassword())}>Erzeugen</Button>
          </div>
        </Field>
        <Switch checked={active} onChange={setActive} label="Postfach aktiv" />
      </div>
    </Modal>
  );
}

/* ═════════════════════════════ Domains ═════════════════════════════ */

export function DomainsTab({ instance }: P) {
  const { data, isLoading, error } = useDomains(instance.id);
  if (isLoading) return <LoadingRows />;
  if (error) return <ErrorCard error={error} />;
  if (!data?.length) return <Card><EmptyState title="Keine Domains" /></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.map((d) => {
        const pct = d.maxQuota && d.quotaUsed !== undefined ? Math.round((d.quotaUsed / d.maxQuota) * 100) : 0;
        return (
          <Card key={d.domain} className="transition-colors hover:border-border-strong">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">{d.domain}</div>
                {d.description && <div className="truncate text-xs text-muted">{d.description}</div>}
              </div>
              {d.active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="neutral">Inaktiv</Badge>}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted">Postfächer</div>
                <div className="font-medium tabular-nums">
                  {d.mailboxes ?? '–'} {d.maxMailboxes ? <span className="text-muted">/ {d.maxMailboxes}</span> : null}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Aliasse</div>
                <div className="font-medium tabular-nums">
                  {d.aliases ?? '–'} {d.maxAliases ? <span className="text-muted">/ {d.maxAliases}</span> : null}
                </div>
              </div>
            </div>
            {d.maxQuota ? (
              <div className="mt-4 space-y-1.5">
                <Progress value={pct} tone={quotaTone(pct)} />
                <div className="text-xs text-muted tabular-nums">
                  {formatBytes(d.quotaUsed ?? 0)} von {formatBytes(d.maxQuota)}
                </div>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/* ═════════════════════════════ Aliasse ═════════════════════════════ */

export function AliasesTab({ instance }: P) {
  const { data, isLoading, error } = useAliases(instance.id);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [address, setAddress] = useState('');
  const [goto, setGoto] = useState('');
  const [q, setQ] = useState('');

  const add = useMutation({
    mutationFn: () => api(instPath(instance.id, '/aliases'), { method: 'POST', body: { address, goto } }),
    onSuccess: () => {
      toast.success('Alias angelegt');
      setAddress('');
      setGoto('');
      qc.invalidateQueries({ queryKey: mk.inst(instance.id, 'aliases') });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = async (id: string, addr: string) => {
    if (!(await confirm(`Alias ${addr} löschen?`, { danger: true }))) return;
    try {
      await api(instPath(instance.id, `/aliases/${encodeURIComponent(id)}`), { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: mk.inst(instance.id, 'aliases') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const list = (data ?? []).filter((a) => !q || `${a.address} ${a.goto}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <Card title="Neuer Alias" icon={<Plus />} bodyClassName="flex flex-wrap items-end gap-3">
        <Field label="Alias-Adresse" className="min-w-56 flex-1" hint="„@domain.tld“ für Catch-All">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="vertrieb@example.com" />
        </Field>
        <Field label="Ziel(e)" className="min-w-56 flex-1" hint="Mehrere Ziele mit Komma trennen">
          <Input value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="anna@example.com, ben@example.com" />
        </Field>
        <Button variant="primary" loading={add.isPending} disabled={!address || !goto} onClick={() => add.mutate()} className="mb-[22px]">
          Anlegen
        </Button>
      </Card>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input className="pl-9" placeholder="Aliasse filtern …" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {isLoading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorCard error={error} />
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<AtSign />} title="Keine Aliasse" />
        </Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Alias</Th>
              <Th>Ziel</Th>
              <Th>Status</Th>
              <Th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className="hover:bg-hover/50">
                <Td className="font-medium">
                  {a.address} {a.isCatchAll && <Badge tone="info">Catch-All</Badge>}
                </Td>
                <Td className="text-muted">
                  <div className="flex flex-wrap gap-1">
                    {a.goto.split(',').map((g) => (
                      <Badge key={g} tone="neutral">
                        {g.trim()}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td>{a.active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="neutral">Inaktiv</Badge>}</Td>
                <Td>
                  <IconButton label="Löschen" size="icon-sm" className="text-danger" onClick={() => remove(a.id, a.address)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {dialog}
    </div>
  );
}

/* ═════════════════════════════ Quarantäne ═════════════════════════════ */

export function QuarantineTab({ instance }: P) {
  const { data, isLoading, error } = useQuarantine(instance.id);
  const qc = useQueryClient();
  const remove = async (id: string) => {
    try {
      await api(instPath(instance.id, `/quarantine/${encodeURIComponent(id)}`), { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: mk.inst(instance.id, 'quarantine') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (isLoading) return <LoadingRows />;
  if (error) return <ErrorCard error={error} />;
  if (!data?.length)
    return (
      <Card>
        <EmptyState icon={<ShieldAlert />} title="Quarantäne ist leer">
          Keine zurückgehaltenen Nachrichten.
        </EmptyState>
      </Card>
    );
  return (
    <Table>
      <thead>
        <tr>
          <Th>Betreff</Th>
          <Th>Absender → Empfänger</Th>
          <Th>Score</Th>
          <Th>Datum</Th>
          <Th className="w-12" />
        </tr>
      </thead>
      <tbody>
        {data.map((it) => (
          <tr key={it.id} className="hover:bg-hover/50">
            <Td>
              <div className="font-medium">{it.subject || '(kein Betreff)'}</div>
              {it.virus && <Badge tone="danger">Virus</Badge>}
            </Td>
            <Td className="text-xs text-muted">
              {it.sender}
              <br />→ {it.recipient}
            </Td>
            <Td>
              <Badge tone={(it.score ?? 0) >= 15 ? 'danger' : 'warning'}>{it.score?.toFixed(1) ?? '–'}</Badge>
            </Td>
            <Td className="text-xs text-muted">{formatDate(it.createdAt)}</Td>
            <Td>
              <IconButton label="Löschen" size="icon-sm" className="text-danger" onClick={() => remove(it.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ═════════════════════════════ Sync-Jobs ═════════════════════════════ */

export function SyncJobsTab({ instance }: P) {
  const { data, isLoading, error } = useSyncJobs(instance.id);
  if (isLoading) return <LoadingRows />;
  if (error) return <ErrorCard error={error} />;
  if (!data?.length) return <Card><EmptyState icon={<RefreshCw />} title="Keine Sync-Jobs">Sync-Jobs (imapsync) werden in mailcow angelegt.</EmptyState></Card>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Ziel-Postfach</Th>
          <Th>Quelle</Th>
          <Th>Intervall</Th>
          <Th>Letzter Lauf</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((j) => (
          <tr key={j.id}>
            <Td className="font-medium">{j.mailbox}</Td>
            <Td className="text-xs text-muted">
              {j.remoteUser}@{j.host}
            </Td>
            <Td className="text-muted">{j.intervalMin ? `${j.intervalMin} min` : '–'}</Td>
            <Td className="text-xs text-muted">{formatDate(j.lastRun)}</Td>
            <Td>{j.running ? <Badge tone="info">Läuft</Badge> : j.active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="neutral">Inaktiv</Badge>}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ═════════════════════════════ Verknüpfungen ═════════════════════════════ */

export function LinksTab({ instance }: P) {
  const qc = useQueryClient();
  const { data: links, isLoading } = useLinks();
  const { data: users } = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const { data: mailboxes } = useMailboxes(instance.id);
  const [userId, setUserId] = useState('');
  const [mailbox, setMailbox] = useState('');

  const mine = (links ?? []).filter((l) => l.instanceId === instance.id);

  const add = useMutation({
    mutationFn: () => api('/mailcow/links', { method: 'POST', body: { userId, instanceId: instance.id, mailbox } }),
    onSuccess: () => {
      toast.success('Verknüpfung angelegt');
      setMailbox('');
      qc.invalidateQueries({ queryKey: mk.links });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = async (uid: string, mb: string) => {
    try {
      await api('/mailcow/links', { method: 'DELETE', query: { userId: uid, instanceId: instance.id, mailbox: mb } });
      qc.invalidateQueries({ queryKey: mk.links });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Benutzer mit Postfach verknüpfen"
        description="Verknüpfte Benutzer sehen unter „Mein Postfach“ Kontingent, Aliasse, Wegwerf-Adressen, App-Passwörter und Quarantäne. Beim Einrichten eines mailcow- oder IMAP-Kontos geschieht das automatisch."
        icon={<Link2 />}
        bodyClassName="flex flex-wrap items-end gap-3"
      >
        <Field label="Kuvert-Benutzer" className="min-w-56 flex-1">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Bitte wählen …</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Postfach" className="min-w-56 flex-1">
          <Select value={mailbox} onChange={(e) => setMailbox(e.target.value)}>
            <option value="">Bitte wählen …</option>
            {(mailboxes ?? []).map((m) => (
              <option key={m.username} value={m.username}>
                {m.username}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" disabled={!userId || !mailbox} loading={add.isPending} onClick={() => add.mutate()}>
          Verknüpfen
        </Button>
      </Card>

      {isLoading ? (
        <LoadingRows />
      ) : !mine.length ? (
        <Card>
          <EmptyState icon={<Link2 />} title="Noch keine Verknüpfungen" />
        </Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Benutzer</Th>
              <Th>Postfach</Th>
              <Th>Seit</Th>
              <Th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {mine.map((l) => (
              <tr key={`${l.userId}-${l.mailbox}`} className="hover:bg-hover/50">
                <Td className="font-medium">{l.userEmail}</Td>
                <Td>{l.mailbox}</Td>
                <Td className="text-xs text-muted">{formatDate(l.createdAt, false)}</Td>
                <Td>
                  <IconButton label="Verknüpfung lösen" size="icon-sm" className="text-danger" onClick={() => remove(l.userId, l.mailbox)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
