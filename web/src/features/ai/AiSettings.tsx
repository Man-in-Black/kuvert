import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import type { AiStatus } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useSettings, useUpdateSettings } from '@/lib/queries';
import { Button, Field, Input, Select, Spinner } from '@/components/ui';
import { AI_LANGUAGES } from './InstructionDialog';
import { groupModels, modelLabel } from './models';

/** Einstellungsseite "KI-Assistent" */
export function AiSettings() {
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const { data: status, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api<AiStatus>('/ai/status'),
    staleTime: 60_000,
  });

  const save = (patch: Partial<typeof settings.ai>) =>
    update.mutate({ ai: { ...settings.ai, ...patch } }, { onSuccess: () => toast.success('Gespeichert'), onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">KI-Assistent</h2>
        <p className="text-sm text-muted">
          Formulieren, Umschreiben, Übersetzen und Zusammenfassen mit einem lokalen Sprachmodell (Ollama). Inhalte verlassen den eigenen Server nicht.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">Verbindung</div>
          <Button size="sm" variant="ghost" icon={<RefreshCw className={isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />} onClick={() => void refetch()}>
            Prüfen
          </Button>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <div className="text-sm text-danger">{errorMessage(error)}</div>
        ) : status ? (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              {status.reachable ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
              {!status.enabled ? 'KI ist serverseitig deaktiviert' : status.reachable ? 'Erreichbar' : 'Nicht erreichbar'}
            </div>
            {status.baseUrl && <div className="text-muted">Server: {status.baseUrl}</div>}
            {status.model && <div className="text-muted">Standardmodell: {status.model}</div>}
            {status.error && <div className="text-danger">{status.error}</div>}
          </div>
        ) : null}
      </div>

      <Field label="Modell" hint="Server-Standard = vom Administrator festgelegtes Modell">
        <Select value={settings.ai.model ?? ''} onChange={(e) => save({ model: e.target.value || null })}>
          <option value="">Server-Standard{status?.model ? ` (${status.model})` : ''}</option>
          {groupModels(status?.modelDetails ?? (status?.models ?? []).map((name) => ({ name }))).map((g) =>
            g.family ? (
              <optgroup key={g.family} label={g.family}>
                {g.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {modelLabel(m)}
                  </option>
                ))}
              </optgroup>
            ) : (
              g.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {modelLabel(m)}
                </option>
              ))
            ),
          )}
          {settings.ai.model && !status?.models.includes(settings.ai.model) && (
            <option value={settings.ai.model}>{settings.ai.model} (nicht mehr verfügbar)</option>
          )}
        </Select>
      </Field>

      <Field label="KI-Chats aufbewahren" hint="Gespeicherte Chats (inkl. darin zitierter Mailinhalte) werden so lange nach der letzten Nachricht gelöscht.">
        <Select value={String(settings.ai.chatRetentionDays ?? 90)} onChange={(e) => save({ chatRetentionDays: Number(e.target.value) })}>
          <option value="7">7 Tage</option>
          <option value="30">30 Tage</option>
          <option value="90">90 Tage</option>
          <option value="365">1 Jahr</option>
          <option value="0">Unbegrenzt</option>
        </Select>
      </Field>

      <Field label="Standardsprache für Entwürfe und Zusammenfassungen">
        <Input
          list="kuvert-ai-langs-settings"
          defaultValue={settings.ai.defaultLanguage}
          onBlur={(e) => e.target.value.trim() && e.target.value !== settings.ai.defaultLanguage && save({ defaultLanguage: e.target.value.trim() })}
        />
        <datalist id="kuvert-ai-langs-settings">
          {AI_LANGUAGES.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </Field>
    </div>
  );
}
