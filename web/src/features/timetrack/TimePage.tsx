/**
 * Bereich „Zeiterfassung“: Timer, Zeiten je Woche/Monat, Auswertung mit CSV-Export,
 * Kunden/Projekte/Tätigkeiten und Import aus Kimai.
 * Zustand in der URL: ?tab=entries|report|masterdata&period=week|month&date=YYYY-MM-DD&q=…
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addMonths, addWeeks, addYears, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { de } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Clock, Download, Plus, Search, Timer, Upload, Wallet } from 'lucide-react';
import { Button, Card, ColorDot, EmptyState, IconButton, Input, Modal, PageHeader, Skeleton, StatCard, Tabs } from '@/components/ui';
import { cn } from '@/lib/utils';
import { exportCsvUrl, formatDuration, formatHours, formatMoney, useEntries, useMasterData, useReport } from './api';
import { EntryDays, EntryEditor, ProjectSelect, TimerCard } from './components';
import { MasterDataView } from './MasterDataView';
import { KimaiImportForm } from './KimaiImport';

type Tab = 'entries' | 'report' | 'masterdata';
type Period = 'week' | 'month' | 'year';

function useUrlState() {
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | undefined>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const dateParam = params.get('date');
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T12:00:00`) : new Date();
  const tab = ((params.get('tab') as Tab) || 'entries') as Tab;
  const p = params.get('period');
  return {
    tab,
    /** Standard: Zeiten je Woche, Auswertung je Monat */
    period: (p === 'week' || p === 'month' || p === 'year' ? p : tab === 'report' ? 'month' : 'week') as Period,
    date,
    q: params.get('q') ?? '',
    projectId: params.get('project') ?? '',
    set,
  };
}

/** Zeitraum (lokal) einer Periode um ein Datum */
export function periodRange(period: Period, date: Date): { from: Date; to: Date; label: string } {
  if (period === 'week') {
    const from = startOfWeek(date, { weekStartsOn: 1 });
    const end = endOfWeek(date, { weekStartsOn: 1 });
    const label = `KW ${format(from, 'I')} · ${format(from, isSameMonth(from, end) ? 'd.' : 'd. MMM', { locale: de })} – ${format(end, 'd. MMM yyyy', { locale: de })}`;
    return { from, to: addWeeks(from, 1), label };
  }
  if (period === 'month') {
    const from = startOfMonth(date);
    return { from, to: addMonths(from, 1), label: format(from, 'MMMM yyyy', { locale: de }) };
  }
  const from = startOfYear(date);
  return { from, to: addYears(from, 1), label: format(from, 'yyyy') };
}

function shift(period: Period, date: Date, dir: 1 | -1): Date {
  if (period === 'week') return addWeeks(date, dir);
  if (period === 'month') return addMonths(date, dir);
  return addYears(date, dir);
}

export function TimePage() {
  const s = useUrlState();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const { data: master, isLoading } = useMasterData();
  const empty = !isLoading && master && !master.projects.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        <PageHeader
          icon={<Timer />}
          title="Zeiterfassung"
          description="Arbeitszeiten mit Timer erfassen, nachtragen und auswerten"
          actions={
            <>
              <Button icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
                Aus Kimai importieren
              </Button>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} disabled={!!empty}>
                Zeit nachtragen
              </Button>
            </>
          }
        />

        <div className="mb-5">
          <Tabs<Tab>
            value={s.tab}
            onChange={(v) => s.set({ tab: v === 'entries' ? undefined : v })}
            tabs={[
              { value: 'entries', label: 'Zeiten' },
              { value: 'report', label: 'Auswertung' },
              { value: 'masterdata', label: 'Kunden & Projekte' },
            ]}
          />
        </div>

        {isLoading ? (
          <Skeleton className="h-40 w-full rounded-2xl" />
        ) : empty && s.tab !== 'masterdata' ? (
          <Card>
            <EmptyState icon={<Timer />} title="Noch keine Projekte">
              <p>Lege zuerst einen Kunden und ein Projekt an – oder übernimm alles aus Kimai.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button onClick={() => s.set({ tab: 'masterdata' })}>Kunden & Projekte anlegen</Button>
                <Button variant="primary" icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
                  Aus Kimai importieren
                </Button>
              </div>
            </EmptyState>
          </Card>
        ) : s.tab === 'entries' ? (
          <EntriesView />
        ) : s.tab === 'report' ? (
          <ReportView />
        ) : (
          <MasterDataView />
        )}
      </div>
      {adding && <EntryEditor entry={null} onClose={() => setAdding(false)} />}
      <Modal open={importing} onClose={() => setImporting(false)} title="Aus Kimai importieren" size="lg">
        <KimaiImportForm />
      </Modal>
    </div>
  );
}

