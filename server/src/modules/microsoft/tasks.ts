/**
 * Aufgaben über Microsoft To Do (Graph /me/todo).
 */
import type { Task, TaskInput, TaskList } from '@kuvert/shared';
import type { AccountContext } from '../../core/module.js';
import type { TasksProvider } from '../../core/providers.js';
import { enc, fromGraphDateTime, qs, stripHtml, type GraphClient } from './graph.js';

interface GTodoList {
  id: string;
  displayName: string;
  wellknownListName?: 'none' | 'defaultList' | 'flaggedEmails' | 'unknownFutureValue';
}

interface GTodoTask {
  id: string;
  title?: string;
  body?: { content?: string; contentType?: 'text' | 'html' };
  dueDateTime?: { dateTime?: string; timeZone?: string } | null;
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  completedDateTime?: { dateTime?: string; timeZone?: string } | null;
  importance?: 'low' | 'normal' | 'high';
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  '@odata.etag'?: string;
}

/** Datum für To-Do-Fälligkeiten (nur Tag, ohne Uhrzeit) */
function dueDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value.slice(0, 10) : d.toISOString().slice(0, 10);
}

export class GraphTasksProvider implements TasksProvider {
  constructor(
    private graph: GraphClient,
    private ctx: AccountContext,
  ) {}

  async listTaskLists(): Promise<TaskList[]> {
    const lists = await this.graph.all<GTodoList>('/me/todo/lists?$top=100');
    return lists
      .filter((l) => l.wellknownListName !== 'flaggedEmails')
      .map((l) => ({
        id: l.id,
        accountId: this.ctx.account.id,
        name: l.wellknownListName === 'defaultList' && /^tasks$/i.test(l.displayName) ? 'Aufgaben' : l.displayName,
        isDefault: l.wellknownListName === 'defaultList',
      }));
  }

  private toTask(t: GTodoTask, listId: string): Task {
    const notes = t.body?.content ? (t.body.contentType === 'html' ? stripHtml(t.body.content) : t.body.content) : undefined;
    return {
      id: t.id,
      accountId: this.ctx.account.id,
      listId,
      title: t.title ?? '',
      notes: notes || undefined,
      due: t.dueDateTime?.dateTime ? t.dueDateTime.dateTime.slice(0, 10) : null,
      completed: t.status === 'completed',
      completedAt: t.completedDateTime ? fromGraphDateTime(t.completedDateTime) || null : null,
      importance: t.importance,
      createdAt: t.createdDateTime,
      updatedAt: t.lastModifiedDateTime,
      etag: t['@odata.etag'],
    };
  }

  private toGraph(input: TaskInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.notes !== undefined) body.body = { content: input.notes, contentType: 'text' };
    if (input.due !== undefined) body.dueDateTime = input.due ? { dateTime: `${dueDate(input.due)}T00:00:00`, timeZone: 'UTC' } : null;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.completed !== undefined) body.status = input.completed ? 'completed' : 'notStarted';
    return body;
  }

  async listTasks(listId: string, opts: { showCompleted?: boolean }): Promise<Task[]> {
    const url = `/me/todo/lists/${enc(listId)}/tasks${qs({ $top: 100, $filter: opts.showCompleted ? undefined : "status ne 'completed'" })}`;
    const tasks = await this.graph.all<GTodoTask>(url, undefined, 2000);
    return tasks.map((t) => this.toTask(t, listId));
  }

  async createTask(listId: string, input: TaskInput): Promise<Task> {
    const t = await this.graph.json<GTodoTask>(`/me/todo/lists/${enc(listId)}/tasks`, {
      method: 'POST',
      body: { title: input.title ?? '', ...this.toGraph(input) },
    });
    return this.toTask(t, listId);
  }

  async updateTask(listId: string, taskId: string, input: TaskInput): Promise<Task> {
    const t = await this.graph.json<GTodoTask>(`/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}`, {
      method: 'PATCH',
      body: this.toGraph(input),
    });
    return this.toTask(t, listId);
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.graph.raw(`/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}`, { method: 'DELETE' });
  }
}
