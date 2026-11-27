/**
 * Gemeinsame Bausteine der Zeiterfassung: Projekt-/Tätigkeitsauswahl, Timer-Karte
 * (läuft bzw. Startformular), Eintragsdialog und Tagesliste.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { de } from 'date-fns/locale';
import { MoreHorizontal, Pencil, Play, Plus, Square, Tag, Trash2 } from 'lucide-react';
import type { TtEntry, TtEntryInput } from '@kuvert/shared';
import { Badge, Button, Checkbox, ColorDot, Dropdown, EmptyState, Field, IconButton, Input, Modal, Select, Textarea, useConfirm } from '@/components/ui';
import { cn } from '@/lib/utils';
import { TimeRangeEditor, type TimeRangeValue } from './TimeRangeEditor';
import { formatClock, formatDuration, useElapsed, useEntryActions, useMasterLookup, useRecent, useTags, useActiveEntry } from './api';

/* ═════════════════════════════ Auswahl ═════════════════════════════ */

/** Projekte nach Kunden gruppiert; ausgeblendete nur, wenn gerade gewählt */
export function ProjectSelect({ value, onChange, className, placeholder = 'Projekt wählen …' }: { value: string; onChange: (id: string) => void; className?: string; placeholder?: string }) {
  const { data } = useMasterLookup();
  const groups = useMemo(() => {
    if (!data) return [];
    return data.customers
      .map((c) => ({
        customer: c,
        projects: data.projects.filter((p) => p.customerId === c.id && ((p.visible && c.visible) || p.id === value)),
      }))
      .filter((g) => g.projects.length);
  }, [data, value]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Projekt">
      <option value="">{placeholder}</option>
      {groups.map((g) => (
        <optgroup key={g.customer.id} label={g.customer.name}>
          {g.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.visible ? '' : ' (ausgeblendet)'}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Globale und projektgebundene Tätigkeiten des gewählten Projekts */
export function ActivitySelect({ projectId, value, onChange, className }: { projectId: string; value: string; onChange: (id: string) => void; className?: string }) {
  const { data } = useMasterLookup();
  const list = useMemo(() => {
    const all = (data?.activities ?? []).filter((a) => (a.projectId === null || a.projectId === projectId) && (a.visible || a.id === value));
    return { own: all.filter((a) => a.projectId), global: all.filter((a) => !a.projectId) };
  }, [data, projectId, value]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Tätigkeit" disabled={!projectId}>
      <option value="">Keine Tätigkeit</option>
      {list.own.length > 0 && (
        <optgroup label="Projekt">
          {list.own.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </optgroup>
      )}
      {list.global.length > 0 && (
        <optgroup label="Allgemein">
          {list.global.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
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

/** Laufender Timer oder Startformular; compact für die Seitenleiste */
export function TimerCard({ compact }: { compact?: boolean }) {
  const { data: active, isLoading } = useActiveEntry();
  const [editing, setEditing] = useState<TtEntry | null>(null);
  if (isLoading) return <div className="h-32 animate-pulse rounded-2xl bg-surface-2" />;
  return (
    <>
      {active ? <RunningTimer entry={active} compact={compact} onEdit={() => setEditing(active)} /> : <StartForm compact={compact} />}
      {editing && <EntryEditor entry={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RunningTimer({ entry, compact, onEdit }: { entry: TtEntry; compact?: boolean; onEdit: () => void }) {
  const elapsed = useElapsed(entry);
  const { stop } = useEntryActions();
  return (
    <section className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-4 shadow-card">
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
          {entry.description && <p className="mt-1 line-clamp-2 text-sm text-fg/80">{entry.description}</p>}
          {entry.tags.length > 0 && <TagList tags={entry.tags} className="mt-1.5" />}
        </div>
        <IconButton label="Bearbeiten" size="icon-sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </IconButton>
      </div>
      <div className={cn('mt-3 flex items-center gap-3', compact ? 'justify-between' : 'justify-between sm:justify-end')}>
        <span className={cn('font-mono font-semibold tabular-nums tracking-tight', compact ? 'text-2xl' : 'text-3xl')}>{formatClock(elapsed)}</span>
        <Button variant="danger" icon={<Square className="h-4 w-4 fill-current" />} loading={stop.isPending} onClick={() => stop.mutate()}>
          Stopp
        </Button>
      </div>
    </section>
  );
}

function StartForm({ compact }: { compact?: boolean }) {
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
      <div className={cn('grid gap-2', !compact && 'sm:grid-cols-2')}>
        <ProjectSelect
          value={projectId}
          onChange={(v) => {
            setTouched(true);
            setProjectId(v);
          }}
        />
        <ActivitySelect
          projectId={projectId}
          value={activityId}
          onChange={(v) => {
            setTouched(true);
            setActivityId(v);
          }}
        />
      </div>
      <div className={cn('mt-2 flex gap-2', compact && 'flex-col')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Woran arbeitest du?" className="min-w-0 flex-1" />
        {!compact && <TagsInput value={tags} onChange={setTags} className="sm:w-56" />}
        <Button type="submit" variant="primary" icon={<Play className="h-4 w-4 fill-current" />} loading={start.isPending} disabled={!projectId} className={cn(compact && 'justify-center')}>
          Start
        </Button>
      </div>
    </form>
  );
}

/* ═════════════════════════════ Zuletzt verwendet ═════════════════════════════ */

export function RecentList({ limit = 5 }: { limit?: number }) {
  const { data: recent } = useRecent();
  const { start } = useEntryActions();
  const { data: active } = useActiveEntry();
  const items = (recent ?? []).slice(0, limit);
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      {items.map((r, i) => {
        const same = active && active.projectId === r.projectId && active.activityId === r.activityId && (active.description ?? '') === (r.description ?? '');
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

export function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00:00`);
  if (isToday(d)) return 'Heute';
  if (isYesterday(d)) return 'Gestern';
  return format(d, 'EEEE, d. MMMM yyyy', { locale: de });
}

/** Einträge nach Tagen gruppiert, je Tag mit Summe */
export function EntryDays({ entries, compact, empty }: { entries: TtEntry[]; compact?: boolean; empty?: ReactNode }) {
  const [editing, setEditing] = useState<TtEntry | null>(null);
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
        <DaySection key={day} day={day} list={list} compact={compact}>
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
      {dialog}
    </div>
  );
}

function DaySection({ day, list, compact, children }: { day: string; list: TtEntry[]; compact?: boolean; children: ReactNode }) {
  const running = list.find((e) => !e.end);
  const elapsed = useElapsed(running);
  const total = list.reduce((s, e) => s + (e.end ? e.duration : 0), 0) + (running ? elapsed : 0);
  return (
    <section className={cn(!compact && 'overflow-hidden rounded-2xl border border-border bg-surface shadow-card')}>
      <header className={cn('flex items-center justify-between gap-2', compact ? 'px-1 pb-1' : 'border-b border-border bg-surface-2/50 px-4 py-2')}>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{dayLabel(day)}</span>
        <span className="font-mono text-xs font-semibold tabular-nums">{formatDuration(total)}</span>
      </header>
      <div className={cn(!compact && 'divide-y divide-border')}>{children}</div>
    </section>
  );
}

function EntryRow({ e, compact, onEdit, onRestart, onDelete }: { e: TtEntry; compact?: boolean; onEdit: () => void; onRestart: () => void; onDelete: () => void }) {
  const elapsed = useElapsed(e);
  const running = !e.end;
  return (
    <div className={cn('group flex items-center gap-3', compact ? 'rounded-lg px-1 py-1.5 hover:bg-hover' : 'px-4 py-2.5 hover:bg-hover/60')}>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
        <EntryTitle e={e} />
        {(e.description || (!compact && e.tags.length > 0)) && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 pl-[18px]">
            {e.description && <span className={cn('min-w-0 text-xs text-muted', compact ? 'truncate' : 'line-clamp-2')}>{e.description}</span>}
            {!compact && e.tags.length > 0 && <TagList tags={e.tags} />}
          </div>
        )}
      </button>
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
      <span className={cn('w-14 shrink-0 text-right font-mono text-sm tabular-nums', running && 'font-semibold text-primary')}>{formatDuration(running ? elapsed : e.duration)}</span>
      {!running && (
        <IconButton label="Erneut starten" size="icon-sm" onClick={onRestart} className={cn(!compact && 'opacity-60 group-hover:opacity-100')}>
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
  );
}

/* ═════════════════════════════ Eintrag bearbeiten/anlegen ═════════════════════════════ */

/** entry = null → neuer Eintrag (optional mit Vorgabe-Tag) */
export function EntryEditor({ entry, defaultDate, onClose }: { entry: TtEntry | null; defaultDate?: Date; onClose: () => void }) {
  const { save } = useEntryActions();
  const { projects, activities } = useMasterLookup();
  const { data: recent } = useRecent();
  const running = !!entry && !entry.end;

  const initialBegin = entry ? new Date(entry.begin) : (() => {
    const d = defaultDate ? new Date(defaultDate) : new Date();
    if (!defaultDate) d.setHours(d.getHours() - 1);
    else d.setHours(9, 0, 0, 0);
    d.setSeconds(0, 0);
    return d;
  })();

  const [projectId, setProjectId] = useState(entry?.projectId ?? recent?.[0]?.projectId ?? '');
  const [activityId, setActivityId] = useState(entry?.activityId ?? (entry ? '' : (recent?.[0]?.activityId ?? '')));
  const [range, setRange] = useState<TimeRangeValue>(() => ({ begin: initialBegin, duration: running ? null : entry ? entry.duration : 3600 }));
  const [description, setDescription] = useState(entry?.description ?? '');
  const [tags, setTags] = useState((entry?.tags ?? []).join(', '));
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [billableTouched, setBillableTouched] = useState(!!entry);

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
  const valid = !!projectId && !Number.isNaN(begin.getTime()) && (running || (range.duration ?? 0) >= 60);

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
      fixedRate: entry?.fixedRate ?? null,
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
        <Checkbox
          checked={billable}
          onChange={(v) => {
            setBillableTouched(true);
            setBillable(v);
          }}
          label="Abrechenbar"
        />
        {entry?.imported && <p className="text-xs text-muted">Aus Kimai übernommen – ein erneuter Import überschreibt Änderungen an diesem Eintrag.</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
