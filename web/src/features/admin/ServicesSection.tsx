/**
 * Admin → Dienste & Anmeldung: OAuth-Apps (Microsoft 365, Google) und KI-Backend.
 * Werte aus der .env sind Vorgaben; hier gesetzte Werte überschreiben sie sofort.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, ExternalLink, KeyRound, Link2, RotateCcw, RotateCw, Search, Sparkles, Wifi } from 'lucide-react';
import type { AiModelInfo, SearchAdminStatus, ServiceFieldState, ServiceKey, ServiceSettingsPatch, ServiceSettingsView } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk, useFeature } from '@/lib/queries';
import { cn, formatSize } from '@/lib/utils';
import { groupModels, modelLabel } from '@/features/ai/models';
import { Badge, Button, Card, CodeBox, Input, PageHeader, Select, Skeleton, Switch, Tooltip, useConfirm } from '@/components/ui';
import { HelpBox, SettingRow } from '@/features/settings/ui';
import { MsAutoSetup } from './MsProvision';

const servicesKey = ['admin', 'services'] as const;

type Value = string | number | boolean;
type Draft = { [K in ServiceKey]: Record<string, Value> };

const MS_PERMISSIONS =
  'openid profile email offline_access User.Read User.ReadBasic.All People.Read Mail.ReadWrite Mail.Send Mail.ReadWrite.Shared Mail.Send.Shared MailboxSettings.ReadWrite Calendars.ReadWrite Calendars.ReadWrite.Shared Contacts.ReadWrite Tasks.ReadWrite Files.ReadWrite.All OnlineMeetings.ReadWrite';
const GOOGLE_APIS = 'Gmail API, Google Calendar API, People API, Google Tasks API, Google Drive API, Google Meet REST API';

/** Ausgangszustand des Formulars: aktuelle Werte, Geheimnisse leer (= unverändert) */
function initialDraft(view: ServiceSettingsView): Draft {
  const pick = (section: Record<string, ServiceFieldState>) =>
    Object.fromEntries(Object.entries(section).map(([k, f]) => [k, f.secret ? '' : (f.value ?? '')])) as Record<string, Value>;
  return { microsoft: pick(view.microsoft), google: pick(view.google), ai: pick(view.ai), search: pick(view.search) };
}

