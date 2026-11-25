import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Eye,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  ShieldOff,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react';
import type { AccountInfo, AdminUser, SessionInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAppInfo } from '@/lib/queries';
import {
  Avatar,
  Badge,
  Button,
  ColorDot,
  CopyButton,
  Drawer,
  Dropdown,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Switch,
  Table,
  Td,
  Th,
  Tabs,
  useConfirm,
  type MenuItem,
} from '@/components/ui';
import { parseUserAgent, relativeTime } from '@/features/profile/format';
import { overviewKey } from './OverviewSection';

const usersKey = ['admin', 'users'] as const;

/** Zufälliges, gut lesbares Startpasswort */
export function generatePassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!$%&?#';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

export function UsersSection() {
  const qc = useQueryClient();
  const { data: app } = useAppInfo();
  const [params, setParams] = useSearchParams();
  const { confirm, dialog } = useConfirm();
  const { data: users, isLoading } = useQuery({ queryKey: usersKey, queryFn: () => api<AdminUser[]>('/admin/users') });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'admins' | 'disabled' | 'no2fa'>('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [pwUser, setPwUser] = useState<AdminUser | null>(null);
  const [details, setDetails] = useState<AdminUser | null>(null);

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: usersKey });
    qc.invalidateQueries({ queryKey: overviewKey });
  };

  const action = useMutation({
    mutationFn: ({ path, method = 'POST', body }: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) => api(path, { method, body }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users ?? []).filter((u) => {
      if (filter === 'admins' && !u.isAdmin) return false;
      if (filter === 'disabled' && !u.disabled) return false;
      if (filter === 'no2fa' && u.twoFactorEnabled) return false;
      return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    });
  }, [users, search, filter]);

  const menu = (u: AdminUser): MenuItem[] => {
    const self = u.id === app?.user?.id;
    return [
      { label: 'Details anzeigen', icon: <Eye />, onClick: () => setDetails(u) },
      { label: 'Bearbeiten', icon: <Pencil />, onClick: () => setEditing(u) },
      { label: 'Passwort setzen', icon: <KeyRound />, onClick: () => setPwUser(u) },
      {
        label: '2FA zurücksetzen',
        icon: <ShieldOff />,
        disabled: !u.twoFactorEnabled,
        onClick: async () => {
          if (await confirm(<>Zwei-Faktor-Authentifizierung für <b>{u.name}</b> zurücksetzen? Der Benutzer kann sich danach nur mit Passwort anmelden (bzw. muss 2FA neu einrichten, falls vorgeschrieben).</>, { danger: true }))
            action.mutate({ path: `/admin/users/${u.id}/reset-2fa` }, { onSuccess: () => toast.success('2FA zurückgesetzt') });
        },
      },
      {
        label: 'Überall abmelden',
        icon: <LogOut />,
        onClick: async () => {
          if (await confirm(<>Alle Sitzungen und API-Tokens von <b>{u.name}</b> beenden?</>, { danger: true }))
            action.mutate({ path: `/admin/users/${u.id}/logout` }, { onSuccess: () => toast.success('Sitzungen beendet') });
        },
      },
      { divider: true, label: '' },
      u.disabled
        ? { label: 'Aktivieren', icon: <UserCheck />, onClick: () => action.mutate({ path: `/admin/users/${u.id}`, method: 'PATCH', body: { disabled: false } }) }
        : {
            label: 'Deaktivieren',
            icon: <UserX />,
            disabled: self,
            onClick: async () => {
              if (await confirm(<>Benutzer <b>{u.name}</b> deaktivieren? Alle Sitzungen werden beendet; die Daten bleiben erhalten.</>))
                action.mutate({ path: `/admin/users/${u.id}`, method: 'PATCH', body: { disabled: true } });
            },
          },
      {
        label: 'Löschen',
        icon: <Trash2 />,
        danger: true,
        disabled: self,
        onClick: async () => {
          if (
            await confirm(
              <>
                Benutzer <b>{u.name}</b> ({u.email}) endgültig löschen?
                {u.accountCount > 0 && <> Dabei werden auch <b>{u.accountCount} verbundene(s) Konto(en)</b> aus Kuvert entfernt (die Postfächer beim Anbieter bleiben unberührt).</>}
              </>,
              { danger: true },
            )
          )
            action.mutate({ path: `/admin/users/${u.id}`, method: 'DELETE' }, { onSuccess: () => toast.success('Benutzer gelöscht') });
        },
      },
    ];
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Users />}
        title="Benutzer"
        description="Benutzer anlegen, Rechte vergeben, Passwörter und Zwei-Faktor-Authentifizierung zurücksetzen."
        actions={
          <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Benutzer anlegen
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input className="pl-9" placeholder="Name oder E-Mail suchen" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: 'all', label: `Alle${users ? ` (${users.length})` : ''}` },
            { value: 'admins', label: 'Admins' },
            { value: 'no2fa', label: 'Ohne 2FA' },
            { value: 'disabled', label: 'Deaktiviert' },
          ]}
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-10">
          <EmptyState icon={<Users />} title="Keine Benutzer gefunden" />
        </div>
      ) : (
        <Table scroll={false}>
          <thead>
            <tr>
              <Th>Benutzer</Th>
              <Th className="hidden md:table-cell">Rolle</Th>
              <Th className="hidden sm:table-cell">Sicherheit</Th>
              <Th className="hidden lg:table-cell">Konten</Th>
              <Th className="hidden md:table-cell">Letzte Anmeldung</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="transition-colors hover:bg-hover/50">
                <Td>
                  <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={() => setDetails(u)}>
                    <Avatar name={u.name} email={u.email} src={u.avatarUrl} size={34} className={u.disabled ? 'opacity-50 grayscale' : ''} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 truncate font-medium">
                        {u.name}
                        {u.id === app?.user?.id && <Badge>Du</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted">{u.email}</span>
                    </span>
                  </button>
                </Td>
                <Td className="hidden md:table-cell">{u.isAdmin ? <Badge tone="primary">Administrator</Badge> : <span className="text-muted">Benutzer</span>}</Td>
                <Td className="hidden sm:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {u.disabled ? <Badge tone="danger">Deaktiviert</Badge> : <Badge tone="success">Aktiv</Badge>}
                    {u.twoFactorEnabled ? <Badge tone="info">2FA</Badge> : <Badge tone="warning">ohne 2FA</Badge>}
                    {u.mustChangePassword && <Badge>PW-Wechsel offen</Badge>}
                  </div>
                </Td>
                <Td className="hidden tabular-nums lg:table-cell">{u.accountCount}</Td>
                <Td className="hidden text-muted md:table-cell">{relativeTime(u.lastLoginAt, 'noch nie')}</Td>
                <Td>
                  <Dropdown
                    align="right"
                    items={menu(u)}
                    trigger={
                      <button type="button" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Aktionen">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    }
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={refresh} />}
      {editing && <EditUserDialog user={editing} isSelf={editing.id === app?.user?.id} onClose={() => setEditing(null)} onSaved={refresh} />}
      {pwUser && <PasswordDialog user={pwUser} onClose={() => setPwUser(null)} onSaved={refresh} />}
      <UserDrawer user={details} onClose={() => setDetails(null)} />
      {dialog}
    </div>
  );
}

