/**
 * Bereich „Telefon“ (3CX): Wahlfeld, eigener Status, laufendes Gespräch mit Auflegen,
 * Anrufliste, 3CX-Telefonbuch und Kollegen mit Status.
 * Zustand in der URL: ?tab=log|contacts|colleagues&q=…&number=… (number füllt das Wahlfeld)
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, isToday, isYesterday } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  BookUser,
  Delete,
  Mail,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  RefreshCw,
  Search,
  Smartphone,
  Users,
} from 'lucide-react';
import type { ThreeCxCallDirection, ThreeCxCallLogEntry, ThreeCxColleague, ThreeCxContact } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useFeature } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Input, PageHeader, Select, Skeleton, Tabs } from '@/components/ui';
import { openCompose } from '@/features/mail/compose-api';
import { callViaThreeCx, tk, useActiveCalls, useCallLog, useColleagues, useThreeCxContacts, useThreeCxMe } from './api';

type Tab = 'log' | 'contacts' | 'colleagues';

/** Anwesenheitsprofile von 3CX V20 mit den Bezeichnungen der 3CX-Apps */
const PROFILE_LABELS: Record<string, string> = {
  Available: 'Verfügbar',
  Away: 'Abwesend',
  'Out of office': 'Nicht stören',
  'Custom 1': 'Mittagspause',
  'Custom 2': 'Dienstreise',
};

const PROFILE_DOT: Record<string, string> = {
  Available: 'bg-success',
  Away: 'bg-warning',
  'Out of office': 'bg-danger',
  'Custom 1': 'bg-warning',
  'Custom 2': 'bg-info',
};

const profileLabel = (p: string | null | undefined) => (p ? (PROFILE_LABELS[p] ?? p) : 'Unbekannt');

/* ───────────────────────────── Einstieg ───────────────────────────── */

export function PhonePage() {
  const feature = useFeature('threecx');
  const { data: me, isLoading } = useThreeCxMe();
  if (!feature) return <EmptyState icon={<Phone />} title="3CX nicht eingerichtet">Die Anbindung an die Telefonanlage ist nicht aktiv.</EmptyState>;
  if (isLoading || !me) {
    return (
      <div className="p-8">
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!me.extension) {
    return (
      <EmptyState icon={<Phone />} title="Keine Nebenstelle zugeordnet">
        Der Administrator legt fest, welche 3CX-Nebenstelle zu deinem Kuvert-Benutzer gehört.
      </EmptyState>
    );
  }
  return <PhoneView extension={me.extension} />;
}

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
  return { tab: (params.get('tab') as Tab) || 'log', q: params.get('q') ?? '', number: params.get('number') ?? '', set };
}

