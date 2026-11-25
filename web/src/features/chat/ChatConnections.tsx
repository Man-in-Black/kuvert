/**
 * Einstellungen → Chat → Verbundene Dienste: Mattermost, Nextcloud Talk und Microsoft Teams anbinden.
 * Deren Unterhaltungen erscheinen danach in derselben Chat-Oberfläche.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { CHAT_BRIDGE_LABELS, type ChatBridgeType, type ChatConnection, type ChatConnectionInput } from '@kuvert/shared';
import { Badge, Button, Field, Input, Modal, Select, Spinner, Tabs, useConfirm } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useAccounts } from '@/lib/queries';
import { Card, HelpBox } from '@/features/settings/ui';
import { chatApi, chatKeys, useConnections } from './api';

export function ChatConnections() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useConnections();
  const { confirm, dialog } = useConfirm();
  const [adding, setAdding] = useState<ChatBridgeType | null>(null);
  const [params] = useSearchParams();
  const resumed = useRef(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: chatKeys.connections });
    void qc.invalidateQueries({ queryKey: chatKeys.conversations });
  };

  // Zurück von der Microsoft-Zustimmung: Teams-Verbindung direkt einrichten
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const accountId = takeTeamsConsent();
    if (!accountId || params.get('error')) return;
    chatApi
      .addConnection({ type: 'teams', fromAccountId: accountId })
      .then((conn) => {
        toast.success(`${conn.label} verbunden`);
        refresh();
      })
      .catch((err) => {
        toast.error(errorMessage(err));
        setAdding('teams');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (c: ChatConnection) => {
    if (!(await confirm(`Verbindung „${c.label}“ entfernen? Die Unterhaltungen bleiben im Dienst erhalten, erscheinen aber nicht mehr in Kuvert.`, { danger: true }))) return;
    try {
      await chatApi.removeConnection(c.id);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const restart = async (c: ChatConnection) => {
    try {
      await chatApi.restartConnection(c.id);
      toast.success('Verbindung wird neu aufgebaut');
      setTimeout(refresh, 1500);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card
      title="Verbundene Dienste"
      description="Unterhaltungen aus Mattermost, Nextcloud Talk und Microsoft Teams zusätzlich im Kuvert-Chat anzeigen und beantworten."
      actions={
        <>
          <Button size="sm" icon={<Plug className="h-4 w-4" />} onClick={() => setAdding('mattermost')}>
            Mattermost
          </Button>
          <Button size="sm" icon={<Plug className="h-4 w-4" />} onClick={() => setAdding('talk')}>
            Nextcloud Talk
          </Button>
          <Button size="sm" icon={<Plug className="h-4 w-4" />} onClick={() => setAdding('teams')}>
            Teams
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : error ? (
        <div className="text-sm text-danger">{errorMessage(error)}</div>
      ) : !data?.length ? (
        <p className="text-sm text-muted">Noch keine Dienste verbunden.</p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border">
          {data.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{c.label}</span>
                  {c.status === 'ok' ? <Badge tone="success">Verbunden</Badge> : c.status === 'error' ? <Badge tone="danger">Gestört</Badge> : <Badge>Verbinde …</Badge>}
                </span>
                <span className="block truncate text-xs text-muted">
                  {CHAT_BRIDGE_LABELS[c.type]} · {c.displayName || c.username} · {c.baseUrl}
                </span>
                {c.status === 'error' && c.error && <span className="block text-xs text-danger">{c.error}</span>}
              </span>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void restart(c)}>
                Neu verbinden
              </Button>
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10" icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove(c)}>
                Entfernen
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3">
        <HelpBox>
          Stummschalten und Anheften gelten nur in Kuvert. Mattermost-Nachrichten kommen in Echtzeit an; Nextcloud Talk und Teams werden alle paar Sekunden
          abgefragt, geöffnete Unterhaltungen laufend aktualisiert. Benachrichtigt wird bei Direktnachrichten sowie in Gruppen und Kanälen nur bei
          Erwähnung (@Name, @all). Tippen-Anzeige gibt es nur bei Mattermost. Teams nutzt ein vorhandenes Microsoft-365-Konto und zeigt Chats
          (keine Team-Kanäle); Dateien lassen sich dort empfangen, aber noch nicht senden.
        </HelpBox>
      </div>
      {adding && <AddConnectionDialog type={adding} onClose={() => setAdding(null)} onAdded={refresh} />}
      {dialog}
    </Card>
  );
}

function AddConnectionDialog({ type, onClose, onAdded }: { type: ChatBridgeType; onClose: () => void; onAdded: () => void }) {
  const { data: accounts } = useAccounts();
  const nextcloud = (accounts ?? []).filter((a) => a.type === 'nextcloud');
  const microsoft = (accounts ?? []).filter((a) => a.type === 'microsoft');
  const [mmAuth, setMmAuth] = useState<'token' | 'password'>('token');
  const [fromAccount, setFromAccount] = useState('');
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const msAccount = type === 'teams' ? fromAccount || (microsoft.length === 1 ? microsoft[0]!.id : '') : '';
  const [form, setForm] = useState({ label: '', baseUrl: '', username: '', password: '', token: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const valid =
    type === 'mattermost'
      ? !!form.baseUrl.trim() && (mmAuth === 'token' ? !!form.token.trim() : !!form.username.trim() && !!form.password)
      : type === 'teams'
        ? !!msAccount
        : !!fromAccount || (!!form.baseUrl.trim() && !!form.username.trim() && !!form.password);

  const submit = async () => {
    const input: ChatConnectionInput =
      type === 'teams'
        ? { type, label: form.label.trim() || undefined, fromAccountId: msAccount }
        : type === 'mattermost'
        ? {
            type,
            label: form.label.trim() || undefined,
            baseUrl: form.baseUrl.trim(),
            ...(mmAuth === 'token' ? { token: form.token.trim() } : { username: form.username.trim(), password: form.password }),
          }
        : fromAccount
          ? { type, label: form.label.trim() || undefined, fromAccountId: fromAccount }
          : { type, label: form.label.trim() || undefined, baseUrl: form.baseUrl.trim(), username: form.username.trim(), password: form.password };
    setBusy(true);
    try {
      const conn = await chatApi.addConnection(input);
      toast.success(`${conn.label} verbunden`);
      onAdded();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'teams_consent') setConsentFor(msAccount);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${CHAT_BRIDGE_LABELS[type]} verbinden`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            Verbinden
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void submit();
        }}
      >
        {type === 'teams' &&
          (microsoft.length === 0 ? (
            <p className="text-sm text-muted">
              Für Teams wird ein Microsoft-365-Konto benötigt. Bitte zuerst unter <strong>Einstellungen → Konten</strong> ein Microsoft-365-Konto verbinden.
            </p>
          ) : (
            <>
              <Field label="Microsoft-365-Konto" hint="Teams-Chats dieses Kontos erscheinen im Kuvert-Chat">
                <Select value={msAccount} onChange={(e) => setFromAccount(e.target.value)} autoFocus>
                  {microsoft.length > 1 && <option value="">Bitte wählen …</option>}
                  {microsoft.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.email})
                    </option>
                  ))}
                </Select>
              </Field>
              {consentFor && consentFor === msAccount && (
                <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p>
                    Kuvert darf noch nicht auf deine Teams-Chats zugreifen. Melde dich einmal bei Microsoft an und erteile die Berechtigung
                    „Chats lesen und schreiben“ – danach wird die Verbindung automatisch eingerichtet.
                  </p>
                  <p className="text-xs text-muted">
                    Lässt deine Organisation keine eigene Zustimmung zu, kann ein Administrator die Berechtigung erteilen (Admin → Dienste &amp; Anmeldung →
                    Microsoft „Automatisch einrichten“ erneut ausführen).
                  </p>
                  <Button size="sm" variant="primary" icon={<ExternalLink className="h-4 w-4" />} onClick={() => startTeamsConsent(consentFor)}>
                    Bei Microsoft zustimmen
                  </Button>
                </div>
              )}
            </>
          ))}

        {type === 'talk' && nextcloud.length > 0 && (
          <Field label="Zugangsdaten" hint="Ein vorhandenes Nextcloud-Konto kann direkt verwendet werden">
            <Select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
              <option value="">Manuell eingeben</option>
              {nextcloud.map((a) => (
                <option key={a.id} value={a.id}>
                  Aus Konto „{a.name}“ übernehmen
                </option>
              ))}
            </Select>
          </Field>
        )}

        {type !== 'teams' && !(type === 'talk' && fromAccount) && (
          <Field label={type === 'mattermost' ? 'Mattermost-Adresse' : 'Nextcloud-Adresse'}>
            <Input
              type="url"
              value={form.baseUrl}
              onChange={set('baseUrl')}
              placeholder={type === 'mattermost' ? 'https://chat.example.com' : 'https://cloud.example.com'}
              autoFocus
            />
          </Field>
        )}

        {type === 'mattermost' && (
          <>
            <Tabs
              value={mmAuth}
              onChange={setMmAuth}
              tabs={[
                { value: 'token', label: 'Zugriffstoken' },
                { value: 'password', label: 'Benutzername & Passwort' },
              ]}
            />
            {mmAuth === 'token' ? (
              <Field label="Persönliches Zugriffstoken" hint="Mattermost → Profil → Sicherheit → Persönliche Zugriffstoken (muss vom Admin erlaubt sein)">
                <Input type="password" value={form.token} onChange={set('token')} autoComplete="off" />
              </Field>
            ) : (
              <>
                <Field label="Benutzername oder E-Mail">
                  <Input value={form.username} onChange={set('username')} autoComplete="off" />
                </Field>
                <Field label="Passwort" hint="Wird verschlüsselt gespeichert, um die Sitzung bei Ablauf zu erneuern. Bei Zwei-Faktor-Anmeldung bitte ein Zugriffstoken verwenden.">
                  <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
                </Field>
              </>
            )}
          </>
        )}

        {type === 'talk' && !fromAccount && (
          <>
            <Field label="Benutzername">
              <Input value={form.username} onChange={set('username')} autoComplete="off" />
            </Field>
            <Field label="App-Passwort" hint="Nextcloud → Persönliche Einstellungen → Sicherheit → Neues App-Passwort erstellen">
              <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
          </>
        )}

        <Field label="Bezeichnung (optional)">
          <Input
            value={form.label}
            onChange={set('label')}
            maxLength={80}
            placeholder={type === 'mattermost' ? 'z. B. Mattermost Firma' : type === 'teams' ? 'z. B. Teams Firma' : 'z. B. Talk Firma'}
          />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

/* ───────────── Teams: Zustimmung bei Microsoft ───────────── */

const CONSENT_KEY = 'kuvert.teamsConsent';

/** Microsoft-Anmeldung mit zusätzlicher Chat-Berechtigung; danach zurück in die Chat-Einstellungen */
function startTeamsConsent(accountId: string) {
  try {
    sessionStorage.setItem(CONSENT_KEY, accountId);
  } catch {
    /* ohne Speicher muss der Benutzer danach erneut auf „Verbinden“ klicken */
  }
  const q = new URLSearchParams({ accountId, features: 'chat', returnTo: '/settings/chat' });
  window.location.href = `/api/accounts/oauth/microsoft/start?${q.toString()}`;
}

function takeTeamsConsent(): string | null {
  try {
    const id = sessionStorage.getItem(CONSENT_KEY);
    sessionStorage.removeItem(CONSENT_KEY);
    return id;
  } catch {
    return null;
  }
}