export function ServicesSection() {
  const qc = useQueryClient();
  const { data: view, isLoading } = useQuery({ queryKey: servicesKey, queryFn: () => api<ServiceSettingsView>('/admin/services') });
  const microsoftModule = useFeature('microsoft');
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Felder, die auf die .env-Vorgabe zurückgesetzt werden sollen */
  const [resets, setResets] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (view) {
      setDraft(initialDraft(view));
      setResets(new Set());
    }
  }, [view]);

  const patch = useMemo<ServiceSettingsPatch>(() => {
    if (!view || !draft) return {};
    const out: ServiceSettingsPatch = {};
    for (const key of ['microsoft', 'google', 'ai', 'search'] as ServiceKey[]) {
      const section = view[key] as Record<string, ServiceFieldState>;
      const changes: Record<string, Value | null> = {};
      for (const [field, state] of Object.entries(section)) {
        const v = draft[key][field];
        if (resets.has(`${key}.${field}`)) changes[field] = null;
        else if (state.secret) {
          if (typeof v === 'string' && v.trim()) changes[field] = v;
        } else if (v !== (state.value ?? '')) changes[field] = v;
      }
      if (Object.keys(changes).length) out[key] = changes;
    }
    return out;
  }, [view, draft, resets]);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api<ServiceSettingsView>('/admin/services', { method: 'PUT', body: patch }),
    onSuccess: (res) => {
      qc.setQueryData(servicesKey, res);
      // Kontotypen ("konfiguriert") und Feature-Flags (KI) neu laden
      qc.invalidateQueries({ queryKey: qk.app });
      qc.invalidateQueries({ queryKey: ['admin', 'account-types'] });
      toast.success('Einstellungen gespeichert – sofort wirksam');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading || !view || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const set = (key: ServiceKey, field: string, value: Value) => {
    setDraft((d) => (d ? { ...d, [key]: { ...d[key], [field]: value } } : d));
    setResets((r) => {
      const n = new Set(r);
      n.delete(`${key}.${field}`);
      return n;
    });
  };
  const reset = (key: ServiceKey, field: string) => {
    setResets((r) => new Set(r).add(`${key}.${field}`));
    const state = (view[key] as Record<string, ServiceFieldState>)[field]!;
    setDraft((d) => (d ? { ...d, [key]: { ...d[key], [field]: state.secret ? '' : (state.envValue ?? '') } } : d));
  };

  const field = (key: ServiceKey, name: string) => {
    const state = (view[key] as Record<string, ServiceFieldState>)[name]!;
    return { state, value: draft[key][name], resetting: resets.has(`${key}.${name}`), onChange: (v: Value) => set(key, name, v), onReset: () => reset(key, name) };
  };

  const msReady = !!(draft.microsoft.clientId || view.microsoft.clientId.isSet) && !resets.has('microsoft.clientId');
  const googleReady = !!(draft.google.clientId || view.google.clientId.isSet) && !resets.has('google.clientId');
  const insecureUrl = view.publicUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(view.publicUrl);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<KeyRound />}
        title="Dienste & Anmeldung"
        description="Zugangsdaten für Microsoft 365, Google und den KI-Assistenten. Werte aus der .env gelten als Vorgabe – hier gesetzte Werte überschreiben sie und wirken sofort, ohne Neustart."
        actions={
          <div className="flex gap-2">
            {dirty && (
              <Button
                onClick={() => {
                  setDraft(initialDraft(view));
                  setResets(new Set());
                }}
              >
                Verwerfen
              </Button>
            )}
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
          </div>
        }
      />

      <Card icon={<Link2 />} title="Weiterleitungs-URI (Redirect URI)" description="Diese Adresse in der Microsoft- und Google-App-Registrierung als Redirect-URI (Typ „Web“) eintragen.">
        <CodeBox value={view.redirectUri} />
        {insecureUrl && (
          <div className="mt-3">
            <HelpBox tone="warning">
              PUBLIC_URL verwendet http://. Microsoft und Google akzeptieren Redirect-URIs ohne HTTPS nur für localhost – für den Produktivbetrieb bitte HTTPS
              (Reverse Proxy) einrichten und PUBLIC_URL anpassen.
            </HelpBox>
          </div>
        )}
      </Card>

      {/* ───────────── Microsoft 365 ───────────── */}
      <Card
        icon={<MsLogo />}
        title="Microsoft 365"
        description="Entra-ID-App-Registrierung für Mail, Kalender, Kontakte, To Do, OneDrive und Teams."
        actions={msReady ? <Badge tone="success">Bereit</Badge> : <Badge tone="warning">Nicht eingerichtet</Badge>}
      >
        {microsoftModule && <MsAutoSetup servicesKey={servicesKey} />}
        <FieldRow label="Anwendungs-ID (Client-ID)" {...field('microsoft', 'clientId')} placeholder="00000000-0000-0000-0000-000000000000" />
        <FieldRow label="Geheimer Clientschlüssel" {...field('microsoft', 'clientSecret')} />
        <FieldRow
          label="Mandant (Tenant)"
          hint="common = alle Organisationen + private Konten, organizations = nur Firmenkonten, oder eine Tenant-ID für eine einzelne Organisation."
          {...field('microsoft', 'tenant')}
          placeholder="common"
        />
        <Guide title="Oder: App manuell in Microsoft Entra einrichten">
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>
              <a className="text-primary hover:underline" href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">
                Entra ID → App-Registrierungen <ExternalLink className="inline h-3 w-3" />
              </a>{' '}
              → „Neue Registrierung“, Plattform <b>Web</b>, Umleitungs-URI siehe oben.
            </li>
            <li>„Zertifikate & Geheimnisse“ → neuen geheimen Clientschlüssel erstellen und hier eintragen (den <i>Wert</i>, nicht die ID).</li>
            <li>„API-Berechtigungen“ → Microsoft Graph → Delegiert → folgende Berechtigungen hinzufügen und ggf. Administratorzustimmung erteilen:</li>
          </ol>
          <CodeBox value={MS_PERMISSIONS} multiline className="mt-2" />
        </Guide>
      </Card>

      {/* ───────────── Google ───────────── */}
      <Card
        icon={<GoogleLogo />}
        title="Google Workspace / Gmail"
        description="OAuth-Client für Gmail, Kalender, Kontakte, Tasks, Drive und Meet."
        actions={googleReady ? <Badge tone="success">Bereit</Badge> : <Badge tone="warning">Nicht eingerichtet</Badge>}
      >
        <FieldRow label="Client-ID" {...field('google', 'clientId')} placeholder="…apps.googleusercontent.com" />
        <FieldRow label="Clientschlüssel" {...field('google', 'clientSecret')} />
        <Guide title="So richtest du den OAuth-Client in der Google Cloud ein">
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>
              <a className="text-primary hover:underline" href="https://console.cloud.google.com/apis/library" target="_blank" rel="noreferrer">
                APIs aktivieren <ExternalLink className="inline h-3 w-3" />
              </a>
              : {GOOGLE_APIS}.
            </li>
            <li>OAuth-Zustimmungsbildschirm konfigurieren (intern für Workspace, sonst Testnutzer eintragen).</li>
            <li>
              <a className="text-primary hover:underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Anmeldedaten <ExternalLink className="inline h-3 w-3" />
              </a>{' '}
              → OAuth-Client-ID → Typ „Webanwendung“, autorisierte Weiterleitungs-URI siehe oben.
            </li>
          </ol>
        </Guide>
      </Card>

      {/* ───────────── KI ───────────── */}
      <AiCard view={view} draft={draft.ai} field={(n) => field('ai', n)} />

      {/* ───────────── Suchindex ───────────── */}
      <SearchCard draft={draft.search} field={(n) => field('search', n)} saved={view.search} />
    </div>
  );
}

