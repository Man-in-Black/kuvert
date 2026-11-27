/** API-Zugriffe, Hooks und Formatierung der Zeiterfassung. */
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  TtEntry,
  TtEntryInput,
  TtEntryList,
  TtImportStatus,
  TtKimaiConnection,
  TtMasterData,
  TtRecent,
  TtReport,
  TtEntryMetaInput,
  TtSettings,
  TtStartInput,
} from '@kuvert/shared';
import { api, apiUrl, errorMessage } from '@/lib/api';

export const ttk = {
  all: ['timetrack'] as const,
  master: ['timetrack', 'master'] as const,
  active: ['timetrack', 'active'] as const,
  entries: (f: EntryFilter) => ['timetrack', 'entries', f] as const,
  recent: ['timetrack', 'recent'] as const,
  tags: ['timetrack', 'tags'] as const,
  report: (from: string, to: string) => ['timetrack', 'report', from, to] as const,
  kimai: ['timetrack', 'kimai'] as const,
  settings: ['timetrack', 'settings'] as const,
};

export const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Europe/Berlin';
  }
})();

export interface EntryFilter {
  from?: string;
  to?: string;
  projectId?: string;
  customerId?: string;
  q?: string;
  limit?: number;
}

export function useMasterData() {
  return useQuery({ queryKey: ttk.master, queryFn: () => api<TtMasterData>('/timetrack/masterdata'), staleTime: 5 * 60_000 });
}

/** Alle laufenden Timer (ältester zuerst) */
export function useActiveEntries() {
  return useQuery({
    queryKey: ttk.active,
    queryFn: async () => (await api<{ entries: TtEntry[] }>('/timetrack/active')).entries,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useTtSettings() {
  return useQuery({ queryKey: ttk.settings, queryFn: () => api<TtSettings>('/timetrack/settings'), staleTime: 10 * 60_000 });
}

export function useEntries(f: EntryFilter, enabled = true) {
  return useQuery({
    queryKey: ttk.entries(f),
    queryFn: () => api<TtEntryList>('/timetrack/entries', { query: { ...f } }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useRecent() {
  return useQuery({ queryKey: ttk.recent, queryFn: () => api<TtRecent[]>('/timetrack/recent'), staleTime: 60_000 });
}

export function useTags() {
  return useQuery({ queryKey: ttk.tags, queryFn: () => api<string[]>('/timetrack/tags'), staleTime: 5 * 60_000 });
}

export function useReport(from: string, to: string) {
  return useQuery({
    queryKey: ttk.report(from, to),
    queryFn: () => api<TtReport>('/timetrack/report', { query: { from, to, tz: TZ } }),
    placeholderData: keepPreviousData,
  });
}

export function useKimai(poll: boolean) {
  return useQuery({
    queryKey: ttk.kimai,
    queryFn: () => api<{ connection: TtKimaiConnection | null; status: TtImportStatus | null }>('/timetrack/kimai'),
    refetchInterval: poll ? 1500 : false,
  });
}

export function exportCsvUrl(from: string, to: string) {
  return apiUrl('/timetrack/export.csv', { from, to, tz: TZ });
}

/** Alles rund um Einträge neu laden (Liste, Timer, Auswertung, Zuletzt) */
function useInvalidateEntries() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['timetrack', 'entries'] });
    void qc.invalidateQueries({ queryKey: ['timetrack', 'report'] });
    void qc.invalidateQueries({ queryKey: ttk.active });
    void qc.invalidateQueries({ queryKey: ttk.recent });
    void qc.invalidateQueries({ queryKey: ttk.tags });
  };
}

/** Timer- und Eintragsaktionen mit Rückmeldung */
export function useEntryActions() {
  const qc = useQueryClient();
  const refresh = useInvalidateEntries();
  const onError = (err: unknown) => toast.error(errorMessage(err));
  const addRunning = (e: TtEntry) => {
    qc.setQueryData<TtEntry[]>(ttk.active, (old) => [...(old ?? []).filter((x) => x.id !== e.id), e]);
    refresh();
  };

  const start = useMutation({
    mutationFn: (b: TtStartInput) => api<TtEntry>('/timetrack/start', { method: 'POST', body: b }),
    onSuccess: addRunning,
    onError,
  });
  /** id = diesen Timer stoppen, ohne id = alle */
  const stop = useMutation({
    mutationFn: (id?: string) => api<{ entries: TtEntry[] }>('/timetrack/stop', { method: 'POST', body: id ? { id } : {} }),
    onSuccess: (r) => {
      const ids = new Set(r.entries.map((e) => e.id));
      qc.setQueryData<TtEntry[]>(ttk.active, (old) => (old ?? []).filter((e) => !ids.has(e.id)));
      refresh();
      if (r.entries.length === 1) toast.success(`Gestoppt: ${formatDuration(r.entries[0]!.duration)} h auf ${r.entries[0]!.projectName}`);
      else if (r.entries.length > 1) toast.success(`${r.entries.length} Timer gestoppt`);
    },
    onError,
  });
  const restart = useMutation({
    mutationFn: (id: string) => api<TtEntry>(`/timetrack/entries/${id}/restart`, { method: 'POST' }),
    onSuccess: addRunning,
    onError,
  });
  const save = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: TtEntryInput }) =>
      id ? api<TtEntry>(`/timetrack/entries/${id}`, { method: 'PUT', body }) : api<TtEntry>('/timetrack/entries', { method: 'POST', body }),
    onSuccess: () => refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/timetrack/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      toast.success('Eintrag gelöscht');
    },
    onError,
  });
  /** Schlagworte/Verknüpfungen ändern – sofort in der Liste sichtbar, Server bestätigt nachträglich */
  const meta = useMutation({
    mutationFn: ({ id, body }: { id: string; body: TtEntryMetaInput }) => api<TtEntry>(`/timetrack/entries/${id}/meta`, { method: 'PATCH', body }),
    onMutate: ({ id, body }) => {
      const patch = (e: TtEntry): TtEntry => (e.id === id ? { ...e, tags: body.tags ?? e.tags, links: body.links ?? e.links } : e);
      qc.setQueriesData<TtEntryList>({ queryKey: ['timetrack', 'entries'] }, (old) => (old ? { ...old, items: old.items.map(patch) } : old));
      qc.setQueryData<TtEntry[]>(ttk.active, (old) => old?.map(patch));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['timetrack', 'entries'] });
      void qc.invalidateQueries({ queryKey: ttk.tags });
      void qc.invalidateQueries({ queryKey: ['timetrack', 'report'] });
    },
    onError: (err) => {
      onError(err);
      refresh();
    },
  });
  return { start, stop, restart, save, remove, meta };
}

