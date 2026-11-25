import type { FastifyRequest } from 'fastify';
import type { AuditEntry } from '@kuvert/shared';
import { getDb } from './db.js';

/**
 * Audit-Log für sicherheitsrelevante Vorgänge (Login, 2FA, Admin-Aktionen,
 * API-Tokens, Konten). Einsehbar im Admin-Bereich.
 */
export const audit = {
  log(action: string, opts: { req?: FastifyRequest; actorId?: string | null; userId?: string | null; details?: Record<string, unknown> } = {}) {
    try {
      const actor = opts.actorId !== undefined ? opts.actorId : ((opts.req as { user?: { id: string } } | undefined)?.user?.id ?? null);
      getDb()
        .prepare('INSERT INTO audit_log (action, actor_id, user_id, ip, details_json) VALUES (?, ?, ?, ?, ?)')
        .run(action, actor, opts.userId ?? actor, opts.req?.ip ?? null, opts.details ? JSON.stringify(opts.details) : null);
    } catch {
      /* Audit darf nie den eigentlichen Vorgang verhindern */
    }
  },

  list(q: { limit?: number; offset?: number; userId?: string; action?: string } = {}): { items: AuditEntry[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.userId) {
      where.push('(a.user_id = ? OR a.actor_id = ?)');
      args.push(q.userId, q.userId);
    }
    if (q.action) {
      where.push('a.action LIKE ?');
      args.push(`${q.action}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log a ${w}`).get(...args) as { n: number }).n;
    const rows = getDb()
      .prepare(
        `SELECT a.*, ua.email AS actor_email, uu.email AS user_email FROM audit_log a
         LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users uu ON uu.id = a.user_id
         ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(q.limit ?? 100, 500), q.offset ?? 0) as {
      id: number;
      created_at: string;
      action: string;
      actor_id: string | null;
      actor_email: string | null;
      user_id: string | null;
      user_email: string | null;
      ip: string | null;
      details_json: string | null;
    }[];
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        action: r.action,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        userId: r.user_id,
        userEmail: r.user_email,
        ip: r.ip,
        details: r.details_json ? JSON.parse(r.details_json) : null,
      })),
    };
  },

  /** Einträge älter als n Tage entfernen */
  prune(days = 365) {
    getDb().prepare(`DELETE FROM audit_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).run(`-${days} days`);
  },
};
