import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, CheckSquare, Circle, CircleCheck, ListTodo, Menu, Plus, Star, Trash2, X } from 'lucide-react';
import type { AccountInfo, Task, TaskInput, TaskList } from '@kuvert/shared';
import { Button, Checkbox, ColorDot, EmptyState, Field, IconButton, Input, Select, SidebarSheet, Spinner, Switch, Textarea, useConfirm } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import {
  createTask,
  deleteTask,
  dueDate,
  dueInfo,
  listKey,
  sortTasks,
  toDueValue,
  todayString,
  updateTask,
  useAllOpenTasks,
  useTaskLists,
  useTasks,
} from './api';

type View = { kind: 'due' } | { kind: 'list'; accountId: string; listId: string };

const VIEW_KEY = 'kuvert.tasks.view';
const SHOW_DONE_KEY = 'kuvert.tasks.showCompleted';

function loadView(): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as View | null;
    return v && (v.kind === 'due' || (v.kind === 'list' && v.accountId && v.listId)) ? v : null;
  } catch {
    return null;
  }
}

export default function TasksPage() {
  const qc = useQueryClient();
  const accountMap = useAccountMap();
  const { data: listData, isLoading: listsLoading } = useTaskLists();
  const lists = listData?.lists ?? [];
  const [view, setViewState] = useState<View | null>(loadView);
  const [showCompleted, setShowCompletedState] = useState(() => localStorage.getItem(SHOW_DONE_KEY) === '1');
  const [selected, setSelected] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);

  // Mobil: Listen als Schublade
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  const setView = (v: View) => {
    setViewState(v);
    setSelected(null);
    setNavOpen(false);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    } catch {
      /* egal */
    }
  };
  const setShowCompleted = (v: boolean) => {
    setShowCompletedState(v);
    try {
      localStorage.setItem(SHOW_DONE_KEY, v ? '1' : '0');
    } catch {
      /* egal */
    }
  };

  // Standardansicht: gespeicherte Liste, sonst Standardliste
  useEffect(() => {
    if (!lists.length) return;
    const valid = view && (view.kind === 'due' || lists.some((l) => l.accountId === view.accountId && l.id === view.listId));
    if (!valid) {
      const def = lists.find((l) => l.isDefault) ?? lists[0]!;
      setView({ kind: 'list', accountId: def.accountId, listId: def.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.length]);

  const activeList = view?.kind === 'list' ? lists.find((l) => l.accountId === view.accountId && l.id === view.listId) : undefined;
  const listQuery = useTasks(activeList?.accountId, activeList?.id, showCompleted);
  const dueQueries = useAllOpenTasks(lists, view?.kind === 'due');

  const tasks: Task[] = useMemo(() => {
    if (view?.kind === 'due') {
      const today = todayString();
      return sortTasks(
        dueQueries
          .flatMap((q, i) => (q.data ?? []).map((t) => ({ ...t, accountId: lists[i]!.accountId, listId: t.listId || lists[i]!.id })))
          .filter((t) => {
            const d = dueDate(t);
            return !t.completed && d !== null && d <= today;
          }),
      );
    }
    return sortTasks((listQuery.data ?? []).map((t) => ({ ...t, accountId: t.accountId || activeList?.accountId || '', listId: t.listId || activeList?.id || '' })));
  }, [view, dueQueries, listQuery.data, lists, activeList]);

  const loading = view?.kind === 'due' ? dueQueries.some((q) => q.isLoading) : listQuery.isLoading;
  const taskKey = (t: Task) => `${t.accountId}|${t.listId}|${t.id}`;
  const current = tasks.find((t) => taskKey(t) === selected) ?? null;

  const grouped = useMemo(() => {
    const m = new Map<string, TaskList[]>();
    for (const l of lists) m.set(l.accountId, [...(m.get(l.accountId) ?? []), l]);
    return [...m.entries()];
  }, [lists]);

  const invalidateList = (accountId: string, listId: string) => qc.invalidateQueries({ queryKey: ['tasks', 'items', accountId, listId] });

  const toggle = async (t: Task) => {
    const completed = !t.completed;
    // Optimistisch in allen Caches dieser Liste aktualisieren
    qc.setQueriesData<Task[]>({ queryKey: ['tasks', 'items', t.accountId, t.listId] }, (old) =>
      old?.map((x) => (x.id === t.id ? { ...x, completed, completedAt: completed ? new Date().toISOString() : null } : x)),
    );
    try {
      await updateTask(t.accountId, t.listId, t.id, { completed });
      if (completed) toast.success('Aufgabe erledigt', { duration: 2000 });
      setTimeout(() => void invalidateList(t.accountId, t.listId), 700);
    } catch (err) {
      toast.error(errorMessage(err));
      void invalidateList(t.accountId, t.listId);
    }
  };

  const toggleImportant = async (t: Task) => {
    const importance = t.importance === 'high' ? 'normal' : 'high';
    qc.setQueriesData<Task[]>({ queryKey: ['tasks', 'items', t.accountId, t.listId] }, (old) => old?.map((x) => (x.id === t.id ? { ...x, importance } : x)));
    try {
      await updateTask(t.accountId, t.listId, t.id, { importance });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void invalidateList(t.accountId, t.listId);
    }
  };

  const add = async () => {
    const title = newTitle.trim();
    if (!title || !activeList) return;
    setAdding(true);
    try {
      await createTask(activeList.accountId, activeList.id, { title, due: toDueValue(newDue || null) });
      setNewTitle('');
      setNewDue('');
      await invalidateList(activeList.accountId, activeList.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const noLists = !listsLoading && lists.length === 0;
  const title = view?.kind === 'due' ? 'Fällig & überfällig' : (activeList?.name ?? 'Aufgaben');
  const openCount = tasks.filter((t) => !t.completed).length;

  const sidebarContent = (
    <nav className="min-h-0 flex-1 overflow-auto p-2">
      <button
        type="button"
        onClick={() => setView({ kind: 'due' })}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover',
          view?.kind === 'due' && 'bg-primary-soft text-primary hover:bg-primary-soft',
        )}
      >
        <CalendarClock className="h-4 w-4" /> Fällig & überfällig
      </button>
      {listsLoading && (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      )}
      {grouped.map(([accId, ls]) => {
        const acc = accountMap.get(accId);
        return (
          <div key={accId} className="mt-3">
            <div className="flex items-center gap-1.5 px-2 pb-1">
              <ColorDot color={acc?.color} />
              <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{acc?.name ?? 'Konto'}</span>
            </div>
            {ls.map((l) => {
              const active = view?.kind === 'list' && view.accountId === l.accountId && view.listId === l.id;
              return (
                <button
                  key={listKey(l)}
                  type="button"
                  onClick={() => setView({ kind: 'list', accountId: l.accountId, listId: l.id })}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover',
                    active && 'bg-primary-soft text-primary hover:bg-primary-soft',
                  )}
                >
                  <ListTodo className="h-4 w-4 shrink-0" style={l.color ? { color: l.color } : undefined} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      {(listData?.errors ?? []).map((e) => (
        <div key={e.accountId} className="mt-2 flex gap-1.5 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger" title={e.message}>
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">
            <span className="font-medium">{e.account}:</span> {e.message}
          </span>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="relative flex h-full overflow-hidden">
      {!isMobile && <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">{sidebarContent}</aside>}

      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        {noLists ? (
          <EmptyState icon={<CheckSquare />} title="Keine Aufgabenlisten">
            Verbinde ein Konto mit Aufgaben (Microsoft To Do, Google Tasks, CalDAV/Nextcloud) in den{' '}
            <Link to="/settings/accounts" className="text-primary hover:underline">
              Kontoeinstellungen
            </Link>
            .
          </EmptyState>
        ) : (
          <>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 md:gap-3 md:px-5">
              {isMobile && (
                <IconButton label="Aufgabenlisten" size="icon-sm" onClick={() => setNavOpen(true)}>
                  <Menu className="h-4 w-4" />
                </IconButton>
              )}
              <h1 className="min-w-0 truncate text-base font-semibold md:text-lg">{title}</h1>
              <span className="shrink-0 text-sm text-muted">{openCount} offen</span>
              {(listQuery.isFetching || dueQueries.some((q) => q.isFetching)) && <Spinner className="h-4 w-4 shrink-0" />}
              <div className="flex-1" />
              {view?.kind === 'list' && <Switch checked={showCompleted} onChange={setShowCompleted} label={isMobile ? 'Erledigte' : 'Erledigte anzeigen'} />}
            </header>

            {view?.kind === 'list' && activeList && (
              <form
                className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5 md:px-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void add();
                }}
              >
                {!isMobile && <Plus className="h-4 w-4 text-muted" />}
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Aufgabe hinzufügen …"
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted"
                />
                <Input type="date" className="h-8 max-w-36 md:max-w-40" value={newDue} onChange={(e) => setNewDue(e.target.value)} title="Fällig am" />
                {isMobile ? (
                  <Button type="submit" size="icon-sm" variant="primary" aria-label="Hinzufügen" title="Hinzufügen" icon={<Plus className="h-4 w-4" />} loading={adding} disabled={!newTitle.trim()} />
                ) : (
                  <Button type="submit" size="sm" variant="primary" loading={adding} disabled={!newTitle.trim()}>
                    Hinzufügen
                  </Button>
                )}
              </form>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="flex justify-center p-8">
                  <Spinner />
                </div>
              ) : listQuery.error && view?.kind === 'list' ? (
                <div className="p-5 text-sm text-danger">{errorMessage(listQuery.error)}</div>
              ) : tasks.length === 0 ? (
                <EmptyState icon={<CircleCheck />} title={view?.kind === 'due' ? 'Nichts fällig' : 'Keine Aufgaben'}>
                  {view?.kind === 'due' ? 'Alle fälligen Aufgaben sind erledigt.' : 'Lege oben eine neue Aufgabe an.'}
                </EmptyState>
              ) : (
                <ul className="mx-auto max-w-4xl py-2">
                  {tasks.map((t) => (
                    <TaskRow
                      key={taskKey(t)}
                      task={t}
                      active={selected === taskKey(t)}
                      account={view?.kind === 'due' ? accountMap.get(t.accountId) : undefined}
                      listName={view?.kind === 'due' ? lists.find((l) => l.accountId === t.accountId && l.id === t.listId)?.name : undefined}
                      onToggle={() => void toggle(t)}
                      onImportant={() => void toggleImportant(t)}
                      onOpen={() => setSelected(taskKey(t))}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <SidebarSheet open={isMobile && navOpen} onClose={() => setNavOpen(false)}>
        {sidebarContent}
      </SidebarSheet>

      {current && <TaskDrawer key={taskKey(current)} task={current} onClose={() => setSelected(null)} onChanged={() => invalidateList(current.accountId, current.listId)} />}
    </div>
  );
}

function TaskRow({
  task: t,
  active,
  account,
  listName,
  onToggle,
  onImportant,
  onOpen,
}: {
  task: Task;
  active: boolean;
  account?: AccountInfo;
  listName?: string;
  onToggle: () => void;
  onImportant: () => void;
  onOpen: () => void;
}) {
  const due = dueInfo(t);
  return (
    <li
      className={cn(
        'group mx-3 my-1 flex cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-2.5 shadow-sm hover:border-border',
        active && 'border-primary/40 ring-1 ring-primary/20',
      )}
      onClick={onOpen}
    >
      <button
        type="button"
        aria-label={t.completed ? 'Als offen markieren' : 'Als erledigt markieren'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn('mt-0.5 shrink-0 rounded-full transition-colors', t.completed ? 'text-success' : 'text-muted hover:text-primary')}
      >
        {t.completed ? <CircleCheck className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm', t.completed && 'text-muted line-through')}>{t.title || '(Ohne Titel)'}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          {due && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
                due.tone === 'overdue' && 'bg-danger/10 font-medium text-danger',
                due.tone === 'today' && 'bg-primary-soft font-medium text-primary',
                due.tone === 'soon' && 'bg-warning/10 text-warning',
                due.tone === 'normal' && 'bg-surface-2',
              )}
            >
              <CalendarClock className="h-3 w-3" />
              {due.label}
            </span>
          )}
          {account && (
            <span className="inline-flex items-center gap-1">
              <ColorDot color={account.color} className="h-2 w-2" />
              {listName ?? account.name}
            </span>
          )}
          {t.notes && <span className="min-w-0 max-w-md truncate">{t.notes.replace(/\s+/g, ' ')}</span>}
        </div>
      </div>
      <button
        type="button"
        aria-label="Wichtig"
        onClick={(e) => {
          e.stopPropagation();
          onImportant();
        }}
        className={cn('mt-0.5 shrink-0', t.importance === 'high' ? 'text-warning' : 'text-muted/40 opacity-0 hover:text-warning group-hover:opacity-100')}
      >
        <Star className={cn('h-4 w-4', t.importance === 'high' && 'fill-current')} />
      </button>
    </li>
  );
}

function TaskDrawer({ task, onClose, onChanged }: { task: Task; onClose: () => void; onChanged: () => void }) {
  const { confirm, dialog } = useConfirm();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [due, setDue] = useState(dueDate(task) ?? '');
  const [importance, setImportance] = useState<NonNullable<Task['importance']>>(task.importance ?? 'normal');
  const [completed, setCompleted] = useState(task.completed);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);

  const save = async () => {
    const patch: TaskInput = {};
    if (title.trim() !== task.title) patch.title = title.trim();
    if (notes !== (task.notes ?? '')) patch.notes = notes;
    if (due !== (dueDate(task) ?? '')) patch.due = toDueValue(due || null);
    if (importance !== (task.importance ?? 'normal')) patch.importance = importance;
    if (completed !== task.completed) patch.completed = completed;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setBusy('save');
    try {
      await updateTask(task.accountId, task.listId, task.id, patch);
      toast.success('Aufgabe gespeichert');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await confirm(`Aufgabe „${task.title}“ löschen?`, { danger: true }))) return;
    setBusy('delete');
    try {
      await deleteTask(task.accountId, task.listId, task.id);
      toast.success('Aufgabe gelöscht');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[380px] flex-col border-l border-border bg-surface shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold">Aufgabe</h2>
        <IconButton label="Schließen" size="icon-sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <form
        className="min-h-0 flex-1 space-y-4 overflow-auto p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Titel">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Checkbox checked={completed} onChange={setCompleted} label="Erledigt" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fällig am">
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="Wichtigkeit">
            <Select value={importance} onChange={(e) => setImportance(e.target.value as typeof importance)}>
              <option value="low">Niedrig</option>
              <option value="normal">Normal</option>
              <option value="high">Hoch</option>
            </Select>
          </Field>
        </div>
        <Field label="Notizen">
          <Textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {task.completedAt && <div className="text-xs text-muted">Erledigt am {new Date(task.completedAt).toLocaleString('de-DE')}</div>}
        {task.updatedAt && <div className="text-xs text-muted">Zuletzt geändert {new Date(task.updatedAt).toLocaleString('de-DE')}</div>}
        <button type="submit" className="hidden" />
      </form>
      <div className="flex justify-between gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} loading={busy === 'delete'} onClick={remove}>
          Löschen
        </Button>
        <div className="flex gap-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy === 'save'} onClick={save}>
            Speichern
          </Button>
        </div>
      </div>
      {dialog}
    </aside>
  );
}