/* ═════════════════════════════ KI-Karte mit Modell-Auswahl ═════════════════════════════ */

interface ModelsResult {
  ok: boolean;
  models: string[];
  modelDetails?: AiModelInfo[];
  error?: string;
}

function AiCard({
  view,
  draft,
  field,
}: {
  view: ServiceSettingsView;
  draft: Record<string, Value>;
  field: (name: string) => FieldProps;
}) {
  const enabled = field('enabled');
  const backend = field('backend');
  const temperature = field('temperature');
  const isOpenAi = draft.backend === 'openai';

  return (
    <Card
      icon={<Bot />}
      title="KI-Assistent"
      description="Lokales LLM über Ollama oder jede OpenAI-kompatible API (LM Studio, vLLM, LocalAI …)."
      actions={draft.enabled ? <Badge tone="success">Aktiv</Badge> : <Badge>Deaktiviert</Badge>}
    >
      <SettingRow label={<Label text="KI-Assistent aktivieren" {...enabled} />} hint="Deaktiviert blendet die KI-Funktionen für alle Benutzer aus.">
        <Switch checked={!!draft.enabled} onChange={(v) => enabled.onChange(v)} />
      </SettingRow>
      <SettingRow label={<Label text="Backend" {...backend} />}>
        <Select className="w-full sm:w-56" value={String(draft.backend)} onChange={(e) => backend.onChange(e.target.value)}>
          <option value="ollama">Ollama</option>
          <option value="openai">OpenAI-kompatibel</option>
        </Select>
      </SettingRow>
      <FieldRow label="Server-URL" {...field('baseUrl')} placeholder={isOpenAi ? 'http://lmstudio:1234/v1' : 'http://ollama:11434'} />
      {isOpenAi || view.ai.apiKey.isSet ? <FieldRow label="API-Schlüssel" hint="Nur bei OpenAI-kompatiblen Diensten nötig." {...field('apiKey')} /> : null}
      <ModelPicker draft={draft} model={field('model')} />
      <SettingRow label={<Label text="Kreativität (Temperatur)" {...temperature} />} hint="0 = sachlich und wiederholbar, 1 = freier formuliert.">
        <div className="flex w-full items-center gap-3 sm:w-56">
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.1}
            value={Number(draft.temperature ?? 0.4)}
            onChange={(e) => temperature.onChange(Number(e.target.value))}
            className="flex-1 accent-[var(--k-primary)]"
          />
          <span className="w-8 text-right text-sm tabular-nums">{Number(draft.temperature ?? 0.4).toFixed(1)}</span>
        </div>
      </SettingRow>
    </Card>
  );
}

const CUSTOM = '__custom__';

/**
 * Dropdown der auf dem KI-Server installierten Modelle. Lädt automatisch (auch mit noch
 * nicht gespeicherter URL) und erlaubt bei Bedarf die freie Eingabe eines Modellnamens.
 */
