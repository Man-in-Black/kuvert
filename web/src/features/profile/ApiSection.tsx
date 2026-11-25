import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, Code2, ExternalLink, KeyRound, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { WEBHOOK_EVENTS, type ApiScope, type ApiTokenCreated, type ApiTokenInfo, type Webhook, type WebhookCreated, type WebhookEvent } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAppInfo } from '@/lib/queries';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBox,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  useConfirm,
} from '@/components/ui';
import { absoluteTime, relativeTime } from './format';

const tokensKey = ['profile', 'tokens'] as const;
const webhooksKey = ['profile', 'webhooks'] as const;

const SCOPES: { value: ApiScope; label: string; hint: string }[] = [
  { value: 'read', label: 'Lesen', hint: 'GET-Anfragen: Mails, Kalender, Kontakte … abrufen' },
  { value: 'write', label: 'Schreiben', hint: 'Senden, ändern, löschen (inkl. Lesen)' },
  { value: 'admin', label: 'Admin', hint: 'Zugriff auf /api/admin (nur Administratoren)' },
];

export const EVENT_LABELS: Record<WebhookEvent, string> = {
  'mail.new': 'Neue E-Mail',
  'mail.changed': 'Postfach geändert',
  'mail.triage': 'Mail per KI eingeordnet',
  'calendar.reminder': 'Terminerinnerung',
  'calendar.changed': 'Kalender geändert',
  'account.status': 'Kontostatus geändert',
  'send.status': 'Versandstatus',
  'chat.message': 'Neue Chatnachricht',
};

export function ApiSection() {
  const { data: app } = useAppInfo();
  const base = app?.publicUrl ?? window.location.origin;
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Code2 />}
        title="API & Webhooks"
        description="Greife per REST-API auf Kuvert zu (z. B. für Skripte, n8n oder eigene Tools) und lass dich per Webhook über Ereignisse informieren."
        actions={
          <Button icon={<BookOpen className="h-4 w-4" />} onClick={() => window.open(app?.apiDocsUrl ?? '/api/docs', '_blank', 'noopener')}>
            API-Dokumentation
          </Button>
        }
      />
      <div className="grid gap-3 rounded-2xl border border-border bg-surface-2/60 p-4 text-sm sm:grid-cols-3">
        <Info label="Basis-URL" value={`${base}/api`} />
        <Info label="Authentifizierung" value="Authorization: Bearer kvt_…" />
        <Info label="Format" value="JSON · OpenAPI 3" />
      </div>
      <TokensCard base={base} />
      <WebhooksCard />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value}</div>
    </div>
  );
}

/* ───────────────────────────── Tokens ───────────────────────────── */