/* ───────────────────────────── Dialoge ───────────────────────────── */

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" minLength={8} required />
      <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => onChange(generatePassword())} title="Zufälliges Passwort erzeugen">
        Erzeugen
      </Button>
      {value && <CopyButton value={value} label="" className="h-9 px-2.5" />}
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(generatePassword());
  const [isAdmin, setIsAdmin] = useState(false);
  const [mustChange, setMustChange] = useState(true);
  const m = useMutation({
    mutationFn: () => api('/admin/users', { method: 'POST', body: { name, email, password, isAdmin, mustChangePassword: mustChange } }),
    onSuccess: () => {
      toast.success(`Benutzer ${email} angelegt`);
      onCreated();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Benutzer anlegen"
      description="Teile dem Benutzer das Startpasswort auf einem sicheren Weg mit."
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={m.isPending} disabled={!name.trim() || !email.includes('@') || password.length < 8} onClick={() => m.mutate()}>
            Anlegen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="E-Mail (Anmeldename)">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field label="Startpasswort" hint="Mindestens 8 Zeichen">
          <PasswordField value={password} onChange={setPassword} />
        </Field>
        <div className="space-y-3 rounded-xl border border-border p-3">
          <Switch checked={mustChange} onChange={setMustChange} label="Muss Passwort bei der ersten Anmeldung ändern" />
          <Switch checked={isAdmin} onChange={setIsAdmin} label="Administrator-Rechte" />
        </div>
      </div>
    </Modal>
  );
}

function EditUserDialog({ user, isSelf, onClose, onSaved }: { user: AdminUser; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [disabled, setDisabled] = useState(user.disabled);
  const m = useMutation({
    mutationFn: () => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { name, email, isAdmin, disabled } }),
    onSuccess: () => {
      toast.success('Gespeichert');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Benutzer bearbeiten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="E-Mail">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-3 rounded-xl border border-border p-3">
          <Switch checked={isAdmin} onChange={setIsAdmin} disabled={isSelf} label="Administrator" />
          <Switch checked={disabled} onChange={setDisabled} disabled={isSelf} label="Deaktiviert (keine Anmeldung möglich)" />
          {isSelf && <p className="text-xs text-muted">Rolle und Status des eigenen Kontos können nicht geändert werden.</p>}
        </div>
      </div>
    </Modal>
  );
}

function PasswordDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState(generatePassword());
  const [mustChange, setMustChange] = useState(true);
  const m = useMutation({
    mutationFn: () => api(`/admin/users/${user.id}/password`, { method: 'POST', body: { password, mustChange } }),
    onSuccess: () => {
      toast.success('Passwort gesetzt – alle Sitzungen des Benutzers wurden beendet');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Passwort für ${user.name} setzen`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={m.isPending} disabled={password.length < 8} onClick={() => m.mutate()}>
            Passwort setzen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Neues Passwort">
          <PasswordField value={password} onChange={setPassword} />
        </Field>
        <Switch checked={mustChange} onChange={setMustChange} label="Bei nächster Anmeldung ändern lassen" />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Details ───────────────────────────── */

function UserDrawer({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { data: accounts, isLoading: la } = useQuery({
    queryKey: ['admin', 'users', user?.id, 'accounts'],
    queryFn: () => api<AccountInfo[]>(`/admin/users/${user!.id}/accounts`),
    enabled: !!user,
  });
  const { data: sessions, isLoading: ls } = useQuery({
    queryKey: ['admin', 'users', user?.id, 'sessions'],
    queryFn: () => api<SessionInfo[]>(`/admin/users/${user!.id}/sessions`),
    enabled: !!user,
  });
  if (!user) return null;
  const p = user.profile;
  const profileRows = [
    ['Position', p.jobTitle],
    ['Abteilung', p.department],
    ['Firma', p.company],
    ['Telefon', p.phone],
    ['Mobil', p.mobile],
    ['Zeitzone', p.timezone],
  ].filter(([, v]) => v);

  return (
    <Drawer open onClose={onClose} title={user.name} description={user.email} width="max-w-lg">
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar name={user.name} email={user.email} src={user.avatarUrl} size={56} />
          <div className="flex flex-wrap gap-1.5">
            {user.isAdmin && <Badge tone="primary">Administrator</Badge>}
            {user.disabled ? <Badge tone="danger">Deaktiviert</Badge> : <Badge tone="success">Aktiv</Badge>}
            {user.twoFactorEnabled ? <Badge tone="info">2FA aktiv</Badge> : <Badge tone="warning">ohne 2FA</Badge>}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted">Angelegt</dt>
            <dd>{relativeTime(user.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Letzte Anmeldung</dt>
            <dd>{relativeTime(user.lastLoginAt, 'noch nie')}</dd>
          </div>
          {profileRows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="truncate">{v}</dd>
            </div>
          ))}
        </dl>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Verbundene Konten</h3>
          {la ? (
            <Skeleton className="h-12 w-full" />
          ) : !accounts?.length ? (
            <p className="text-sm text-muted">Keine Konten.</p>
          ) : (
            <ul className="space-y-1.5">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-sm">
                  <ColorDot color={a.color} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {a.type} · {a.email}
                    </span>
                  </span>
                  {a.status !== 'ok' && <Badge tone={a.status === 'reauth' ? 'warning' : 'danger'}>{a.status === 'reauth' ? 'Neu verbinden' : 'Fehler'}</Badge>}
                  {!a.enabled && <Badge>aus</Badge>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Aktive Sitzungen</h3>
          {ls ? (
            <Skeleton className="h-12 w-full" />
          ) : !sessions?.length ? (
            <p className="text-sm text-muted">Keine aktiven Sitzungen.</p>
          ) : (
            <ul className="space-y-1.5">
              {sessions.map((s) => {
                const ua = parseUserAgent(s.userAgent);
                return (
                  <li key={s.id} className="rounded-xl border border-border px-3 py-2 text-sm">
                    <div className="font-medium">
                      {ua.browser} {ua.os && <span className="font-normal text-muted">auf {ua.os}</span>}
                    </div>
                    <div className="text-xs text-muted">
                      {s.ip ?? '–'} · zuletzt {relativeTime(s.lastSeenAt ?? s.createdAt)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
