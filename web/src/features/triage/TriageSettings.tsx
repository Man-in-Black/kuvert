import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Inbox, Square } from 'lucide-react';
import { DEFAULT_TRIAGE_CATEGORIES, getTriageSettings, type AiStatus, type TriageSettings as Settings } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAccountsWith, useSettings, useUpdateSettings } from '@/lib/queries';
import { Button, Checkbox, Field, Select, Switch, Textarea } from '@/components/ui';
import { groupModels, modelLabel } from '@/features/ai/models';
import { fetchTriageStatus, stopTriage, triageInbox, triageKeys } from './api';
import { FailedTriage } from './FailedTriage';
import { clearTriagePending } from '@/features/mail/triage-pending';

/** Einstellungsseite "KI-Triage" */
export function TriageSettings() {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const triage = getTriageSettings(settings);
  const accounts = useAccountsWith('mail');
  const { data: ai } = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api<AiStatus>('/ai/status'), staleTime: 60_000 });
  const { data: status } = useQuery({
    queryKey: triageKeys.status,
    queryFn: fetchTriageStatus,
    // Solange eingeordnet wird, Fortschritt (und neue Fehlschläge) nachführen
    refetchInterval: (q) => ((q.state.data?.queued ?? 0) > 0 ? 3000 : false),
  });

  const save = (patch: Partial<Settings>, message = 'Gespeichert') =>
    update.mutate(
      { modules: { ...(settings.modules ?? {}), triage: { ...triage, ...patch } } },
      { onSuccess: () => message && toast.success(message), onError: (e) => toast.error(errorMessage(e)) },
    );

  const runInbox = async () => {
    try {
      const r = await triageInbox(30);
      toast.success(r.queued ? `${r.queued} Nachrichten werden eingeordnet` : 'Die neuesten Nachrichten sind bereits eingeordnet');
      void qc.invalidateQueries({ queryKey: triageKeys.status });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const stop = async () => {
    try {
      const r = await stopTriage();
      clearTriagePending();
      toast.success(r.stopped ? `${r.stopped} Einordnungen abgebrochen` : 'Es lief keine Einordnung');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: triageKeys.status });
    }
  };

  const stats = status?.stats;
  const retryIn = status?.retryAt ? Math.max(0, Math.round((Date.parse(status.retryAt) - Date.now()) / 1000)) : null;
  const models = ai?.modelDetails ?? (ai?.models ?? []).map((name) => ({ name }));

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">KI-Triage</h2>
        <p className="text-sm text-muted">
          Neue Mails im Posteingang werden automatisch nach Priorität (hoch, normal, niedrig) und Kategorie eingeordnet. Die Einordnung erscheint in der
          Nachrichtenliste; mit dem Filter <strong>Wichtig</strong> siehst du nur Mails mit hoher Priorität. Korrigieren lässt sie sich in der Leseansicht über
          das Etikett-Symbol.
        </p>
      </div>

      {status?.backend === 'openai' && (
        <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Als KI-Server ist eine OpenAI-kompatible API eingerichtet{ai?.baseUrl ? ` (${ai.baseUrl})` : ''}. Absender, Betreff und Anfang jeder neuen Mail werden
            dorthin geschickt – bei einem externen Anbieter verlassen die Inhalte also den eigenen Server.
          </span>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4">
        <Switch
          checked={triage.enabled}
          onChange={(v) => {
            save({ enabled: v }, v ? '' : 'Automatische Einordnung ausgeschaltet');
            // Beim Einschalten die neuesten vorhandenen Mails gleich mit einordnen
            if (v && status?.available !== false) {
              void triageInbox(30)
                .then((r) =>
                  toast.success(
                    r.queued
                      ? `Automatische Einordnung eingeschaltet – die ${r.queued} neuesten Mails werden jetzt eingeordnet`
                      : 'Automatische Einordnung eingeschaltet',
                  ),
                )
                .catch((err) => toast.error(errorMessage(err)))
                .finally(() => void qc.invalidateQueries({ queryKey: triageKeys.status }));
            }
          }}
          label="Neue Mails automatisch einordnen"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted">
          {stats && (
            <span>
              {stats.total.toLocaleString('de-DE')} eingeordnet · {stats.byPriority.high ?? 0} hoch · {stats.byPriority.normal ?? 0} normal · {stats.byPriority.low ?? 0} niedrig
            </span>
          )}
          {!!status?.queued && <span className="text-primary">{status.queued} in Arbeit …</span>}
          <span className="flex-1" />
          {!!status?.queued && (
            <Button size="sm" variant="outline" icon={<Square className="h-3.5 w-3.5 fill-current" />} onClick={() => void stop()} title="Laufende und wartende Einordnungen abbrechen und das Modell entladen">
              Stoppen
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<Inbox className="h-3.5 w-3.5" />} onClick={() => void runInbox()} disabled={status?.available === false}>
            Posteingang jetzt einordnen
          </Button>
        </div>
        {!!status?.queued && status.lastError && (
          <div className="mt-3 flex gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              KI-Server-Fehler: {status.lastError}
              {retryIn !== null && ` – neuer Versuch in ${retryIn} s`}
              {status.attempt && status.maxAttempts ? ` (Versuch ${status.attempt} von ${status.maxAttempts})` : ''}
            </span>
          </div>
        )}
        <FailedTriage count={status?.failed ?? 0} disabled={status?.available === false} />
        <p className="mt-2 text-xs text-muted">Die Automatik ordnet nur Mails ein, die neu eingehen. Ältere Mails: „Posteingang jetzt einordnen“ (die 30 neuesten je Konto ohne Einordnung) oder in der Nachrichtenliste über das Sortier-Symbol bzw. bei Mehrfachauswahl „Mit KI einordnen“. Das Modell wird nach jeder Mail entladen und belegt danach keinen Speicher; lässt es sich nicht laden, versucht Kuvert es bis zu {status?.maxAttempts ?? 4}-mal mit wachsender Pause. Was danach noch scheitert, landet in der Liste der fehlgeschlagenen Einordnungen und lässt sich dort wiederholen.</p>
      </div>

      <Field label="Modell" hint="Ein kleines, schnelles Modell genügt meist. Leer = Modell des KI-Assistenten.">
        <Select value={triage.model ?? ''} onChange={(e) => save({ model: e.target.value || null })}>
          <option value="">Wie KI-Assistent{settings.ai.model || ai?.model ? ` (${settings.ai.model || ai?.model})` : ''}</option>
          {groupModels(models).map((g) =>
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
          {triage.model && !ai?.models.includes(triage.model) && <option value={triage.model}>{triage.model} (nicht verfügbar)</option>}
        </Select>
      </Field>

      <Field
        label="Kategorien"
        hint={
          <>
            Eine pro Zeile. Passt keine, ordnet die KI unter „Sonstiges“ ein.{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => save({ categories: DEFAULT_TRIAGE_CATEGORIES })}>
              Standard wiederherstellen
            </button>
          </>
        }
      >
        <Textarea
          key={triage.categories.join('\n')}
          rows={8}
          defaultValue={triage.categories.join('\n')}
          onBlur={(e) => {
            const list = [...new Set(e.target.value.split('\n').map((l) => l.trim().slice(0, 60)).filter(Boolean))];
            if (list.join('\n') !== triage.categories.join('\n')) save({ categories: list.length ? list : DEFAULT_TRIAGE_CATEGORIES });
          }}
        />
      </Field>

      <Field label="Eigene Regeln" hint="Werden dem Modell zusätzlich mitgegeben und haben Vorrang.">
        <Textarea
          key={triage.instructions}
          rows={4}
          maxLength={2000}
          placeholder={'z. B.\nMails von @meinkunde.de sind immer hoch.\nRechnungen von Lieferanten sind normal, nicht hoch.'}
          defaultValue={triage.instructions}
          onBlur={(e) => e.target.value.trim() !== triage.instructions.trim() && save({ instructions: e.target.value.trim() })}
        />
      </Field>

      {accounts.length > 1 && (
        <Field label="Konten" hint="Für abgewählte Konten werden neue Mails nicht automatisch eingeordnet.">
          <div className="space-y-2">
            {accounts.map((a) => (
              <Checkbox
                key={a.id}
                className="flex"
                checked={!triage.excludedAccounts.includes(a.id)}
                onChange={(v) =>
                  save({ excludedAccounts: v ? triage.excludedAccounts.filter((id) => id !== a.id) : [...triage.excludedAccounts, a.id] })
                }
                label={
                  <span>
                    {a.name} <span className="text-muted">({a.email})</span>
                  </span>
                }
              />
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}