/* ───────────────────────────── Zeit & Formatierung ───────────────────────────── */

/** Sekunden → „1:05“ (Stunden:Minuten) */
export function formatDuration(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** Sekunden → „1:05:09“ für laufende Timer */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Sekunden → „12,5 h“ */
export function formatHours(sec: number): string {
  return `${(sec / 3600).toLocaleString('de-DE', { maximumFractionDigits: 2 })} h`;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return amount.toLocaleString('de-DE', { style: 'currency', currency });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Sekündlich aktualisierte Uhrzeit (nur solange aktiv) */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Wie der Server beim Stoppen rundet: ganze Minuten, dann auf volle Blöcke aufrunden (mind. ein Block) */
export function roundUpSeconds(sec: number, minutes: number): number {
  if (!minutes) return sec;
  const block = minutes * 60;
  return Math.max(block, Math.ceil((Math.floor(sec / 60) * 60) / block) * block);
}

/** Summe der Dauern, laufende Einträge sekündlich bis jetzt */
export function useLiveTotal(list: TtEntry[]): number {
  const now = useNow(list.some((e) => !e.end));
  return list.reduce((s, e) => s + (e.end ? e.duration : Math.max(0, Math.floor((now - Date.parse(e.begin)) / 1000))), 0);
}

/** Laufzeit eines (ggf. laufenden) Eintrags in Sekunden */
export function useElapsed(entry: TtEntry | null | undefined): number {
  const now = useNow(!!entry && !entry.end);
  if (!entry) return 0;
  return entry.end ? entry.duration : Math.max(0, Math.floor((now - Date.parse(entry.begin)) / 1000));
}

/** Projekte/Tätigkeiten als Auswahllisten aufbereiten */
export function useMasterLookup() {
  const { data } = useMasterData();
  return useMemo(() => {
    const customers = new Map((data?.customers ?? []).map((c) => [c.id, c]));
    const projects = new Map((data?.projects ?? []).map((p) => [p.id, p]));
    const activities = new Map((data?.activities ?? []).map((a) => [a.id, a]));
    return { data, customers, projects, activities };
  }, [data]);
}
