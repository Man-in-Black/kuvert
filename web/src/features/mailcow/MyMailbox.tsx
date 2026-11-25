/**
 * Einstellungen → „Mein Postfach": Self-Service für verknüpfte mailcow-Postfächer.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AtSign, Clock, Inbox, KeyRound, Lock, Mail, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import type { MailcowLinkedMailbox, MailcowMailbox } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBox,
  CopyButton,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  useConfirm,
} from '@/components/ui';
import { formatBytes, formatDate, mePath, mk, PROTOCOL_LABELS, useMyAliases, useMyAppPasswords, useMyMailboxes, useMyQuarantine, useMyTempAliases } from './api';

export function MyMailbox() {
  const { data, isLoading } = useMyMailboxes();
  const [idx, setIdx] = useState('0');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Inbox />}
        title="Mein Postfach"
        description="Speicherplatz, Wegwerf-Adressen, App-Passwörter und Quarantäne deines mailcow-Postfachs."
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Mail />} title="Kein mailcow-Postfach verknüpft">
            Richte unter <em>Konten</em> ein Konto vom Typ „mailcow“ ein oder bitte deinen Administrator, dein Postfach mit deinem Benutzer zu verknüpfen.
          </EmptyState>
        </Card>
      ) : (
        <>
          {data.length > 1 && (
            <Tabs value={idx} onChange={setIdx} tabs={data.map((m, i) => ({ value: String(i), label: m.mailbox }))} />
          )}
          <MailboxPanel key={data[Number(idx)]?.mailbox} link={data[Number(idx)] ?? data[0]!} />
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── Ein Postfach ───────────────────────────── */

function MailboxPanel({ link }: { link: MailcowLinkedMailbox }) {
  return (
    <div className="space-y-5 animate-fade-in">
      <QuotaCard link={link} />
      <div className="grid gap-5 xl:grid-cols-2">
        <TempAliases instanceId={link.instanceId} mailbox={link.mailbox} />
        <Aliases instanceId={link.instanceId} mailbox={link.mailbox} />
      </div>
      <AppPasswords instanceId={link.instanceId} mailbox={link.mailbox} />
      <Quarantine instanceId={link.instanceId} mailbox={link.mailbox} />
      <ChangePassword instanceId={link.instanceId} mailbox={link.mailbox} />
    </div>
  );
}

function QuotaRing({ pct, size = 88 }: { pct: number; size?: number }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? 'var(--k-danger)' : clamped >= 75 ? 'var(--k-warning)' : 'var(--k-primary)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--k-surface-3)" strokeWidth={8} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped / 100)}
        style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.16,1,0.3,1)' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="rotate-90 fill-current text-[15px] font-semibold" style={{ transformOrigin: 'center' }}>
        {Math.round(clamped)}%
      </text>
    </svg>
  );
}

function QuotaCard({ link }: { link: MailcowLinkedMailbox }) {
  const m: MailcowMailbox | null = link.info;
  if (!m) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert />} title="Postfach nicht abrufbar">
          {link.error}
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card bodyClassName="flex flex-wrap items-center gap-6">
      {m.quota ? <QuotaRing pct={m.percentInUse} /> : <div className="flex h-[88px] w-[88px] items-center justify-center rounded-full bg-surface-2 text-xs text-muted">∞</div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold">{m.username}</h2>
          {m.active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="warning">Deaktiviert</Badge>}
        </div>
        <div className="mt-1 text-sm text-muted">{m.name}</div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="text-muted">Belegt: </span>
            <span className="font-medium tabular-nums">{formatBytes(m.quotaUsed)}</span>
            <span className="text-muted"> von {m.quota ? formatBytes(m.quota) : 'unbegrenzt'}</span>
          </span>
          <span>
            <span className="text-muted">Nachrichten: </span>
            <span className="font-medium tabular-nums">{m.messages.toLocaleString('de-DE')}</span>
          </span>
          <span className="text-muted">Server: {link.instanceName}</span>
        </div>
      </div>
    </Card>
  );
}

/* ───────────────────────────── Wegwerf-Adressen ───────────────────────────── */

const VALIDITY = [
  { value: 1, label: '1 Stunde' },
  { value: 24, label: '1 Tag' },
  { value: 24 * 7, label: '1 Woche' },
  { value: 24 * 30, label: '1 Monat' },
  { value: 24 * 365, label: '1 Jahr' },
];

