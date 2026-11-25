import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import type { AccountInfo, AccountTypeInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { isValidEmail } from '@/lib/utils';
import { Button, Field, Input, Modal, Switch } from '@/components/ui';
import { DynamicForm, initialValues, normalizeValues, type FormValues } from '../DynamicForm';
import { HelpBox } from '../ui';
import { AccountTypeIcon, ColorPicker } from './shared';

export function EditAccountDialog({ account, type, onClose }: { account: AccountInfo; type?: AccountTypeInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(account.name);
  const [color, setColor] = useState(account.color);
  const [enabled, setEnabled] = useState(account.enabled);
  const [unified, setUnified] = useState(account.settings.includeInUnifiedInbox !== false);
  const [notify, setNotify] = useState(account.settings.notify !== false);
  const [shared, setShared] = useState<string[]>(account.settings.sharedMailboxes ?? []);
  const [newShared, setNewShared] = useState('');
  const [extra, setExtra] = useState<FormValues>(() => initialValues(type?.settingsFields, account.settings as Record<string, unknown>));
  const [creds, setCreds] = useState<FormValues>(() => initialValues(type?.fields, account.config));
  const [saving, setSaving] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  useEffect(() => {
    setExtra(initialValues(type?.settingsFields, account.settings as Record<string, unknown>));
    setCreds(initialValues(type?.fields, account.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, account.id]);

  const isMicrosoft = account.type === 'microsoft';
  const isForm = type?.auth === 'form' && (type.fields?.length ?? 0) > 0;
  const hasMail = account.capabilities.includes('mail');

  const addShared = () => {
    const v = newShared.trim().toLowerCase();
    if (!isValidEmail(v)) {
      toast.error('Bitte eine gültige E-Mail-Adresse eingeben');
      return;
    }
    if (!shared.includes(v)) setShared([...shared, v]);
    setNewShared('');
  };

  const save = async () => {
    setSaving(true);
    try {
      const settings: Record<string, unknown> = {
        ...normalizeValues(type?.settingsFields, extra),
        includeInUnifiedInbox: unified,
        notify,
      };
      if (isMicrosoft) settings.sharedMailboxes = shared;
      await api(`/accounts/${account.id}`, { method: 'PATCH', body: { name: name.trim() || account.name, color, enabled, settings } });
      await qc.invalidateQueries({ queryKey: qk.accounts });
      await qc.invalidateQueries({ queryKey: ['mail'] });
      toast.success('Konto gespeichert');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCreds(true);
    setCredError(null);
    try {
      await api(`/accounts/${account.id}/credentials`, { method: 'PUT', body: { values: normalizeValues(type?.fields, creds) } });
      await qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success('Zugangsdaten geprüft und gespeichert');
    } catch (err) {
      setCredError(errorMessage(err));
    } finally {
      setSavingCreds(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <AccountTypeIcon type={account.type} capabilities={account.capabilities} />
          Konto bearbeiten
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Anzeigename">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="E-Mail / Benutzer">
            <Input value={account.email} disabled />
          </Field>
          <Field label="Farbe" className="col-span-full">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-4">
          <Switch checked={enabled} onChange={setEnabled} label="Konto aktiv" />
          {hasMail && <Switch checked={unified} onChange={setUnified} label="Im gemeinsamen Posteingang anzeigen" />}
          {hasMail && <Switch checked={notify} onChange={setNotify} label="Benachrichtigungen für neue E-Mails" />}
        </div>

        {type?.settingsFields && type.settingsFields.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Weitere Einstellungen</h3>
            <DynamicForm fields={type.settingsFields} values={extra} onChange={setExtra} />
          </div>
        )}

        {isMicrosoft && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Freigegebene Postfächer</h3>
            <p className="mb-3 text-xs text-muted">
              Zusätzliche Postfächer (z. B. info@ oder support@), auf die dieses Konto Zugriff hat. Sie erscheinen als eigene Ordnerbäume und
              können als Absender gewählt werden.
            </p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {shared.length === 0 && <span className="text-xs text-muted">Keine freigegebenen Postfächer eingetragen.</span>}
              {shared.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
                  {s}
                  <button type="button" className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg" onClick={() => setShared(shared.filter((x) => x !== s))} aria-label="Entfernen">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={newShared}
                placeholder="postfach@firma.de"
                onChange={(e) => setNewShared(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addShared();
                  }
                }}
              />
              <Button icon={<Plus className="h-4 w-4" />} onClick={addShared}>
                Hinzufügen
              </Button>
            </div>
            <div className="mt-3">
              <HelpBox>
                Voraussetzung: Ihr Benutzer hat in Exchange Online die Berechtigung „Vollzugriff" (und für den Versand „Senden als" oder
                „Senden im Auftrag von") für das Postfach. Kuvert nutzt dafür die delegierten Graph-Berechtigungen Mail.ReadWrite.Shared und
                Mail.Send.Shared – ggf. muss ein Administrator diese in der App-Registrierung zustimmen.
              </HelpBox>
            </div>
          </div>
        )}

        {isForm && type && (
          <form onSubmit={saveCreds} className="space-y-3 border-t border-border pt-5">
            <div>
              <h3 className="text-sm font-semibold">Zugangsdaten &amp; Server</h3>
              <p className="text-xs text-muted">Passwortfelder leer lassen, um sie unverändert zu übernehmen. Die Verbindung wird beim Speichern getestet.</p>
            </div>
            <DynamicForm fields={type.fields ?? []} values={creds} onChange={setCreds} editMode disabled={savingCreds} />
            {credError && <HelpBox tone="danger">{credError}</HelpBox>}
            <div className="flex justify-end">
              <Button type="submit" loading={savingCreds}>
                Zugangsdaten speichern
              </Button>
            </div>
          </form>
        )}

        {type?.auth === 'oauth' && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
            <p className="text-xs text-muted">Anmeldung erneuern (z. B. nach Passwortänderung oder neuen Berechtigungen).</p>
            <Button
              size="sm"
              onClick={() => (window.location.href = `/api/accounts/oauth/${encodeURIComponent(account.type)}/start?accountId=${encodeURIComponent(account.id)}`)}
            >
              Neu verbinden
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
