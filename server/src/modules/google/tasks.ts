/**
 * Google Tasks (Tasks API v1).
 */
import type { Task, TaskInput, TaskList } from '@kuvert/shared';
import type { TasksProvider } from '../../core/providers.js';
import { gurl, type GoogleClient } from './client.js';

const BASE = 'https://tasks.googleapis.com/tasks/v1';

interface GTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
  completed?: string;
  updated?: string;
  parent?: string;
  etag?: string;
  deleted?: boolean;
  hidden?: boolean;
}

/** Google speichert nur das Datum der Fälligkeit (Uhrzeit wird ignoriert). */
function toDue(due: string | null | undefined): string | null | undefined {
  if (due === undefined) return undefined;
  if (!due) return null;
  return `${due.slice(0, 10)}T00:00:00.000Z`;
}

export class GoogleTasksProvider implements TasksProvider {
  constructor(private g: GoogleClient) {}

  private listUrl(listId: string, suffix = '') {
    return `${BASE}/lists/${encodeURIComponent(listId)}/tasks${suffix}`;
  }

  async listTaskLists(): Promise<TaskList[]> {
    const lists = await this.g.paged<{ id: string; title: string }, { items?: { id: string; title: string }[]; nextPageToken?: string }>(
      (pageToken) => gurl(`${BASE}/users/@me/lists`, { maxResults: 100, pageToken }),
      (r) => r.items,
    );
    return lists.map((l, i) => ({ id: l.id, accountId: this.g.accountId, name: l.title, isDefault: i === 0 }));
  }

  private toTask(t: GTask, listId: string): Task {
    return {
      id: t.id,
      accountId: this.g.accountId,
      listId,
      title: t.title ?? '',
      notes: t.notes,
      due: t.due ? t.due.slice(0, 10) : null,
      completed: t.status === 'completed',
      completedAt: t.completed ?? null,
      updatedAt: t.updated,
      parentId: t.parent ?? null,
      etag: t.etag,
    };
  }

  async listTasks(listId: string, opts: { showCompleted?: boolean }): Promise<Task[]> {
    const items = await this.g.paged<GTask, { items?: GTask[]; nextPageToken?: string }>(
      (pageToken) =>
        gurl(this.listUrl(listId), {
          maxResults: 100,
          pageToken,
          showCompleted: !!opts.showCompleted,
          showHidden: !!opts.showCompleted,
        }),
      (r) => r.items,
      20,
    );
    return items.filter((t) => !t.deleted).map((t) => this.toTask(t, listId));
  }

  private toBody(input: TaskInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.notes !== undefined) body.notes = input.notes;
    const due = toDue(input.due);
    if (due !== undefined) body.due = due;
    if (input.completed !== undefined) {
      body.status = input.completed ? 'completed' : 'needsAction';
      if (!input.completed) body.completed = null;
    }
    return body;
  }

  async createTask(listId: string, input: TaskInput): Promise<Task> {
    const t = await this.g.json<GTask>(this.listUrl(listId), { method: 'POST', body: { title: '', ...this.toBody(input) } });
    return this.toTask(t, listId);
  }

  async updateTask(listId: string, taskId: string, input: TaskInput): Promise<Task> {
    const t = await this.g.json<GTask>(this.listUrl(listId, `/${encodeURIComponent(taskId)}`), { method: 'PATCH', body: this.toBody(input) });
    return this.toTask(t, listId);
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.g.fetch(this.listUrl(listId, `/${encodeURIComponent(taskId)}`), { method: 'DELETE' });
  }
}
