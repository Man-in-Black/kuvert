import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Plug, ShieldCheck, SlidersHorizontal, UserPlus } from 'lucide-react';
import type { AccountTypeInfo, SystemPolicies } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, Checkbox, Input, PageHeader, Skeleton, Switch } from '@/components/ui';
import { HelpBox, SettingRow } from '@/features/settings/ui';

const policiesKey = ['admin', 'policies'] as const;

export function PoliciesSection() {
  const qc = useQueryClient();
  const { data: policies, isLoading } = useQuery({ queryKey: policiesKey, queryFn: () => api<SystemPolicies>('/admin/policies') });
  const { data: types } = useQuery({ queryKey: ['admin', 'account-types'], queryFn: () => api<AccountTypeInfo[]>('/admin/account-types') });
  const [draft, setDraft] = useState<SystemPolicies | null>(null);

  useEffect(() => {
    if (policies) setDraft(policies);
  }, [policies]);

  const save = useMutation({
    mutationFn: (p: SystemPolicies) => api<SystemPolicies>('/admin/policies', { method: 'PUT', body: p }),
    onSuccess: (res) => {
      qc.setQueryData(policiesKey, res);
      qc.invalidateQueries({ queryKey: qk.app });
      toast.success('Richtlinien gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading || !draft || !policies) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-60 rounded-2xl" />
      </div>
    );
  }

  const set = <K extends keyof SystemPolicies>(k: K, v: SystemPolicies[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(policies);
  const allowAll = draft.allowedAccountTypes.length === 0;
  const toggleType = (t: string, on: boolean) => {
    const current = allowAll ? (types ?? []).map((x) => x.type) : draft.allowedAccountTypes;
    const next = on ? [...new Set([...current, t])] : current.filter((x) => x !== t);
    // Alle ausgewählt = keine Einschränkung
    set('allowedAccountTypes', types && next.length === types.length ? [] : next);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<SlidersHorizontal />}
        title="Richtlinien"
        description="Systemweite Vorgaben für Anmeldung, Sicherheit und Konten."
        actions={
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
            Speichern
          </Button>
        }
      />

      <Card icon={<ShieldCheck />} title="Anmeldung & Sicherheit">
        <SettingRow
          label="Zwei-Faktor-Authentifizierung vorschreiben"
          hint="Benutzer ohne 2FA müssen sie bei der nächsten Anmeldung einrichten, bevor sie Kuvert nutzen können."
        >
          <Switch checked={draft.require2fa} onChange={(v) => set('require2fa', v)} />
        </SettingRow>
        {draft.require2fa && !policies.require2fa && (
          <div className="pb-3">
            <HelpBox tone="warning">Nach dem Speichern werden alle Benutzer ohne 2FA (auch Administratoren) zur Einrichtung aufgefordert.</HelpBox>
          </div>
        )}
        <SettingRow label="Sitzungsdauer" hint="Nach dieser Zeit ist eine erneute Anmeldung nötig (gilt für neue Sitzungen).">
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={365} value={draft.sessionDays} onChange={(e) => set('sessionDays', Math.max(1, Number(e.target.value) || 1))} />
            <span className="text-sm text-muted">Tage</span>
          </div>
        </SettingRow>
      </Card>

      <Card icon={<UserPlus />} title="Benutzer">
        <SettingRow label="Selbstregistrierung erlauben" hint="Jeder mit Zugriff auf die Anmeldeseite kann ein Konto anlegen.">
          <Switch checked={draft.allowRegistration} onChange={(v) => set('allowRegistration', v)} />
        </SettingRow>
        <SettingRow label="Benutzer dürfen API-Tokens erstellen" hint="Administratoren können immer Tokens erstellen.">
          <Switch checked={draft.usersCanCreateApiTokens} onChange={(v) => set('usersCanCreateApiTokens', v)} />
        </SettingRow>
      </Card>

      <Card icon={<Plug />} title="Konten" description="Welche Anbieter Benutzer verbinden dürfen und wie viele Konten erlaubt sind.">
        <SettingRow label="Maximale Konten pro Benutzer" hint="0 = unbegrenzt">
          <Input type="number" min={0} max={1000} value={draft.maxAccountsPerUser} onChange={(e) => set('maxAccountsPerUser', Math.max(0, Number(e.target.value) || 0))} />
        </SettingRow>
        <div className="pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Erlaubte Kontotypen</div>
            {allowAll ? <Badge tone="success">Alle erlaubt</Badge> : <Badge tone="warning">{draft.allowedAccountTypes.length} erlaubt</Badge>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(types ?? []).map((t) => {
              const on = allowAll || draft.allowedAccountTypes.includes(t.type);
              return (
                <div key={t.type} className={cn('rounded-xl border p-3 transition-colors', on ? 'border-primary/30 bg-primary-soft/40' : 'border-border')}>
                  <Checkbox checked={on} onChange={(v) => toggleType(t.type, v)} label={<span className="font-medium">{t.label}</span>} />
                  <div className="ml-7 mt-1 flex flex-wrap gap-1">
                    {t.capabilities.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                    {t.auth === 'oauth' && !t.configured && <Badge tone="warning">nicht konfiguriert</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <KeyRound className="h-3 w-3" /> Bereits verbundene Konten bleiben erhalten; die Einschränkung gilt für neue Verbindungen.
          </p>
        </div>
      </Card>
    </div>
  );
}