function ModelPicker({ draft, model }: { draft: Record<string, Value>; model: FieldProps }) {
  const baseUrl = String(draft.baseUrl ?? '');
  const apiKey = String(draft.apiKey ?? '');
  const backend = String(draft.backend ?? 'ollama');
  const [debouncedUrl, setDebouncedUrl] = useState(baseUrl);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(baseUrl), 600);
    return () => clearTimeout(t);
  }, [baseUrl]);

  const q = useQuery({
    queryKey: ['admin', 'ai-models', backend, debouncedUrl, apiKey.length > 0],
    queryFn: () =>
      api<ModelsResult>('/admin/services/ai/test', {
        method: 'POST',
        body: { backend, baseUrl: debouncedUrl || undefined, apiKey: apiKey || undefined },
      }),
    staleTime: 30_000,
    retry: false,
  });

  const details: AiModelInfo[] = q.data?.modelDetails ?? (q.data?.models ?? []).map((name) => ({ name }));
  const current = String(model.value ?? '');
  const known = details.some((m) => m.name === current);
  const [custom, setCustom] = useState(false);
  // Freitext anzeigen, wenn das gespeicherte Modell nicht auf dem Server liegt und die Liste leer ist
  const showInput = custom || (q.isSuccess && details.length === 0 && !!q.data?.ok);
  const reachable = q.data?.ok;

  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="mb-1.5 text-sm font-medium">
        <Label text="Standardmodell" state={model.state} resetting={model.resetting} onReset={model.onReset} />
      </div>
      <div className="flex max-w-xl items-center gap-2">
        {showInput ? (
          <Input
            className="flex-1"
            value={current}
            placeholder="z. B. llama3.1:8b"
            spellCheck={false}
            onChange={(e) => model.onChange(e.target.value)}
            autoFocus={custom}
          />
        ) : (
          <Select
            className="flex-1"
            value={current}
            disabled={q.isLoading}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustom(true);
              else model.onChange(e.target.value);
            }}
          >
            {q.isLoading && <option value={current}>Modelle werden geladen …</option>}
            {!q.isLoading && !current && <option value="">— Modell wählen —</option>}
            {!q.isLoading && current && !known && (
              <option value={current}>
                {current} {reachable ? '(nicht installiert)' : ''}
              </option>
            )}
            {groupModels(details).map((g) =>
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
            {!q.isLoading && <option value={CUSTOM}>Anderes Modell eingeben …</option>}
          </Select>
        )}
        {showInput && details.length > 0 && (
          <Button size="sm" onClick={() => setCustom(false)}>
            Liste
          </Button>
        )}
        <Tooltip content="Modellliste neu laden">
          <Button size="icon" variant="outline" aria-label="Modellliste neu laden" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RotateCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} />
          </Button>
        </Tooltip>
      </div>
      <div className="mt-1.5 max-w-xl text-xs">
        {q.isLoading ? (
          <span className="text-muted">Verbinde mit {debouncedUrl || 'dem KI-Server'} …</span>
        ) : reachable ? (
          details.length ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <Sparkles className="h-3.5 w-3.5" /> Erreichbar – {details.length} Modell{details.length === 1 ? '' : 'e'} installiert. Benutzer können in
              ihren Einstellungen ein anderes wählen.
            </span>
          ) : (
            <span className="text-warning">
              Erreichbar, aber keine Modelle installiert.{' '}
              {backend === 'ollama' && (
                <>
                  Modell laden z. B. mit <code className="rounded bg-surface-2 px-1">ollama pull llama3.1:8b</code>
                </>
              )}
            </span>
          )
        ) : (
          <span className="text-danger">Nicht erreichbar: {q.data?.error ?? (q.error ? errorMessage(q.error) : 'unbekannter Fehler')}</span>
        )}
      </div>
    </div>
  );
}

/* ═════════════════════════════ Suchindex (Meilisearch) ═════════════════════════════ */

