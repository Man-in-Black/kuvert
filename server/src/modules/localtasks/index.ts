/**
 * Kuvert-eigene Aufgaben: Aufgabenlisten direkt in der Kuvert-Datenbank, unabhängig von
 * Microsoft To Do / Google Tasks. Erscheinen auf der Aufgabenseite als Quelle „Kuvert“
 * (Pseudo-Konto-ID `kuvert`) und merken sich auf Wunsch die Ursprungs-Mail.
 *
 * Abschalten: KUVERT_DISABLED_MODULES=localtasks
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskInput, TaskList, TaskMailRef } from '@kuvert/shared';
import type { DB } from '../../core/db.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { defineModule } from '../../core/module.js';
import type { TasksProvider } from '../../core/providers.js';
import { parse } from '../../routes/util.js';

/** Pseudo-Konto-ID der Quelle (echte Konto-IDs sind UUIDs) */
export const LOCAL_TASKS_SOURCE_ID = 'kuvert';
const DEFAULT_LIST_NAME = 'Aufgaben';
const MAX_LISTS = 100;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

const migrations = [
  {
    id: 'localtasks-001',
    sql: `
      CREATE TABLE local_task_lists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX local_task_lists_user ON local_task_lists(user_id, sort);

      CREATE TABLE local_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        list_id TEXT NOT NULL REFERENCES local_task_lists(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        notes TEXT,
        due TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        importance TEXT NOT NULL DEFAULT 'normal',
        mail_ref_json TEXT,
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX local_tasks_list ON local_tasks(user_id, list_id, completed);
    `,
  },
];

interface ListRow {
  id: string;
  name: string;
  color: string | null;
  is_default: number;
}

interface TaskRow {
  id: string;
  list_id: string;
  title: string;
  notes: string | null;
  due: string | null;
  completed: number;
  completed_at: string | null;
  importance: string;
  mail_ref_json: string | null;
  created_at: string;
  updated_at: string;
}

function toList(r: ListRow): TaskList {
  return { id: r.id, accountId: LOCAL_TASKS_SOURCE_ID, name: r.name, color: r.color ?? undefined, isDefault: !!r.is_default };
}

function toTask(r: TaskRow): Task {
  let mailRef: TaskMailRef | null = null;
  if (r.mail_ref_json) {
    try {
      mailRef = JSON.parse(r.mail_ref_json) as TaskMailRef;
    } catch {
      mailRef = null;
    }
  }
  return {
    id: r.id,
    accountId: LOCAL_TASKS_SOURCE_ID,
    listId: r.list_id,
    title: r.title,
    notes: r.notes ?? undefined,
    due: r.due,
    completed: !!r.completed,
    completedAt: r.completed_at,
    importance: (r.importance as Task['importance']) ?? 'normal',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mailRef,
  };
}

/** Datenzugriff für einen Benutzer */
class LocalTasks implements TasksProvider {
  constructor(
    private db: DB,
    private userId: string,
  ) {}

  private lists(): ListRow[] {
    return this.db
      .prepare('SELECT id, name, color, is_default FROM local_task_lists WHERE user_id = ? ORDER BY is_default DESC, sort, created_at')
      .all(this.userId) as ListRow[];
  }