function TempAliases({ instanceId, mailbox }: { instanceId: string; mailbox: string }) {
  const { data, isLoading, error } = useMyTempAliases(instanceId, mailbox);
  const qc = useQueryClient();
  const [validity, setValidity] = useState(24 * 30);
  const key = mk.me(instanceId, mailbox, 'temp-aliases');

  const create = useMutation({
    mutationFn: () => api<{ created: { address: string } | null }>(mePath(instanceId, mailbox, '/temp-aliases'), { method: 'POST', body: { validityHours: validity } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: key });
      if (r.created) {
        try {
          await navigator.clipboard.writeText(r.created.address);
          toast.success(`${r.created.address} erstellt und kopiert`);
        } catch {
          toast.success(`${r.created.address} erstellt`);
        }
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = async (address: string) => {
    try {
      await api(mePath(instanceId, mailbox, `/temp-aliases/${encodeURIComponent(address)}`), { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card
      title="Wegwerf-Adressen"
      description="Zufällige Adressen für Newsletter & Anmeldungen – leiten an dein Postfach weiter und laufen automatisch ab."
      icon={<Clock />}
    >
      <div className="mb-3 flex items-center gap-2">
        <Select className="h-8 flex-1 text-xs" value={validity} onChange={(e) => setValidity(Number(e.target.value))} aria-label="Gültigkeit">
          {VALIDITY.map((v) => (
            <option key={v.value} value={v.value}>
              Gültig für {v.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={create.isPending} onClick={() => create.mutate()}>
          Neue Adresse
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted">Noch keine Wegwerf-Adressen.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((a) => {
            const expired = a.validUntil ? new Date(a.validUntil).getTime() < Date.now() : false;
            return (
              <li key={a.address} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-mono text-sm ${expired ? 'text-muted line-through' : ''}`}>{a.address}</div>
                  <div className="text-xs text-muted">{a.validUntil ? `${expired ? 'Abgelaufen' : 'Gültig bis'} ${formatDate(a.validUntil)}` : 'Unbegrenzt'}</div>
                </div>
                <CopyButton value={a.address} label="Kopieren" />
                <IconButton label="Löschen" size="icon-sm" className="text-danger" onClick={() => remove(a.address)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ───────────────────────────── Aliasse ───────────────────────────── */

function Aliases({ instanceId, mailbox }: { instanceId: string; mailbox: string }) {
  const { data, isLoading, error } = useMyAliases(instanceId, mailbox);
  return (
    <Card title="Aliasse" description="Weitere Adressen, die in diesem Postfach ankommen (vom Administrator verwaltet)." icon={<AtSign />}>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted">Keine Aliasse.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1.5 text-sm">
              <AtSign className="h-3.5 w-3.5 text-muted" />
              {a.address}
              {!a.active && <Badge tone="neutral">inaktiv</Badge>}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────────── App-Passwörter ───────────────────────────── */

const DEFAULT_PROTOCOLS = ['imap_access', 'smtp_access', 'dav_access'];

function AppPasswords({ instanceId, mailbox }: { instanceId: string; mailbox: string }) {
  const { data, isLoading, error } = useMyAppPasswords(instanceId, mailbox);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [protocols, setProtocols] = useState<string[]>(DEFAULT_PROTOCOLS);
  const [created, setCreated] = useState<string | null>(null);
  const key = mk.me(instanceId, mailbox, 'app-passwords');

  const create = useMutation({
    mutationFn: () => api<{ password: string }>(mePath(instanceId, mailbox, '/app-passwords'), { method: 'POST', body: { name, protocols } }),
    onSuccess: (r) => {
      setCreated(r.password);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = async (id: string, label: string) => {
    if (!(await confirm(`App-Passwort „${label}“ widerrufen? Geräte, die es nutzen, verlieren den Zugriff.`, { danger: true }))) return;
    try {
      await api(mePath(instanceId, mailbox, `/app-passwords/${encodeURIComponent(id)}`), { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const close = () => {
    setOpen(false);
    setCreated(null);
    setName('');
    setProtocols(DEFAULT_PROTOCOLS);
  };

  return (
    <Card
      title="App-Passwörter"
      description="Eigene Passwörter für Mail-Programme und Smartphones – einzeln widerrufbar, ohne das Hauptpasswort zu teilen."
      icon={<KeyRound />}
      actions={
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
          Erstellen
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted">Noch keine App-Passwörter.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                <KeyRound className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.protocols.map((x) => (
                    <Badge key={x} tone="neutral">
                      {PROTOCOL_LABELS[x] ?? x}
                    </Badge>
                  ))}
                  {p.createdAt && <span className="text-xs text-muted">· seit {formatDate(p.createdAt, false)}</span>}
                </div>
              </div>
              <IconButton label="Widerrufen" size="icon-sm" className="text-danger" onClick={() => remove(p.id, p.name)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={open}
        onClose={close}
        title={created ? 'App-Passwort erstellt' : 'Neues App-Passwort'}
        footer={
          created ? (
            <Button variant="primary" onClick={close}>
              Fertig
            </Button>
          ) : (
            <>
              <Button onClick={close}>Abbrechen</Button>
              <Button variant="primary" loading={create.isPending} disabled={!name.trim() || !protocols.length} onClick={() => create.mutate()}>
                Erstellen
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">Kopiere das Passwort jetzt – es wird aus Sicherheitsgründen nicht erneut angezeigt.</p>
            <CodeBox value={created} />
            <p className="text-xs text-muted">Benutzername ist deine E-Mail-Adresse ({mailbox}).</p>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Bezeichnung">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. iPhone, Thunderbird Büro" autoFocus />
            </Field>
            <div>
              <div className="mb-2 text-xs font-medium text-muted">Erlaubte Dienste</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(PROTOCOL_LABELS).map(([k, label]) => (
                  <Checkbox
                    key={k}
                    checked={protocols.includes(k)}
                    onChange={(v) => setProtocols((p) => (v ? [...p, k] : p.filter((x) => x !== k)))}
                    label={label}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
      {dialog}
    </Card>
  );
}

/* ───────────────────────────── Quarantäne ───────────────────────────── */

function Quarantine({ instanceId, mailbox }: { instanceId: string; mailbox: string }) {
  const { data, isLoading, error } = useMyQuarantine(instanceId, mailbox);
  const qc = useQueryClient();
  const remove = async (id: string) => {
    try {
      await api(mePath(instanceId, mailbox, `/quarantine/${encodeURIComponent(id)}`), { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: mk.me(instanceId, mailbox, 'quarantine') });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card title="Quarantäne" description="Vom Spamfilter zurückgehaltene Nachrichten an dieses Postfach." icon={<ShieldAlert />}>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted">Keine Nachrichten in Quarantäne. 🎉</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((q) => (
            <li key={q.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{q.subject || '(kein Betreff)'}</span>
                  {q.virus && <Badge tone="danger">Virus</Badge>}
                  {q.score !== null && q.score !== undefined && <Badge tone="warning">Score {q.score.toFixed(1)}</Badge>}
                </div>
                <div className="truncate text-xs text-muted">
                  von {q.sender} · {formatDate(q.createdAt)}
                </div>
              </div>
              <IconButton label="Löschen" size="icon-sm" className="text-danger" onClick={() => remove(q.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ───────────────────────────── Passwort ───────────────────────────── */

function ChangePassword({ instanceId, mailbox }: { instanceId: string; mailbox: string }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [kuvertPassword, setKuvertPassword] = useState('');
  const save = useMutation({
    mutationFn: () => api<{ accountsUpdated: number }>(mePath(instanceId, mailbox, '/password'), { method: 'POST', body: { password: pw, kuvertPassword } }),
    onSuccess: (r) => {
      toast.success(`Postfach-Passwort geändert${r.accountsUpdated ? ` – ${r.accountsUpdated} Kuvert-Konto aktualisiert` : ''}`);
      setPw('');
      setPw2('');
      setKuvertPassword('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const mismatch = !!pw2 && pw !== pw2;
  return (
    <Card title="Postfach-Passwort ändern" description="Gilt für IMAP, SMTP und SOGo. Verknüpfte Kuvert-Konten werden automatisch angepasst." icon={<Lock />}>
      <form
        className="grid gap-4 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Neues Passwort" hint="Mindestens 8 Zeichen">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Wiederholen" error={mismatch ? 'Stimmt nicht überein' : undefined}>
          <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Dein Kuvert-Passwort" hint="Zur Bestätigung">
          <Input type="password" value={kuvertPassword} onChange={(e) => setKuvertPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <div className="md:col-span-3">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={pw.length < 8 || pw !== pw2 || !kuvertPassword}>
            Passwort ändern
          </Button>
        </div>
      </form>
    </Card>
  );
}