function PhoneView({ extension }: { extension: string }) {
  const { tab, q, number, set } = useUrlState();
  const qc = useQueryClient();
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => set({ q: input.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  /** Anruf starten und das laufende Gespräch gleich anzeigen */
  const call = async (n: string) => {
    if (await callViaThreeCx(n)) {
      setTimeout(() => void qc.invalidateQueries({ queryKey: tk.active }), 800);
      setTimeout(() => void qc.invalidateQueries({ queryKey: tk.log(14) }), 15_000);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        <PageHeader icon={<Phone />} title="Telefon" description={`Anrufe über deine 3CX-Nebenstelle ${extension}`} />
        <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <ActiveCallCard />
            <Dialpad initial={number} onCall={call} />
            <MyStatusCard />
          </div>
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Tabs<Tab>
                value={tab}
                onChange={(v) => set({ tab: v })}
                tabs={[
                  { value: 'log', label: 'Anrufliste' },
                  { value: 'contacts', label: 'Telefonbuch' },
                  { value: 'colleagues', label: 'Kollegen' },
                ]}
              />
              {tab !== 'log' && (
                <div className="relative min-w-[12rem] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={tab === 'contacts' ? 'Name, Firma oder Nummer …' : 'Kollege suchen …'} className="pl-9" />
                </div>
              )}
            </div>
            {tab === 'log' ? <CallLogList onCall={call} /> : tab === 'contacts' ? <ContactList q={q} onCall={call} /> : <ColleagueList q={q} onCall={call} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Wahlfeld ───────────────────────────── */

const KEYS: [string, string][] = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

function Dialpad({ initial, onCall }: { initial: string; onCall: (n: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initial) setValue(initial);
  }, [initial]);

  const submit = async () => {
    const n = value.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onCall(n);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card bodyClassName="p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="relative">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^\d+*#\s()/-]/g, ''))}
            placeholder="Nummer oder Nebenstelle"
            inputMode="tel"
            autoComplete="off"
            className="h-12 pr-10 text-center font-mono text-lg tracking-wide"
            aria-label="Rufnummer"
          />
          {value && (
            <IconButton label="Letzte Ziffer löschen" className="absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setValue((v) => v.slice(0, -1))}>
              <Delete className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {KEYS.map(([k, sub]) => (
            <button
              key={k}
              type="button"
              className="flex h-12 flex-col items-center justify-center rounded-xl bg-surface-2 transition-colors hover:bg-primary-soft active:scale-[0.97]"
              onClick={() => setValue((v) => v + k)}
              onContextMenu={(e) => {
                // Langes Drücken/Rechtsklick auf 0 ergibt „+“ wie am Telefon
                if (k === '0') {
                  e.preventDefault();
                  setValue((v) => `${v}+`);
                }
              }}
            >
              <span className="text-lg font-medium leading-none">{k}</span>
              <span className="mt-0.5 h-3 text-[9px] font-medium tracking-widest text-muted">{sub}</span>
            </button>
          ))}
        </div>
        <Button type="submit" variant="primary" className="mt-3 h-11 w-full justify-center" icon={<PhoneCall className="h-4 w-4" />} loading={busy} disabled={!value.trim()}>
          Anrufen
        </Button>
      </form>
    </Card>
  );
}

/* ───────────────────────────── Laufendes Gespräch ───────────────────────────── */

const CALL_STATUS: Record<string, string> = { Ringing: 'klingelt', Dialing: 'wählt', Connected: 'verbunden', Held: 'gehalten', Holding: 'hält' };

function ActiveCallCard() {
  const { data } = useActiveCalls(true);
  const qc = useQueryClient();
  const drop = useMutation({
    mutationFn: (pid: number) => api(`/threecx/calls/active/${pid}/drop`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tk.active }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!data?.length) return null;
  return (
    <Card bodyClassName="p-4" className="border-success/40 bg-success/5">
      <ul className="space-y-3">
        {data.map((c) => (
          <li key={c.participantId} className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 animate-pulse items-center justify-center rounded-full bg-success/15 text-success">
              <PhoneCall className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{c.name || c.number || 'Unbekannt'}</div>
              <div className="truncate text-xs text-muted">
                {c.name && c.number ? `${c.number} · ` : ''}
                {CALL_STATUS[c.status] ?? c.status}
              </div>
            </div>
            <Button size="sm" variant="danger" icon={<PhoneOff className="h-3.5 w-3.5" />} loading={drop.isPending && drop.variables === c.participantId} onClick={() => drop.mutate(c.participantId)}>
              Auflegen
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ───────────────────────────── Eigener Status ───────────────────────────── */

function MyStatusCard() {
  const { data, error } = useColleagues(true);
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (profile: string) => api('/threecx/me/profile', { method: 'PUT', body: { profile } }),
    onSuccess: (_d, profile) => {
      toast.success(`Status: ${profileLabel(profile)}`);
      void qc.invalidateQueries({ queryKey: tk.colleagues });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (error) return null; // Ohne Konfigurations-API gibt es keinen Status – die Reiter erklären warum
  const current = data?.myProfile ?? '';
  return (
    <Card bodyClassName="p-4">
      <label className="flex items-center gap-3">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', PROFILE_DOT[current] ?? 'bg-muted')} />
        <span className="text-sm font-medium">Mein Status</span>
        <Select className="ml-auto w-40" value={current} disabled={!data || set.isPending} onChange={(e) => set.mutate(e.target.value)}>
          {!current && <option value="">…</option>}
          {Object.entries(PROFILE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
          {current && !PROFILE_LABELS[current] && <option value={current}>{current}</option>}
        </Select>
      </label>
    </Card>
  );
}

/* ───────────────────────────── Anrufliste ───────────────────────────── */

const DIRECTION: Record<ThreeCxCallDirection, { icon: ReactNode; label: string; className: string }> = {
  in: { icon: <PhoneIncoming className="h-4 w-4" />, label: 'Eingehend', className: 'text-success' },
  out: { icon: <PhoneOutgoing className="h-4 w-4" />, label: 'Ausgehend', className: 'text-primary' },
  missed: { icon: <PhoneMissed className="h-4 w-4" />, label: 'Verpasst', className: 'text-danger' },
  internal: { icon: <Phone className="h-4 w-4" />, label: 'Intern', className: 'text-muted' },
};

function formatDuration(s: number) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')} h` : `${m}:${String(sec).padStart(2, '0')} min`;
}

function dayLabel(d: Date) {
  if (isToday(d)) return 'Heute';
  if (isYesterday(d)) return 'Gestern';
  return format(d, 'EEEE, d. MMMM', { locale: de });
}

function ErrorCard({ error }: { error: unknown }) {
  return (
    <Card>
      <p className="text-sm text-danger">{errorMessage(error)}</p>
    </Card>
  );
}

function CallLogList({ onCall }: { onCall: (n: string) => Promise<void> }) {
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const { data, error, isFetching, refetch } = useCallLog(14, true);

  const groups = useMemo(() => {
    const out: { day: string; items: ThreeCxCallLogEntry[] }[] = [];
    for (const e of data?.entries ?? []) {
      if (filter === 'missed' && e.direction !== 'missed') continue;
      const label = dayLabel(new Date(e.start));
      const last = out[out.length - 1];
      if (last && last.day === label) last.items.push(e);
      else out.push({ day: label, items: [e] });
    }
    return out;
  }, [data, filter]);

  if (error) return <ErrorCard error={error} />;
  if (!data) return <Skeleton className="h-64 w-full rounded-2xl" />;

  return (
    <Card bodyClassName="p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Tabs<'all' | 'missed'>
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: 'all', label: 'Alle' },
            { value: 'missed', label: 'Verpasste' },
          ]}
        />
        <span className="ml-auto text-xs text-muted">letzte {data.days} Tage</span>
        <IconButton label="Aktualisieren" onClick={() => void refetch()}>
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
        </IconButton>
      </div>
      {!groups.length ? (
        <EmptyState icon={<Phone />} title={filter === 'missed' ? 'Keine verpassten Anrufe' : 'Keine Anrufe'} />
      ) : (
        groups.map((g) => (
          <section key={g.day}>
            <h3 className="sticky top-0 bg-surface-2/80 px-4 py-1.5 text-xs font-medium text-muted backdrop-blur">{g.day}</h3>
            <ul className="divide-y divide-border">
              {g.items.map((e) => {
                const d = DIRECTION[e.direction];
                return (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className={cn('shrink-0', d.className)} title={d.label}>
                      {d.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-sm font-medium', e.direction === 'missed' && 'text-danger')}>{e.name || e.number || 'Unbekannt'}</div>
                      <div className="truncate text-xs text-muted">
                        {e.name && e.number ? `${e.number} · ` : ''}
                        {format(new Date(e.start), 'HH:mm')}
                        {e.talkSeconds ? ` · ${formatDuration(e.talkSeconds)}` : ''}
                      </div>
                    </div>
                    {e.number && (
                      <IconButton label={`${e.number} anrufen`} onClick={() => void onCall(e.number!)}>
                        <PhoneCall className="h-4 w-4" />
                      </IconButton>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Card>
  );
}

/* ───────────────────────────── Telefonbuch ───────────────────────────── */

const PHONE_TYPE: Record<ThreeCxContact['phones'][number]['type'], string> = { mobile: 'Mobil', work: 'Geschäftlich', home: 'Privat', other: 'Weitere', fax: 'Fax' };

function ContactList({ q, onCall }: { q: string; onCall: (n: string) => Promise<void> }) {
  const { data, error } = useThreeCxContacts(q, true);
  if (error) return <ErrorCard error={error} />;
  if (!data) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (!data.length) {
    return (
      <Card>
        <EmptyState icon={<BookUser />} title={q ? 'Keine Treffer' : 'Telefonbuch ist leer'} />
      </Card>
    );
  }
  return (
    <Card bodyClassName="p-0">
      <ul className="divide-y divide-border">
        {data.map((c) => (
          <li key={c.id} className="flex items-start gap-3 px-4 py-3">
            <Avatar name={c.name} size={36} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{c.name}</div>
              {(c.company || c.title || c.department) && <div className="truncate text-xs text-muted">{[c.title, c.department, c.name !== c.company ? c.company : null].filter(Boolean).join(' · ')}</div>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {c.phones
                  .filter((p) => p.type !== 'fax')
                  .map((p) => (
                    <button key={p.number} type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => void onCall(p.number)}>
                      {p.type === 'mobile' ? <Smartphone className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                      <span className="text-muted">{PHONE_TYPE[p.type]}:</span> {p.number}
                    </button>
                  ))}
                {c.email && (
                  <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-primary" onClick={() => openCompose({ to: [{ name: c.name, address: c.email! }] })}>
                    <Mail className="h-3.5 w-3.5" />
                    {c.email}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ───────────────────────────── Kollegen ───────────────────────────── */

function ColleagueStatus({ c }: { c: ThreeCxColleague }) {
  if (c.onCall) return <Badge tone="danger">telefoniert</Badge>;
  if (!c.registered) return <Badge tone="neutral">abgemeldet</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={cn('h-2 w-2 rounded-full', PROFILE_DOT[c.profile ?? ''] ?? 'bg-muted')} />
      {profileLabel(c.profile)}
    </span>
  );
}

function ColleagueList({ q, onCall }: { q: string; onCall: (n: string) => Promise<void> }) {
  const { data, error } = useColleagues(true);
  const needle = q.toLowerCase();
  const list = (data?.colleagues ?? []).filter((c) => !c.me && (!needle || `${c.name} ${c.extension} ${c.email ?? ''}`.toLowerCase().includes(needle)));
  if (error) return <ErrorCard error={error} />;
  if (!data) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (!list.length) {
    return (
      <Card>
        <EmptyState icon={<Users />} title="Keine Kollegen gefunden" />
      </Card>
    );
  }
  return (
    <Card bodyClassName="p-0">
      <ul className="divide-y divide-border">
        {list.map((c) => (
          <li key={c.extension} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={c.name} email={c.email ?? undefined} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{c.name}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                <span>Durchwahl {c.extension}</span>
                <ColleagueStatus c={c} />
              </div>
            </div>
            {c.mobile && (
              <IconButton label={`Mobil anrufen (${c.mobile})`} onClick={() => void onCall(c.mobile!)}>
                <Smartphone className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton label={`${c.name} anrufen (${c.extension})`} onClick={() => void onCall(c.extension)}>
              <PhoneCall className="h-4 w-4" />
            </IconButton>
          </li>
        ))}
      </ul>
    </Card>
  );
}
