/**
 * Provisionierung in einem Schritt: mailcow-Postfach anlegen, optional Kuvert-Benutzer
 * anlegen bzw. auswählen und direkt ein mailcow-Konto (Mail + SOGo) einrichten.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, KeyRound, Sparkles } from 'lucide-react';
import type { AdminUser, MailcowInstanceInfo, MailcowProvisionRequest, MailcowProvisionResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Button, Checkbox, CodeBox, Field, Input, Modal, Select, Switch, Tabs } from '@/components/ui';
import { generatePassword, mk, useDomains } from './api';

type UserMode = 'none' | 'existing' | 'new';

export function ProvisionDialog({ instance, onClose }: { instance: MailcowInstanceInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: domains } = useDomains(instance.id);
  const { data: users } = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users') });

  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [quotaMb, setQuotaMb] = useState(3072);
  const [active, setActive] = useState(true);
  const [mode, setMode] = useState<UserMode>('new');
  const [userId, setUserId] = useState('');
  const [kEmail, setKEmail] = useState('');
  const [kPassword, setKPassword] = useState(() => generatePassword(14));
  const [mustChange, setMustChange] = useState(true);
  const [addAccount, setAddAccount] = useState(true);
  const [result, setResult] = useState<MailcowProvisionResult | null>(null);

  useEffect(() => {
    if (!domain && domains?.length) setDomain(domains[0]!.domain);
  }, [domains, domain]);

  const address = localPart && domain ? `${localPart}@${domain}`.toLowerCase() : '';
  useEffect(() => {
    // Kuvert-Login standardmäßig = Postfachadresse
    if (mode === 'new') setKEmail(address);
  }, [address, mode]);

  const run = useMutation({
    mutationFn: () => {
      const kuvertUser: MailcowProvisionRequest['kuvertUser'] =
        mode === 'none'
          ? { mode: 'none' }
          : mode === 'existing'
            ? { mode: 'existing', userId }
            : { mode: 'new', email: kEmail, name: name || localPart, password: kPassword, mustChangePassword: mustChange };
      const body: MailcowProvisionRequest = { instanceId: instance.id, localPart, domain, name, password, quotaMb, active, kuvertUser, addAccount: mode !== 'none' && addAccount };
      return api<MailcowProvisionResult>('/mailcow/provision', { method: 'POST', body });
    },
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: mk.all });
      qc.invalidateQueries({ queryKey: ['admin'] });
      if (r.warnings.length) r.warnings.forEach((w) => toast.warning(w));
      else toast.success(`Postfach ${r.mailbox} angelegt`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const valid =
    localPart.trim() &&
    domain &&
    password.length >= 8 &&
    (mode !== 'existing' || userId) &&
    (mode !== 'new' || (kEmail.includes('@') && kPassword.length >= 8));

  if (result) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Fertig eingerichtet"
        footer={
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/5 p-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
            <div className="text-sm">
              Postfach <strong>{result.mailbox}</strong> wurde angelegt
              {result.userId ? ' und mit dem Kuvert-Benutzer verknüpft' : ''}
              {result.accountId ? ' – das Konto ist direkt einsatzbereit.' : '.'}
            </div>
          </div>
          <Field label="Postfach-Passwort (nur jetzt sichtbar)">
            <CodeBox value={password} />
          </Field>
          {mode === 'new' && result.userId && (
            <Field label="Kuvert-Anmeldung" hint={mustChange ? 'Muss beim ersten Login geändert werden.' : undefined}>
              <CodeBox value={`${kEmail} / ${kPassword}`} />
            </Field>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Neues Postfach"
      description={`Auf ${instance.name} (${instance.hostname})`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={<Sparkles className="h-4 w-4" />} loading={run.isPending} disabled={!valid} onClick={() => run.mutate()}>
            Anlegen
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Postfach</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Adresse">
              <div className="flex items-center gap-1.5">
                <Input value={localPart} onChange={(e) => setLocalPart(e.target.value.replace(/\s/g, ''))} placeholder="vorname.nachname" />
                <span className="text-muted">@</span>
                <Select value={domain} onChange={(e) => setDomain(e.target.value)} className="min-w-36">
                  {(domains ?? []).map((d) => (
                    <option key={d.domain} value={d.domain}>
                      {d.domain}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Anzeigename">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Max Mustermann" />
            </Field>
            <Field label="Passwort">
              <div className="flex gap-2">
                <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" autoComplete="new-password" />
                <Button icon={<KeyRound className="h-4 w-4" />} onClick={() => setPassword(generatePassword())} title="Neues Passwort erzeugen" />
              </div>
            </Field>
            <Field label="Kontingent (MB)" hint="0 = unbegrenzt">
              <Input type="number" min={0} value={quotaMb} onChange={(e) => setQuotaMb(Number(e.target.value))} />
            </Field>
          </div>
          <Switch checked={active} onChange={setActive} label="Postfach sofort aktiv" />
        </section>

        <section className="space-y-4 border-t border-border pt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Kuvert-Benutzer</h3>
          <Tabs<UserMode>
            value={mode}
            onChange={setMode}
            tabs={[
              { value: 'new', label: 'Neu anlegen' },
              { value: 'existing', label: 'Vorhandenen wählen' },
              { value: 'none', label: 'Nur Postfach' },
            ]}
          />
          {mode === 'existing' && (
            <Field label="Benutzer">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Bitte wählen …</option>
                {(users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {mode === 'new' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Login-E-Mail">
                <Input type="email" value={kEmail} onChange={(e) => setKEmail(e.target.value)} />
              </Field>
              <Field label="Start-Passwort für Kuvert">
                <Input value={kPassword} onChange={(e) => setKPassword(e.target.value)} className="font-mono" />
              </Field>
              <Checkbox checked={mustChange} onChange={setMustChange} label="Passwort beim ersten Login ändern" />
            </div>
          )}
          {mode !== 'none' && (
            <Checkbox
              checked={addAccount}
              onChange={setAddAccount}
              label="Konto direkt einrichten (E-Mail, Kalender, Kontakte und Aufgaben über SOGo)"
            />
          )}
        </section>
      </div>
    </Modal>
  );
}