function TokensCard({ base }: { base: string }) {
  const qc = useQueryClient();
  const { data: app } = useAppInfo();
  const { confirm, dialog } = useConfirm();
  const { data: tokens, isLoading } = useQuery({ queryKey: tokensKey, queryFn: () => api<ApiTokenInfo[]>('/profile/tokens') });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const allowed = !!app?.user?.isAdmin || !!app?.policies?.usersCanCreateApiTokens;

  const del = useMutation({
    mutationFn: (id: string) => api(`/profile/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Token widerrufen');
      qc.invalidateQueries({ queryKey: tokensKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card
      icon={<KeyRound />}
      title="Persönliche API-Tokens"
      description="Tokens handeln in deinem Namen – behandle sie wie Passwörter."
      actions={
        allowed && (
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
            Neues Token
          </Button>
        )
      }
      bodyClassName="p-0 pt-2"
    >
      {!allowed && <p className="px-5 pb-4 text-sm text-muted">Das Erstellen von API-Tokens wurde vom Administrator deaktiviert.</p>}
      {isLoading ? (
        <div className="p-5">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !tokens?.length ? (
        <div className="px-5 pb-6 pt-2 text-sm text-muted">Noch keine Tokens erstellt.</div>
      ) : (
        <ul className="divide-y divide-border">
          {tokens.map((t) => {
            const expired = !!t.expiresAt && new Date(t.expiresAt) < new Date();
            return (
              <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted ring-1 ring-border">
                  <KeyRound className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t.name}
                    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{t.prefix}…</code>
                    {t.scopes.map((s) => (
                      <Badge key={s} tone={s === 'admin' ? 'danger' : s === 'write' ? 'warning' : 'info'}>
                        {SCOPES.find((x) => x.value === s)?.label ?? s}
                      </Badge>
                    ))}
                    {expired && <Badge tone="danger">abgelaufen</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Erstellt {absoluteTime(t.createdAt)} · zuletzt verwendet {relativeTime(t.lastUsedAt, 'nie')} ·{' '}
                    {t.expiresAt ? `läuft ${relativeTime(t.expiresAt)} ab` : 'unbegrenzt gültig'}
                  </div>
                </div>
                <IconButton
                  label="Widerrufen"
                  className="hover:text-danger"
                  onClick={async () => {
                    if (await confirm(`Token „${t.name}“ widerrufen? Anwendungen, die es nutzen, verlieren sofort den Zugriff.`, { danger: true })) del.mutate(t.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <CreateTokenDialog
        open={creating}
        onClose={() => setCreating(false)}
        isAdmin={!!app?.user?.isAdmin}
        onCreated={(c) => {
          setCreating(false);
          setCreated(c);
          qc.invalidateQueries({ queryKey: tokensKey });
        }}
      />
      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        size="lg"
        title="Token erstellt"
        description="Kopiere das Token jetzt – es wird aus Sicherheitsgründen nicht erneut angezeigt."
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Ich habe das Token gespeichert
          </Button>
        }
      >
        {created && (
          <div className="space-y-4">
            <CodeBox value={created.token} />
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">Beispiel</div>
              <CodeBox multiline value={`curl -H "Authorization: Bearer ${created.token}" \\\n  ${base}/api/accounts`} />
            </div>
          </div>
        )}
      </Modal>
      {dialog}
    </Card>
  );
}

function CreateTokenDialog({ open, onClose, isAdmin, onCreated }: { open: boolean; onClose: () => void; isAdmin: boolean; onCreated: (c: ApiTokenCreated) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['read']);
  const [expires, setExpires] = useState('90');
  const m = useMutation({
    mutationFn: () =>
      api<ApiTokenCreated>('/profile/tokens', { method: 'POST', body: { name, scopes, expiresDays: expires === 'never' ? null : Number(expires) } }),
    onSuccess: (c) => {
      setName('');
      setScopes(['read']);
      onCreated(c);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const toggle = (s: ApiScope, v: boolean) => setScopes((cur) => (v ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Neues API-Token"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={m.isPending} disabled={!name.trim() || !scopes.length} onClick={() => m.mutate()}>
            Token erstellen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Bezeichnung" hint="Wofür wird das Token verwendet? z. B. „n8n Automatisierung“">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
        </Field>
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg/80">Berechtigungen</div>
          {SCOPES.filter((s) => s.value !== 'admin' || isAdmin).map((s) => (
            <div key={s.value} className="rounded-xl border border-border p-3">
              <Checkbox checked={scopes.includes(s.value)} onChange={(v) => toggle(s.value, v)} label={<span className="font-medium">{s.label}</span>} />
              <div className="ml-7 mt-0.5 text-xs text-muted">{s.hint}</div>
            </div>
          ))}
        </div>
        <Field label="Gültigkeit">
          <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="7">7 Tage</option>
            <option value="30">30 Tage</option>
            <option value="90">90 Tage</option>
            <option value="365">1 Jahr</option>
            <option value="never">Unbegrenzt</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Webhooks ───────────────────────────── */

function WebhooksCard() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { data: hooks, isLoading } = useQuery({ queryKey: webhooksKey, queryFn: () => api<Webhook[]>('/profile/webhooks') });
  const [edit, setEdit] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Webhook> }) => api<Webhook>(`/profile/webhooks/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/profile/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ status: number | null; error: string | null }>(`/profile/webhooks/${id}/test`, { method: 'POST' }),
    onSuccess: (r) => {
      if (r.error) toast.error(`Zustellung fehlgeschlagen: ${r.error}`);
      else toast.success(`Testereignis zugestellt (HTTP ${r.status})`);
      qc.invalidateQueries({ queryKey: webhooksKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card
      icon={<WebhookIcon />}
      title="Webhooks"
      description={
        <>
          Ereignisse werden als JSON per POST zugestellt. Prüfe die Echtheit über den Header <code className="font-mono">X-Kuvert-Signature</code> (HMAC-SHA256 des
          Bodys mit dem Webhook-Geheimnis).
        </>
      }
      actions={
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit('new')}>
          Webhook
        </Button>
      }
      bodyClassName="p-0 pt-2"
    >
      {isLoading ? (
        <div className="p-5">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !hooks?.length ? (
        <div className="pb-4">
          <EmptyState icon={<WebhookIcon />} title="Keine Webhooks">
            Verbinde Kuvert z. B. mit n8n, Node-RED oder Home Assistant.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {hooks.map((h) => (
            <li key={h.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {h.name}
                  {h.lastStatus != null && (
                    <Badge tone={h.lastError ? 'danger' : 'success'}>{h.lastError ? `Fehler: ${h.lastError}` : `HTTP ${h.lastStatus}`}</Badge>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted">{h.url}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {h.events.map((e) => (
                    <Badge key={e}>{EVENT_LABELS[e] ?? e}</Badge>
                  ))}
                </div>
                {h.lastDeliveryAt && <div className="mt-1 text-[11px] text-subtle">Zuletzt zugestellt {relativeTime(h.lastDeliveryAt)}</div>}
              </div>
              <div className="flex items-center gap-1">
                <Switch checked={h.active} onChange={(v) => patch.mutate({ id: h.id, body: { active: v } })} />
                <IconButton label="Test senden" onClick={() => test.mutate(h.id)} disabled={test.isPending}>
                  <Send className="h-4 w-4" />
                </IconButton>
                <IconButton label="Bearbeiten" onClick={() => setEdit(h)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label="Löschen"
                  className="hover:text-danger"
                  onClick={async () => {
                    if (await confirm(`Webhook „${h.name}“ löschen?`, { danger: true })) del.mutate(h.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <WebhookDialog
          hook={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(s) => {
            setEdit(null);
            qc.invalidateQueries({ queryKey: webhooksKey });
            if (s) setSecret(s);
          }}
        />
      )}
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        size="lg"
        title="Webhook-Geheimnis"
        description="Wird nur jetzt angezeigt. Damit prüfst du die Signatur eingehender Ereignisse."
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            Gespeichert
          </Button>
        }
      >
        {secret && (
          <div className="space-y-4">
            <CodeBox value={secret} />
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">Prüfung (Node.js)</div>
              <CodeBox
                multiline
                value={`const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');\nconst valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-kuvert-signature']));`}
              />
            </div>
          </div>
        )}
      </Modal>
      {dialog}
    </Card>
  );
}

function WebhookDialog({ hook, onClose, onSaved }: { hook: Webhook | null; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? ['mail.new']);
  const [active, setActive] = useState(hook?.active ?? true);
  const m = useMutation({
    mutationFn: async () => {
      const body = { name, url, events, active };
      if (hook) {
        await api(`/profile/webhooks/${hook.id}`, { method: 'PATCH', body });
        return undefined;
      }
      return (await api<WebhookCreated>('/profile/webhooks', { method: 'POST', body })).secret;
    },
    onSuccess: (s) => onSaved(s),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={hook ? 'Webhook bearbeiten' : 'Neuer Webhook'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={m.isPending} disabled={!name.trim() || !/^https?:\/\//.test(url) || !events.length} onClick={() => m.mutate()}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="z. B. n8n" />
        </Field>
        <Field label="Ziel-URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://automation.example.com/webhook/…" className="font-mono text-xs" />
        </Field>
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg/80">Ereignisse</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_EVENTS.map((e) => (
              <div key={e} className="flex items-center rounded-xl border border-border p-2.5 hover:bg-hover">
                <Checkbox
                  checked={events.includes(e)}
                  onChange={(v) => setEvents((cur) => (v ? [...cur, e] : cur.filter((x) => x !== e)))}
                  label={
                    <span className="flex flex-col">
                      <span>{EVENT_LABELS[e]}</span>
                      <code className="font-mono text-[10px] text-subtle">{e}</code>
                    </span>
                  }
                />
              </div>
            ))}
          </div>
        </div>
        <Switch checked={active} onChange={setActive} label="Aktiv" />
        {!hook && (
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" /> Nach dem Speichern wird das Signatur-Geheimnis einmalig angezeigt.
          </p>
        )}
      </div>
    </Modal>
  );
}
