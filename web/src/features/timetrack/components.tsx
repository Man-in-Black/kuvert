/**
 * Gemeinsame Bausteine der Zeiterfassung: Projekt-/Tätigkeitsauswahl, Timer-Karte
 * (läuft bzw. Startformular), Eintragsdialog und Tagesliste.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { de } from 'date-fns/locale';
import { MoreHorizontal, Pencil, Play, Plus, Square, Tag, Trash2 } from 'lucide-react';
import type { TtEntry, TtEntryInput } from '@kuvert/shared';
import { Badge, Button, Checkbox, ColorDot, Dropdown, EmptyState, Field, IconButton, Input, Modal, Textarea, useConfirm } from '@/components/ui';
import { Combobox, type ComboItem } from './Combobox';
import { cn } from '@/lib/utils';
import { TimeRangeEditor, type TimeRangeValue } from './TimeRangeEditor';
import { DayTimeline } from './DayTimeline';
import { CopyTextButton, DoneToggle, EntryChips, TagMenu, useEntryMeta } from './EntryTags';
import { useExtensions } from '@/modules/context';
import { formatClock, formatDuration, formatMoney, roundUpSeconds, useActiveEntries, useElapsed, useEntryActions, useLiveTotal, useMasterLookup, useRecent, useTags, useTtSettings } from './api';

/* ═════════════════════════════ Auswahl ═════════════════════════════ */

/**
 * Projektauswahl mit Suche: findet Projekte auch über den Kundennamen sowie Kunden-, Projekt- und
 * Auftragsnummer. Ausgeblendete nur, wenn gerade gewählt. emptyOption = Leer-Eintrag (z. B. „Alle Projekte“).
 */
export function ProjectSelect({
  value,
  onChange,
  className,
  placeholder = 'Projekt oder Kunde suchen …',
  emptyOption,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
  placeholder?: string;
  emptyOption?: string;
}) {
  const { data } = useMasterLookup();
  const items = useMemo<ComboItem[]>(() => {
    if (!data) return [];
    const list: ComboItem[] = emptyOption ? [{ id: '', label: emptyOption }] : [];
    for (const c of data.customers) {
      for (const p of data.projects) {
        if (p.customerId !== c.id || !((p.visible && c.visible) || p.id === value)) continue;
        list.push({
          id: p.id,
          label: p.name,
          group: c.name,
          search: [c.number, p.number, p.orderNumber].filter(Boolean).join(' '),
          color: p.color ?? c.color,
          hint: p.visible && c.visible ? undefined : 'ausgeblendet',
        });
      }
    }
    return list;
  }, [data, value, emptyOption]);
  return (
    <Combobox
      items={items}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel="Projekt"
      className={className}
      searchPlaceholder="Kunde, Projekt oder Nummer …"
    />
  );
}

/** Tätigkeiten des gewählten Projekts und allgemeine, mit Suche */
export function ActivitySelect({ projectId, value, onChange, className }: { projectId: string; value: string; onChange: (id: string) => void; className?: string }) {
  const { data, projects } = useMasterLookup();
  const items = useMemo<ComboItem[]>(() => {
    const all = (data?.activities ?? []).filter((a) => (a.projectId === null || a.projectId === projectId) && (a.visible || a.id === value));
    const projectName = projects.get(projectId)?.name ?? 'Projekt';
    return [
      { id: '', label: 'Keine Tätigkeit' },
      ...all.filter((a) => a.projectId).map((a) => ({ id: a.id, label: a.name, group: `Nur ${projectName}`, color: a.color })),
      ...all.filter((a) => !a.projectId).map((a) => ({ id: a.id, label: a.name, group: 'Allgemein', color: a.color })),
    ];
  }, [data, projects, projectId, value]);
  return (
    <Combobox
      items={items}
      value={value}
      onChange={onChange}
      placeholder="Keine Tätigkeit"
      ariaLabel="Tätigkeit"
      className={className}
      disabled={!projectId}
      display={(i) => i.label}
      searchPlaceholder="Tätigkeit suchen …"
    />
  );
}

