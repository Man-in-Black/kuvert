/** Datenzugriff für Aufgaben. Alle Query-Keys beginnen mit 'tasks'. */
import { useQueries, useQuery } from '@tanstack/react-query';
import { format, isBefore, isToday, isTomorrow, startOfDay } from 'date-fns';
import { de } from 'date-fns/locale';
import type { Task, TaskInput, TaskList } from '@kuvert/shared';
import { api } from '@/lib/api';

export interface AccountError {
  accountId: string;
  account: string;
  message: string;
}

export const listKey = (l: { accountId: string; id: string }) => `${l.accountId}|${l.id}`;
export const itemsKey = (accountId: string, listId: string, showCompleted: boolean) => ['tasks', 'items', accountId, listId, showCompleted] as const;

export function useTaskLists() {
  return useQuery({
    queryKey: ['tasks', 'lists'],
    queryFn: () => api<{ lists: TaskList[]; errors: AccountError[] }>('/tasks/lists'),
    staleTime: 5 * 60_000,
  });
}

function fetchTasks(accountId: string, listId: string, showCompleted: boolean) {
  return api<Task[]>('/tasks', { query: { accountId, listId, showCompleted } });
}

export function useTasks(accountId: string | undefined, listId: string | undefined, showCompleted: boolean) {
  return useQuery({
    queryKey: itemsKey(accountId ?? '', listId ?? '', showCompleted),
    queryFn: () => fetchTasks(accountId!, listId!, showCompleted),
    enabled: !!accountId && !!listId,
    staleTime: 60_000,
  });
}

/** Offene Aufgaben aller Listen (für die Ansicht "Fällig") */
export function useAllOpenTasks(lists: TaskList[], enabled: boolean) {
  return useQueries({
    queries: lists.map((l) => ({
      queryKey: itemsKey(l.accountId, l.id, false),
      queryFn: () => fetchTasks(l.accountId, l.id, false),
      enabled,
      staleTime: 60_000,
    })),
  });
}

export function createTask(accountId: string, listId: string, task: TaskInput) {
  return api<Task>(`/tasks/accounts/${encodeURIComponent(accountId)}`, { method: 'POST', body: { listId, task } });
}

export function updateTask(accountId: string, listId: string, taskId: string, task: TaskInput) {
  return api<Task>(`/tasks/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: { listId, taskId, task } });
}

export function deleteTask(accountId: string, listId: string, taskId: string) {
  return api(`/tasks/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', query: { listId, taskId } });
}

/* ───────────── Fälligkeit ───────────── */

/** YYYY-MM-DD aus dem Fälligkeitswert (Anbieter speichern Datum meist als Mitternacht UTC) */
export function dueDate(t: Pick<Task, 'due'>): string | null {
  if (!t.due) return null;
  const m = t.due.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

export function toDueValue(date: string | null | undefined): string | null {
  return date ? `${date}T00:00:00.000Z` : null;
}

export function dueInfo(t: Pick<Task, 'due' | 'completed'>): { label: string; tone: 'overdue' | 'today' | 'soon' | 'normal' } | null {
  const d = dueDate(t);
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(y!, m! - 1, day!);
  if (isToday(date)) return { label: 'Heute', tone: 'today' };
  if (isTomorrow(date)) return { label: 'Morgen', tone: 'soon' };
  const label = format(date, date.getFullYear() === new Date().getFullYear() ? 'EEE, d. MMM' : 'd. MMM yyyy', { locale: de });
  if (!t.completed && isBefore(date, startOfDay(new Date()))) return { label, tone: 'overdue' };
  return { label, tone: 'normal' };
}

export function todayString(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function sortTasks(tasks: Task[]): Task[] {
  const imp = (t: Task) => (t.importance === 'high' ? 0 : t.importance === 'low' ? 2 : 1);
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const da = dueDate(a) ?? '9999-99-99';
    const db = dueDate(b) ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    if (imp(a) !== imp(b)) return imp(a) - imp(b);
    return a.title.localeCompare(b.title, 'de');
  });
}