  /** Jeder Benutzer hat mindestens eine Liste */
  private ensureDefault(): ListRow[] {
    const rows = this.lists();
    if (rows.length) {
      if (!rows.some((r) => r.is_default)) {
        this.db.prepare('UPDATE local_task_lists SET is_default = 1 WHERE id = ?').run(rows[0]!.id);
        rows[0]!.is_default = 1;
      }
      return rows;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO local_task_lists (id, user_id, name, is_default) VALUES (?, ?, ?, 1)').run(id, this.userId, DEFAULT_LIST_NAME);
    return this.lists();
  }

  private requireList(listId: string): ListRow {
    const row = this.db
      .prepare('SELECT id, name, color, is_default FROM local_task_lists WHERE id = ? AND user_id = ?')
      .get(listId, this.userId) as ListRow | undefined;
    if (!row) throw new NotFoundError('Aufgabenliste');
    return row;
  }

  private getTask(listId: string, taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM local_tasks WHERE id = ? AND list_id = ? AND user_id = ?').get(taskId, listId, this.userId) as
      | TaskRow
      | undefined;
    if (!row) throw new NotFoundError('Aufgabe');
    return row;
  }

  async listTaskLists(): Promise<TaskList[]> {
    return this.ensureDefault().map(toList);
  }

  async listTasks(listId: string, opts: { showCompleted?: boolean }): Promise<Task[]> {
    this.requireList(listId);
    const rows = this.db
      .prepare(`SELECT * FROM local_tasks WHERE user_id = ? AND list_id = ? ${opts.showCompleted ? '' : 'AND completed = 0'} ORDER BY created_at`)
      .all(this.userId, listId) as TaskRow[];
    return rows.map(toTask);
  }

  async createTask(listId: string, input: TaskInput): Promise<Task> {
    this.requireList(listId);
    const id = randomUUID();
    const completed = !!input.completed;
    this.db
      .prepare(
        `INSERT INTO local_tasks (id, user_id, list_id, title, notes, due, completed, completed_at, importance, mail_ref_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.userId,
        listId,
        (input.title ?? '').trim(),
        input.notes || null,
        input.due ?? null,
        completed ? 1 : 0,
        completed ? new Date().toISOString() : null,
        input.importance ?? 'normal',
        input.mailRef ? JSON.stringify(input.mailRef) : null,
      );
    return toTask(this.getTask(listId, id));
  }

  async updateTask(listId: string, taskId: string, input: TaskInput): Promise<Task> {
    const cur = this.getTask(listId, taskId);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (input.title !== undefined) set('title', input.title.trim());
    if (input.notes !== undefined) set('notes', input.notes || null);
    if (input.due !== undefined) set('due', input.due);
    if (input.importance !== undefined) set('importance', input.importance);
    if (input.mailRef !== undefined) set('mail_ref_json', input.mailRef ? JSON.stringify(input.mailRef) : null);
    if (input.completed !== undefined && input.completed !== !!cur.completed) {
      set('completed', input.completed ? 1 : 0);
      set('completed_at', input.completed ? new Date().toISOString() : null);
    }
    if (sets.length) {
      sets.push(`updated_at = ${NOW}`);
      this.db.prepare(`UPDATE local_tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, taskId, this.userId);
    }
    return toTask(this.getTask(listId, taskId));
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    this.getTask(listId, taskId);
    this.db.prepare('DELETE FROM local_tasks WHERE id = ? AND user_id = ?').run(taskId, this.userId);
  }

  /* ───────────── Listen verwalten ───────────── */

  createList(name: string): TaskList {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM local_task_lists WHERE user_id = ?').get(this.userId) as { n: number }).n;
    if (count >= MAX_LISTS) throw new BadRequestError(`Höchstens ${MAX_LISTS} Listen möglich`);
    const id = randomUUID();
    this.db.prepare('INSERT INTO local_task_lists (id, user_id, name, sort, is_default) VALUES (?, ?, ?, ?, ?)').run(id, this.userId, name, count, count ? 0 : 1);
    return toList(this.requireList(id));
  }

  renameList(listId: string, name: string): TaskList {
    this.requireList(listId);
    this.db.prepare('UPDATE local_task_lists SET name = ? WHERE id = ? AND user_id = ?').run(name, listId, this.userId);
    return toList(this.requireList(listId));
  }

  /** Löscht die Liste samt Aufgaben; war es die Standardliste, wird die nächste Standard */
  deleteList(listId: string): void {
    this.requireList(listId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM local_tasks WHERE list_id = ? AND user_id = ?').run(listId, this.userId);
      this.db.prepare('DELETE FROM local_task_lists WHERE id = ? AND user_id = ?').run(listId, this.userId);
    })();
    this.ensureDefault();
  }
}

const listName = z.object({ name: z.string().trim().min(1, 'Name fehlt').max(200) });

export default defineModule({
  id: 'localtasks',
  name: 'Kuvert-Aufgaben',
  description: 'Eigene Aufgabenlisten in Kuvert, auch ohne Microsoft To Do oder Google Tasks; Aufgaben aus E-Mails',
  features: ['localTasks'],
  migrations,

  routes(app, ctx) {
    const store = (userId: string) => new LocalTasks(ctx.db, userId);

    app.post('/lists', async (req) => store(req.user.id).createList(parse(listName, req.body).name));

    app.patch<{ Params: { id: string } }>('/lists/:id', async (req) => store(req.user.id).renameList(req.params.id, parse(listName, req.body).name));

    app.delete<{ Params: { id: string } }>('/lists/:id', async (req) => {
      store(req.user.id).deleteList(req.params.id);
      return { ok: true };
    });
  },

  init(ctx) {
    ctx.hooks.taskSources.push({
      id: LOCAL_TASKS_SOURCE_ID,
      name: 'Kuvert',
      manageable: true,
      available: () => true,
      provider: (userId) => new LocalTasks(ctx.db, userId),
    });
  },
});