function SearchCard({ draft, field, saved }: { draft: Record<string, Value>; field: (name: string) => FieldProps; saved: ServiceSettingsView['search'] }) {
  const qc = useQueryClient();
  const confirmRebuild = useConfirm();
  const configured = !!saved.url.value && saved.enabled.value !== false;
  const status = useQuery({
    queryKey: ['admin', 'search-status'],
    queryFn: () => api<SearchAdminStatus>('/search/admin/status'),
    enabled: configured,
    refetchInterval: (q) => (q.state.data?.isIndexing ? 3000 : 15000),
  });
  const [test, setTest] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const runTest = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; version?: string; error?: string }>('/search/admin/test', {
        method: 'POST',
        body: { url: draft.url ? String(draft.url) : undefined, apiKey: draft.apiKey ? String(draft.apiKey) : undefined },
      }),
    onSuccess: setTest,
    onError: (err) => setTest({ ok: false, error: errorMessage(err) }),
  });
  const rebuild = useMutation({
    mutationFn: () => api('/search/admin/rebuild', { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success('Index wird neu aufgebaut');
      qc.invalidateQueries({ queryKey: ['admin', 'search-status'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const enabled = field('enabled');
  const indexBodies = field('indexBodies');
  const includeTrash = field('includeTrash');
  const maxAge = field('maxAgeDays');
  const interval = field('syncIntervalMin');
  const s = status.data;

  return (
    <Card
      icon={<Search />}
      title="Suchindex (Meilisearch)"
      description="Volltext-Index über alle Konten: Suche in Millisekunden, tippfehlertolerant, mit Suchbefehlen wie from:, has:attachment, is:unread. Ohne Index wird live beim jeweiligen Anbieter gesucht."
      actions={!configured ? <Badge>Nicht eingerichtet</Badge> : s?.reachable ? <Badge tone="success">Verbunden</Badge> : <Badge tone="warning">Nicht erreichbar</Badge>}
    >
      {configured && s && (
        <div className="mb-2 grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface-2/50 p-3 text-sm sm:grid-cols-4">
          <Stat label="Nachrichten im Index" value={s.documents.toLocaleString('de-DE')} />
          <Stat label="Konten fertig" value={`${s.accounts.ready} / ${s.accounts.total}`} />
          <Stat label="Speicher" value={s.sizeBytes ? formatSize(s.sizeBytes) : '–'} />
          <Stat label="Status" value={s.error ? 'Fehler' : s.isIndexing ? 'Indiziert …' : 'Aktuell'} tone={s.error ? 'danger' : s.isIndexing ? 'warning' : 'success'} />
          {s.error && <div className="col-span-full text-xs text-danger">{s.error}</div>}
        </div>
      )}
      <SettingRow label={<Label text="Suchindex verwenden" {...enabled} />} hint="Aus = Suche wieder live beim Anbieter (Index bleibt erhalten).">
        <Switch checked={!!draft.enabled} onChange={(v) => enabled.onChange(v)} />
      </SettingRow>
      <FieldRow label="Meilisearch-URL" {...field('url')} placeholder="http://meilisearch:7700" hint="Im Docker-Setup: http://meilisearch:7700" />
      <FieldRow label="Master-/API-Key" {...field('apiKey')} hint="Der MEILI_MASTER_KEY der Meilisearch-Instanz." />
      <div className="flex flex-wrap items-center gap-3 py-3">
        <Button icon={<Wifi className="h-4 w-4" />} loading={runTest.isPending} onClick={() => runTest.mutate()}>
          Verbindung testen
        </Button>
        {test && (test.ok ? <span className="text-sm text-success">Erreichbar – Meilisearch {test.version}</span> : <span className="text-sm text-danger">{test.error}</span>)}
      </div>
      <SettingRow label={<Label text="Nachrichtentext indizieren" {...indexBodies} />} hint="Aus = nur Betreff, Absender, Empfänger, Vorschau und Anhangnamen (weniger Speicher).">
        <Switch checked={!!draft.indexBodies} onChange={(v) => indexBodies.onChange(v)} />
      </SettingRow>
      <SettingRow label={<Label text="Papierkorb und Spam einbeziehen" {...includeTrash} />}>
        <Switch checked={!!draft.includeTrash} onChange={(v) => includeTrash.onChange(v)} />
      </SettingRow>
      <SettingRow label={<Label text="Zeitraum" {...maxAge} />} hint="Ältere Nachrichten werden weiterhin live beim Anbieter gefunden.">
        <Select className="w-full sm:w-56" value={String(draft.maxAgeDays ?? 0)} onChange={(e) => maxAge.onChange(Number(e.target.value))}>
          <option value="0">Alle Nachrichten</option>
          <option value="90">Letzte 3 Monate</option>
          <option value="365">Letztes Jahr</option>
          <option value="730">Letzte 2 Jahre</option>
          <option value="1825">Letzte 5 Jahre</option>
        </Select>
      </SettingRow>
      <SettingRow label={<Label text="Abgleich-Intervall" {...interval} />} hint="Neue Mails im Posteingang werden zusätzlich sofort per Push übernommen.">
        <Select className="w-full sm:w-56" value={String(draft.syncIntervalMin ?? 5)} onChange={(e) => interval.onChange(Number(e.target.value))}>
          {[1, 2, 5, 10, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              alle {m} Min.
            </option>
          ))}
        </Select>
      </SettingRow>
      {configured && (
        <div className="flex flex-wrap items-center gap-3 pt-3">
          <Button
            variant="outline"
            icon={<RotateCcw className="h-4 w-4" />}
            loading={rebuild.isPending}
            onClick={async () => {
              if (await confirmRebuild.confirm('Den gesamten Suchindex löschen und neu aufbauen? Die Suche nutzt währenddessen die Live-Suche der Anbieter.', { danger: true })) rebuild.mutate();
            }}
          >
            Index neu aufbauen
          </Button>
          <span className="text-xs text-muted">Nötig z. B. nach Wechsel der Meilisearch-Instanz.</span>
        </div>
      )}
      {confirmRebuild.dialog}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-subtle">{label}</div>
      <div className={cn('mt-0.5 font-semibold tabular-nums', tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>{value}</div>
    </div>
  );
}

/* ═════════════════════════════ Bausteine ═════════════════════════════ */

interface FieldProps {
  state: ServiceFieldState;
  value: Value;
  resetting: boolean;
  onChange: (v: Value) => void;
  onReset: () => void;
}

/** Herkunft des Werts + Zurücksetzen auf .env */
function SourceInfo({ state, resetting, onReset }: Pick<FieldProps, 'state' | 'resetting' | 'onReset'>) {
  if (resetting) return <Badge tone="warning">wird zurückgesetzt</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={state.source === 'env' || state.envSet ? `Umgebungsvariable ${state.envVar}` : `Kann auch per ${state.envVar} gesetzt werden`}>
        {state.source === 'admin' ? (
          <Badge tone="primary">Admin</Badge>
        ) : state.source === 'env' ? (
          <Badge tone="info">.env</Badge>
        ) : (
          <Badge>Standard</Badge>
        )}
      </Tooltip>
      {state.source === 'admin' && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
          title={state.envSet ? 'Wieder den Wert aus der .env verwenden' : 'Eintrag entfernen'}
        >
          <RotateCcw className="h-3 w-3" />
          {state.envSet ? 'auf .env' : 'entfernen'}
        </button>
      )}
    </span>
  );
}

function Label({ text, state, resetting, onReset }: { text: string } & Pick<FieldProps, 'state' | 'resetting' | 'onReset'>) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {text}
      <SourceInfo state={state} resetting={resetting} onReset={onReset} />
    </span>
  );
}

function FieldRow({ label, hint, placeholder, state, value, resetting, onChange, onReset }: FieldProps & { label: string; hint?: ReactNode; placeholder?: string }) {
  const secretPlaceholder = state.isSet && !resetting ? '•••••••• hinterlegt – leer lassen für unverändert' : 'Noch nicht hinterlegt';
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="mb-1.5 text-sm font-medium">
        <Label text={label} state={state} resetting={resetting} onReset={onReset} />
      </div>
      <Input
        className="max-w-xl"
        type={state.secret ? 'password' : 'text'}
        autoComplete={state.secret ? 'new-password' : 'off'}
        spellCheck={false}
        value={String(value ?? '')}
        placeholder={state.secret ? secretPlaceholder : placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1.5 max-w-xl text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Guide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group mt-3 rounded-xl border border-border bg-surface-2/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
      <summary className="cursor-pointer select-none font-medium text-fg marker:text-muted">{title}</summary>
      <div className="mt-2.5">{children}</div>
    </details>
  );
}

function MsLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5">
      <rect x="2" y="2" width="9.5" height="9.5" fill="#f25022" />
      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7fba00" />
      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00a4ef" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#ffb900" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5">
      <path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z" />
      <path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.3v2.8A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.9 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.3a11 11 0 0 0 0 9.9l3.6-2.8z" />
      <path fill="#EA4335" d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.1l3.6 2.8C6.8 7.3 9.2 5.4 12 5.4z" />
    </svg>
  );
}