/** Schlagworte als Komma-Liste mit Vorschlägen */
export function TagsInput({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { data: tags } = useTags();
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Schlagworte, durch Komma getrennt" list="tt-tags" className={className} />
      <datalist id="tt-tags">
        {(tags ?? []).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </>
  );
}

export const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/** „Kunde › Projekt · Tätigkeit“ */
export function EntryTitle({ e, className }: { e: Pick<TtEntry, 'customerName' | 'projectName' | 'activityName' | 'color'>; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <ColorDot color={e.color ?? undefined} />
      <span className="min-w-0 truncate text-sm">
        <span className="text-muted">{e.customerName} › </span>
        <span className="font-medium">{e.projectName}</span>
        {e.activityName && <span className="text-muted"> · {e.activityName}</span>}
      </span>
    </div>
  );
}

/* ═════════════════════════════ Timer ═════════════════════════════ */

/** Laufende Timer (mehrere möglich) und Startformular; compact für die Seitenleiste */
export function TimerCard({ compact }: { compact?: boolean }) {
  const { data: active, isLoading } = useActiveEntries();
  const { stop } = useEntryActions();
  const [editing, setEditing] = useState<TtEntry | null>(null);
  const [another, setAnother] = useState(false);
  const running = active ?? [];
  // Nach dem Start des weiteren Timers das Formular wieder einklappen
  const count = running.length;
  useEffect(() => setAnother(false), [count]);

  if (isLoading) return <div className="h-32 animate-pulse rounded-2xl bg-surface-2" />;
  return (
    <div className="space-y-3">
      {running.length > 1 && (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-primary">{running.length} Timer laufen</span>
          <Button size="sm" variant="ghost" className="text-danger" icon={<Square className="h-3.5 w-3.5 fill-current" />} loading={stop.isPending && !stop.variables} onClick={() => stop.mutate(undefined)}>
            Alle stoppen
          </Button>
        </div>
      )}
      {running.map((e) => (
        <RunningTimer key={e.id} entry={e} compact={compact || running.length > 1} onEdit={() => setEditing(e)} />
      ))}
      {running.length === 0 || another ? (
        <StartForm compact={compact} onCancel={running.length ? () => setAnother(false) : undefined} />
      ) : (
        <Button variant="outline" icon={<Plus className="h-4 w-4" />} className="w-full justify-center border-dashed" onClick={() => setAnother(true)}>
          Weiteren Timer starten
        </Button>
      )}
      {editing && <EntryEditor entry={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RunningTimer({ entry, compact, onEdit }: { entry: TtEntry; compact?: boolean; onEdit: () => void }) {
  const elapsed = useElapsed(entry);
  const { stop } = useEntryActions();
  const { data: settings } = useTtSettings();
  const roundUp = settings?.roundUp ?? 15;
  const rounded = roundUpSeconds(elapsed, roundUp);
  return (
    <section className={cn('rounded-2xl border border-primary/30 bg-primary-soft/40 shadow-card', compact ? 'p-3' : 'p-4')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-primary">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            Läuft seit {format(new Date(entry.begin), 'HH:mm')} Uhr
          </div>
          <EntryTitle e={entry} />
          {entry.description && <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-fg/80">{entry.description}</p>}
          <EntryChips entry={entry} className="mt-1.5" />
        </div>
        <div className="flex shrink-0 items-center">
          <CopyTextButton text={entry.description} compact />
          <IconButton label="Bearbeiten" size="icon-sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('font-mono font-semibold tabular-nums tracking-tight', compact ? 'text-2xl' : 'text-3xl')}>{formatClock(elapsed)}</div>
          {roundUp > 0 && <div className="text-[11px] text-muted">Beim Stoppen: {formatDuration(rounded)} h (auf {roundUp} min aufgerundet)</div>}
        </div>
        <Button
          variant="danger"
          icon={<Square className="h-4 w-4 fill-current" />}
          loading={stop.isPending && stop.variables === entry.id}
          onClick={() => stop.mutate(entry.id)}
        >
          Stopp
        </Button>
      </div>
    </section>
  );
}

function StartForm({ compact, onCancel }: { compact?: boolean; onCancel?: () => void }) {
  const { data: recent } = useRecent();
  const { start } = useEntryActions();
  const [projectId, setProjectId] = useState('');
  const [activityId, setActivityId] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [touched, setTouched] = useState(false);
  const { projects, activities } = useMasterLookup();

  // Vorbelegung mit der zuletzt verwendeten Kombination
  useEffect(() => {
    if (touched || projectId || !recent?.length) return;
    setProjectId(recent[0]!.projectId);
    setActivityId(recent[0]!.activityId ?? '');
  }, [recent, touched, projectId]);

  // Tätigkeit verwerfen, wenn sie nicht zum neuen Projekt passt
  useEffect(() => {
    const a = activityId ? activities.get(activityId) : null;
    if (a?.projectId && a.projectId !== projectId) setActivityId('');
  }, [projectId, activityId, activities]);

  const submit = () => {
    if (!projectId) return;
    start.mutate(
      { projectId, activityId: activityId || null, description: description.trim() || null, tags: parseTags(tags), billable: projects.get(projectId)?.billable },
      {
        onSuccess: () => {
          setDescription('');
          setTags('');
        },
      },
    );
  };

  return (
    <form
      className="rounded-2xl border border-border bg-surface p-4 shadow-card"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
        <Field label="Projekt (Kunde › Projekt)">
          <ProjectSelect
            value={projectId}
            onChange={(v) => {
              setTouched(true);
              setProjectId(v);
            }}
          />
        </Field>
        <Field label="Tätigkeit">
          <ActivitySelect
            projectId={projectId}
            value={activityId}
            onChange={(v) => {
              setTouched(true);
              setActivityId(v);
            }}
          />
        </Field>
      </div>
      <Field label="Was machst du?" hint={compact ? undefined : 'Enter startet den Timer, Umschalt+Enter macht eine neue Zeile.'} className="mt-3">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            // Enter startet, Umschalt+Enter macht eine neue Zeile
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Woran arbeitest du?"
          rows={compact ? 3 : 2}
          className="min-h-0 resize-y"
        />
      </Field>
      <div className={cn('mt-3 flex gap-2', compact ? 'flex-col' : 'flex-wrap items-end')}>
        {!compact && (
          <Field label="Schlagworte" className="min-w-[12rem] flex-1">
            <TagsInput value={tags} onChange={setTags} />
          </Field>
        )}
        <Button
          type="submit"
          variant="primary"
          icon={<Play className="h-4 w-4 fill-current" />}
          loading={start.isPending}
          disabled={!projectId}
          className={cn(compact ? 'h-10 justify-center' : 'px-6')}
        >
          Start
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} className={cn(compact && 'justify-center')}>
            Abbrechen
          </Button>
        )}
      </div>
    </form>
  );
}

/* ═════════════════════════════ Zuletzt verwendet ═════════════════════════════ */

export function RecentList({ limit = 5 }: { limit?: number }) {
  const { data: recent } = useRecent();
  const { start } = useEntryActions();
  const { data: active } = useActiveEntries();
  const items = (recent ?? []).slice(0, limit);
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      {items.map((r, i) => {
        const same = (active ?? []).some((a) => a.projectId === r.projectId && a.activityId === r.activityId && (a.description ?? '') === (r.description ?? ''));
        return (
          <div key={i} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
            <div className="min-w-0 flex-1">
              <EntryTitle e={r} />
              {r.description && <div className="truncate pl-[18px] text-xs text-muted">{r.description}</div>}
            </div>
            <IconButton
              label="Starten"
              size="icon-sm"
              disabled={!!same || start.isPending}
              onClick={() => start.mutate({ projectId: r.projectId, activityId: r.activityId, description: r.description, tags: r.tags })}
            >
              <Play className="h-4 w-4" />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

/* ═════════════════════════════ Tagesliste ═════════════════════════════ */

export function TagList({ tags, className }: { tags: string[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {tags.map((t) => (
        <Badge key={t} tone="neutral" className="gap-1">
          <Tag className="h-3 w-3" />
          {t}
        </Badge>
      ))}
    </div>
  );
}

const dayKey = (iso: string) => format(new Date(iso), 'yyyy-MM-dd');

/** „95“, „95,50“, „1.234,5“ → Zahl; leer → null; ungültig → undefined */
function parseMoney(s: string): number | null | undefined {
  const t = s.trim().replace(/\s|€/g, '');
  if (!t) return null;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : undefined;
}

export function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00:00`);
  if (isToday(d)) return 'Heute';
  if (isYesterday(d)) return 'Gestern';
  return format(d, 'EEEE, d. MMMM yyyy', { locale: de });
}

/** Einträge nach Tagen gruppiert, je Tag mit Summe */
export function EntryDays({ entries, compact, empty }: { entries: TtEntry[]; compact?: boolean; empty?: ReactNode }) {
  const [editing, setEditing] = useState<TtEntry | null>(null);
  const [filling, setFilling] = useState<{ begin: Date; duration: number } | null>(null);
  const { confirm, dialog } = useConfirm();
  const { restart, remove } = useEntryActions();
  const days = useMemo(() => {
    const map = new Map<string, TtEntry[]>();
    for (const e of entries) {
      const k = dayKey(e.begin);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries]);

  if (!entries.length) return <>{empty ?? <EmptyState title="Keine Einträge">Für diesen Zeitraum ist noch nichts erfasst.</EmptyState>}</>;

  return (
    <div className="space-y-4">
      {days.map(([day, list]) => (
        <DaySection key={day} day={day} list={list} compact={compact} onSelect={setEditing} onFillGap={(begin, duration) => setFilling({ begin, duration })}>
          {list.map((e) => (
            <EntryRow
              key={e.id}
              e={e}
              compact={compact}
              onEdit={() => setEditing(e)}
              onRestart={() => restart.mutate(e.id)}
              onDelete={async () => {
                if (await confirm('Diesen Zeiteintrag löschen?', { danger: true })) remove.mutate(e.id);
              }}
            />
          ))}
        </DaySection>
      ))}
      {editing && <EntryEditor entry={editing} onClose={() => setEditing(null)} />}
      {filling && <EntryEditor entry={null} defaultRange={filling} onClose={() => setFilling(null)} />}
      {dialog}
    </div>
  );
}

function DaySection({
  day,
  list,
  compact,
  onSelect,
  onFillGap,
  children,
}: {
  day: string;
  list: TtEntry[];
  compact?: boolean;
  onSelect?: (e: TtEntry) => void;
  onFillGap?: (begin: Date, durationSec: number) => void;
  children: ReactNode;
}) {
  const total = useLiveTotal(list);
  return (
    <section className={cn(!compact && 'overflow-hidden rounded-2xl border border-border bg-surface shadow-card')}>
      <header className={cn('flex items-center justify-between gap-2', compact ? 'px-1 pb-1' : 'bg-surface-2/50 px-4 pb-1 pt-2')}>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{dayLabel(day)}</span>
        <span className="font-mono text-xs font-semibold tabular-nums">{formatDuration(total)}</span>
      </header>
      <div className={cn(!compact && 'border-b border-border bg-surface-2/50')}>
        <DayTimeline day={day} list={list} compact={compact} onSelect={onSelect} onFillGap={onFillGap} />
      </div>
      <div className={cn(!compact && 'divide-y divide-border')}>{children}</div>
    </section>
  );
}

function EntryRow({ e, compact, onEdit, onRestart, onDelete }: { e: TtEntry; compact?: boolean; onEdit: () => void; onRestart: () => void; onDelete: () => void }) {
  const elapsed = useElapsed(e);
  const running = !e.end;
  const extensions = useExtensions('timeEntryActions');
  const { addLink, doneTag } = useEntryMeta(e);
  return (
    <div className={cn('group flex items-center gap-2', compact ? 'rounded-lg px-1 py-1.5 hover:bg-hover' : 'gap-3 px-4 py-2.5 hover:bg-hover/60')}>
      <div className="min-w-0 flex-1">
        <button type="button" className="block w-full min-w-0 text-left" onClick={onEdit}>
          <EntryTitle e={e} />
          {e.description && (
            <span className={cn('mt-0.5 block min-w-0 whitespace-pre-line pl-[18px] text-xs text-muted', compact ? 'truncate' : 'line-clamp-2')}>{e.description}</span>
          )}
        </button>
        <EntryChips entry={e} className="mt-1 pl-[18px]" />
      </div>
      {!compact && (
        <span className="hidden shrink-0 text-xs tabular-nums text-muted sm:block">
          {format(new Date(e.begin), 'HH:mm')} – {e.end ? format(new Date(e.end), 'HH:mm') : 'läuft'}
        </span>
      )}
      {!compact && !e.billable && (
        <Badge tone="neutral" className="hidden md:inline-flex">
          nicht abrechenbar
        </Badge>
      )}
      <span className={cn('w-12 shrink-0 text-right font-mono text-sm tabular-nums', running && 'font-semibold text-primary')}>{formatDuration(running ? elapsed : e.duration)}</span>
      <div className="flex shrink-0 items-center">
        <CopyTextButton text={e.description} compact={compact} />
        <DoneToggle entry={e} compact={compact} />
        <TagMenu entry={e} />
        {extensions.map((Ext, i) => (
          <Ext key={i} entry={e} addLink={addLink} doneTag={doneTag} compact={compact} />
        ))}
        {!running && !compact && (
          <IconButton label="Erneut starten" size="icon-sm" onClick={onRestart} className="opacity-60 group-hover:opacity-100">
            <Play className="h-4 w-4" />
          </IconButton>
        )}
        <Dropdown
          align="right"
          trigger={
            <IconButton label="Mehr" size="icon-sm">
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          }
          items={[
            { label: 'Bearbeiten', icon: <Pencil />, onClick: onEdit },
            ...(!running ? [{ label: 'Erneut starten', icon: <Play />, onClick: onRestart }] : []),
            { divider: true, label: '' },
            { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: onDelete },
          ]}
        />
      </div>
    </div>
  );
}

/* ═════════════════════════════ Eintrag bearbeiten/anlegen ═════════════════════════════ */

/** entry = null → neuer Eintrag (optional mit Vorgabe-Tag) */
export function EntryEditor({
  entry,
  defaultDate,
  defaultRange,
  onClose,
}: {
  entry: TtEntry | null;
  defaultDate?: Date;
  /** Neuer Eintrag für einen bestimmten Zeitraum (z. B. eine Lücke im Zeitstrahl) */
  defaultRange?: { begin: Date; duration: number };
  onClose: () => void;
}) {
  const { save } = useEntryActions();
  const { projects, activities, customers } = useMasterLookup();
  const { data: recent } = useRecent();
  const running = !!entry && !entry.end;

  const initialBegin = entry ? new Date(entry.begin) : defaultRange ? new Date(defaultRange.begin) : (() => {
    const d = defaultDate ? new Date(defaultDate) : new Date();
    if (!defaultDate) d.setHours(d.getHours() - 1);
    else d.setHours(9, 0, 0, 0);
    d.setSeconds(0, 0);
    return d;
  })();

  const [projectId, setProjectId] = useState(entry?.projectId ?? recent?.[0]?.projectId ?? '');
  const [activityId, setActivityId] = useState(entry?.activityId ?? (entry ? '' : (recent?.[0]?.activityId ?? '')));
  const [range, setRange] = useState<TimeRangeValue>(() => ({ begin: initialBegin, duration: running ? null : entry ? entry.duration : (defaultRange?.duration ?? 3600) }));
  const [description, setDescription] = useState(entry?.description ?? '');
  const [tags, setTags] = useState((entry?.tags ?? []).join(', '));
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [billableTouched, setBillableTouched] = useState(!!entry);
  const [rateText, setRateText] = useState(entry?.hourlyRateManual && entry.hourlyRate != null ? String(entry.hourlyRate).replace('.', ',') : '');
  const [fixedText, setFixedText] = useState(entry?.fixedRate != null ? String(entry.fixedRate).replace('.', ',') : '');

  useEffect(() => {
    const a = activityId ? activities.get(activityId) : null;
    if (a?.projectId && a.projectId !== projectId) setActivityId('');
  }, [projectId, activityId, activities]);

  // Abrechenbar folgt bei neuen Einträgen dem Projekt bzw. der Tätigkeit
  useEffect(() => {
    if (billableTouched || !projectId) return;
    const p = projects.get(projectId);
    const a = activityId ? activities.get(activityId) : null;
    setBillable((p?.billable ?? true) && (a?.billable ?? true));
  }, [projectId, activityId, projects, activities, billableTouched]);

  const begin = range.begin;
  const end = range.duration == null ? null : new Date(begin.getTime() + range.duration * 1000);
  const hourlyRate = parseMoney(rateText);
  const fixedRate = parseMoney(fixedText);
  // Automatischer Stundensatz: Tätigkeit → Projekt → Kunde
  const project = projects.get(projectId);
  const customer = project ? customers.get(project.customerId) : undefined;
  const { data: ttSettings } = useTtSettings();
  const autoRate = (activityId ? activities.get(activityId)?.hourlyRate : null) ?? project?.hourlyRate ?? customer?.hourlyRate ?? ttSettings?.defaultHourlyRate ?? null;
  const currency = customer?.currency ?? 'EUR';
  const valid = !!projectId && !Number.isNaN(begin.getTime()) && (running || (range.duration ?? 0) >= 60) && hourlyRate !== undefined && fixedRate !== undefined;

  const submit = () => {
    if (!valid) return;
    const body: TtEntryInput = {
      projectId,
      activityId: activityId || null,
      begin: begin.toISOString(),
      end: end ? end.toISOString() : null,
      description: description.trim() || null,
      tags: parseTags(tags),
      billable,
      fixedRate: fixedRate ?? null,
      hourlyRate: hourlyRate ?? null,
    };
    save.mutate({ id: entry?.id ?? null, body }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={entry ? (running ? 'Laufenden Eintrag bearbeiten' : 'Zeiteintrag bearbeiten') : 'Zeit nachtragen'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!valid} icon={entry ? undefined : <Plus className="h-4 w-4" />}>
            {entry ? 'Speichern' : 'Eintragen'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Projekt">
            <ProjectSelect value={projectId} onChange={setProjectId} />
          </Field>
          <Field label="Tätigkeit">
            <ActivitySelect projectId={projectId} value={activityId} onChange={setActivityId} />
          </Field>
        </div>
        <TimeRangeEditor value={range} onChange={setRange} />
        <Field label="Beschreibung">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Was wurde gemacht?" />
        </Field>
        <Field label="Schlagworte">
          <TagsInput value={tags} onChange={setTags} />
        </Field>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field
            label={`Stundensatz (${currency})`}
            hint={rateText.trim() ? 'Eigener Satz für diesen Eintrag – leeren für automatisch.' : autoRate != null ? `Automatisch: ${formatMoney(autoRate, currency)} (Tätigkeit → Projekt → Kunde → zentral)` : 'Kein Stundensatz hinterlegt'}
            error={hourlyRate === undefined ? 'Bitte eine Zahl angeben' : undefined}
          >
            <Input value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" placeholder={autoRate != null ? String(autoRate).replace('.', ',') : 'z. B. 95'} />
          </Field>
          <Field
            label={`Festbetrag (${currency})`}
            hint="Ersetzt Stundensatz × Dauer"
            error={fixedRate === undefined ? 'Bitte eine Zahl angeben' : undefined}
          >
            <Input value={fixedText} onChange={(e) => setFixedText(e.target.value)} inputMode="decimal" placeholder="optional" />
          </Field>
          <Checkbox
            checked={billable}
            onChange={(v) => {
              setBillableTouched(true);
              setBillable(v);
            }}
            label="Abrechenbar"
            className="pb-2"
          />
        </div>
        {entry?.imported && <p className="text-xs text-muted">Aus Kimai übernommen – ein erneuter Import überschreibt Änderungen an diesem Eintrag.</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