/* ═════════════════════════════ Zeiten ═════════════════════════════ */

function PeriodNav({ period, date, onChange }: { period: Period; date: Date; onChange: (p: { period?: Period; date?: Date | null }) => void }) {
  const range = periodRange(period, date);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs<Period>
        value={period}
        onChange={(v) => onChange({ period: v })}
        tabs={[
          { value: 'week', label: 'Woche' },
          { value: 'month', label: 'Monat' },
          { value: 'year', label: 'Jahr' },
        ]}
      />
      <div className="flex items-center">
        <IconButton label="Zurück" size="icon-sm" onClick={() => onChange({ date: shift(period, date, -1) })}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton label="Weiter" size="icon-sm" onClick={() => onChange({ date: shift(period, date, 1) })}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
      </div>
      <span className="text-sm font-medium">{range.label}</span>
      <Button size="sm" variant="ghost" onClick={() => onChange({ date: null })}>
        Heute
      </Button>
    </div>
  );
}

function EntriesView() {
  const s = useUrlState();
  const range = periodRange(s.period, s.date);
  const [input, setInput] = useState(s.q);
  useEffect(() => setInput(s.q), [s.q]);
  useEffect(() => {
    if (input === s.q) return;
    const t = setTimeout(() => s.set({ q: input.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const { data, isLoading, isFetching } = useEntries({ from: range.from.toISOString(), to: range.to.toISOString(), q: s.q || undefined, projectId: s.projectId || undefined, limit: 2000 });

  return (
    <div className="space-y-5">
      <TimerCard />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodNav
          period={s.period}
          date={s.date}
          onChange={({ period, date }) =>
            s.set({
              ...(period ? { period } : {}),
              ...(date !== undefined ? { date: date ? format(date, 'yyyy-MM-dd') : undefined } : {}),
            })
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Suchen …" className="h-8 pl-8" />
          </div>
          <ProjectFilter value={s.projectId} onChange={(v) => s.set({ project: v || undefined })} />
          <span className={cn('rounded-lg bg-surface-2 px-3 py-1 font-mono text-sm font-semibold tabular-nums', isFetching && 'opacity-60')} title="Summe im Zeitraum">
            {formatDuration(data?.total ?? 0)} h
          </span>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-60 w-full rounded-2xl" />
      ) : (
        <>
          <EntryDays entries={data?.items ?? []} />
          {data?.truncated && <p className="text-center text-xs text-muted">Es werden nur die neuesten 2000 Einträge angezeigt – bitte den Zeitraum verkleinern.</p>}
        </>
      )}
    </div>
  );
}

function ProjectFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <ProjectSelect value={value} onChange={onChange} emptyOption="Alle Projekte" placeholder="Alle Projekte" className="h-8 w-60 max-w-full" />;
}

/* ═════════════════════════════ Auswertung ═════════════════════════════ */

function ReportView() {
  const s = useUrlState();
  const period = s.period;
  const range = periodRange(period, s.date);
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const { data, isLoading, isFetching } = useReport(from, to);

  /** Kunde → Projekt → Tätigkeiten */
  const tree = useMemo(() => {
    const customers = new Map<string, { name: string; color: string | null; duration: number; amount: number; currency: string; projects: Map<string, { name: string; color: string | null; duration: number; amount: number; rows: NonNullable<typeof data>['rows'] }> }>();
    for (const r of data?.rows ?? []) {
      let c = customers.get(r.customerId);
      if (!c) customers.set(r.customerId, (c = { name: r.customerName, color: r.color, duration: 0, amount: 0, currency: r.currency, projects: new Map() }));
      let p = c.projects.get(r.projectId);
      if (!p) c.projects.set(r.projectId, (p = { name: r.projectName, color: r.color, duration: 0, amount: 0, rows: [] }));
      c.duration += r.duration;
      c.amount += r.amount;
      p.duration += r.duration;
      p.amount += r.amount;
      p.rows.push(r);
    }
    return [...customers.entries()].sort((a, b) => b[1].duration - a[1].duration);
  }, [data]);

  const maxDay = Math.max(1, ...(data?.days ?? []).map((d) => d.duration));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodNav
          period={period}
          date={s.date}
          onChange={({ period: p, date }) =>
            s.set({
              ...(p ? { period: p } : {}),
              ...(date !== undefined ? { date: date ? format(date, 'yyyy-MM-dd') : undefined } : {}),
            })
          }
        />
        <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={() => (window.location.href = exportCsvUrl(from, to))}>
          CSV-Export
        </Button>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-60 w-full rounded-2xl" />
      ) : (
        <div className={cn('space-y-5 transition-opacity', isFetching && 'opacity-70')}>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Gesamt" value={formatHours(data.total)} icon={<Clock />} hint={`${formatDuration(data.total)} h`} />
            <StatCard label="Abrechenbar" value={formatHours(data.billable)} icon={<Timer />} tone="success" hint={data.total ? `${Math.round((data.billable / data.total) * 100)} % der Zeit` : undefined} />
            <StatCard
              label="Betrag"
              value={data.amounts.length ? data.amounts.map((a) => formatMoney(a.amount, a.currency)).join(' · ') : '–'}
              icon={<Wallet />}
              tone="info"
              hint="Abrechenbare Zeiten mit Stundensatz"
            />
          </div>

          {data.days.length > 1 && (
            <Card title="Verlauf">
              <div className="flex h-32 items-end gap-[2px]">
                {data.days.map((d) => (
                  <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${format(new Date(`${d.date}T12:00:00`), 'EEE, d. MMM', { locale: de })}: ${formatDuration(d.duration)} h`}>
                    <div className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary" style={{ height: `${Math.max(2, (d.duration / maxDay) * 100)}%` }} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {!tree.length ? (
            <Card>
              <EmptyState icon={<Clock />} title="Keine Zeiten im Zeitraum" />
            </Card>
          ) : (
            <Card bodyClassName="p-0">
              <div className="divide-y divide-border">
                {tree.map(([cid, c]) => (
                  <div key={cid}>
                    <div className="flex items-center gap-3 bg-surface-2/50 px-4 py-2.5">
                      <ColorDot color={c.color ?? undefined} />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.name}</span>
                      {c.amount > 0 && <span className="text-xs tabular-nums text-muted">{formatMoney(c.amount, c.currency)}</span>}
                      <span className="w-16 text-right font-mono text-sm font-semibold tabular-nums">{formatDuration(c.duration)}</span>
                    </div>
                    {[...c.projects.entries()].map(([pid, p]) => (
                      <div key={pid} className="border-t border-border/60">
                        <div className="flex items-center gap-3 px-4 py-2 pl-9">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                          {p.amount > 0 && <span className="text-xs tabular-nums text-muted">{formatMoney(p.amount, c.currency)}</span>}
                          <span className="w-16 text-right font-mono text-sm tabular-nums">{formatDuration(p.duration)}</span>
                        </div>
                        {p.rows.map((r) => (
                          <div key={r.activityId ?? '-'} className="flex items-center gap-3 px-4 py-1 pl-14 text-xs text-muted">
                            <span className="min-w-0 flex-1 truncate">{r.activityName ?? 'ohne Tätigkeit'}</span>
                            <span className="hidden sm:inline">{r.count} Einträge</span>
                            <div className="hidden w-24 sm:block">
                              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                                <div className="h-full rounded-full bg-primary/60" style={{ width: `${(r.duration / Math.max(1, data.total)) * 100}%` }} />
                              </div>
                            </div>
                            <span className="w-16 text-right font-mono tabular-nums">{formatDuration(r.duration)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.tags.length > 0 && (
            <Card title="Schlagworte">
              <div className="flex flex-wrap gap-2">
                {data.tags.map((t) => (
                  <span key={t.tag} className="inline-flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1 text-xs">
                    {t.tag}
                    <span className="font-mono font-semibold tabular-nums">{formatDuration(t.duration)}</span>
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

