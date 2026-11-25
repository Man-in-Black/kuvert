/**
 * KI-Triage: ordnet neue Mails im Posteingang automatisch nach Priorität
 * (hoch/normal/niedrig) und Kategorie ein – über dasselbe Sprachmodell wie der
 * KI-Assistent (Ollama oder OpenAI-kompatibel).
 *
 *  - Hook `newMail`     → neue Mails kommen in die Warteschlange (nur wenn der Benutzer es eingeschaltet hat)
 *  - Hook `messageList` → Listen (Ordner, gemeinsamer Posteingang, Suche) erhalten `triage`
 *  - Hook `messageView` → ebenso die geöffnete Nachricht
 *  - Ereignis `mail.triage` → Browser aktualisiert die Liste ohne Neuladen (auch als Webhook)
 */
import { z } from 'zod';
import {
  getTriageSettings,
  TRIAGE_FALLBACK_CATEGORY,
  type MessageSummary,
  type TriageFailure,
  type TriageInfo,
  type TriageRunResult,
  type TriageStatus,
} from '@kuvert/shared';
import { config } from '../../config.js';
import { BadRequestError } from '../../core/errors.js';
import { defineModule, type ModuleContext } from '../../core/module.js';
import { users } from '../../core/users.js';
import { parse } from '../../routes/util.js';
import { MAX_ATTEMPTS, TriageQueue } from './engine.js';
import { failedStore, migrations, refKey, triageStore } from './store.js';

let queue: TriageQueue | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

const RETENTION_DAYS = Math.max(7, Number(process.env.AI_TRIAGE_RETENTION_DAYS) || 180);

function attach<T extends MessageSummary>(userId: string, items: T[], defaults: { accountId?: string; folderId?: string } = {}): T[] {
  const refs = items.map((m) => ({
    accountId: m.accountId || defaults.accountId || '',
    folderId: m.folderId || defaults.folderId || '',
    id: m.id,
    messageIdHeader: m.messageIdHeader,
  }));
  const found = triageStore.lookup(userId, refs);
  if (!found.size) return items;
  return items.map((m, i) => {
    const r = refs[i]!;
    const t = found.get(refKey(r.accountId, r.folderId, r.id));
    return t ? { ...m, triage: t } : m;
  });
}

const refSchema = z.object({ accountId: z.string().min(1), folderId: z.string(), id: z.string().min(1), messageIdHeader: z.string().optional() });

export default defineModule({
  id: 'triage',
  name: 'KI-Triage',
  description: 'Priorität und Kategorie für neue Mails per Sprachmodell',
  /** Nur mit aktiviertem KI-Backend (Admin-Bereich oder .env) */
  get features() {
    return config.ai.enabled ? ['triage'] : [];
  },
  migrations,

  init(ctx: ModuleContext) {
    const log = ctx.log.child({ module: 'triage' });
    queue = new TriageQueue(ctx, log);
    const q = queue;

    ctx.hooks.newMail.push(({ userId, accountId, folderId, messages }) => {
      if (!config.ai.enabled) return;
      const s = getTriageSettings(users.getSettings(userId));
      if (!s.enabled || s.excludedAccounts.includes(accountId)) return;
      // Nur einreihen – der newMail-Hook darf die Benachrichtigung nicht aufhalten
      q.enqueue(messages.map((m) => ({ userId, accountId, folderId: m.folderId || folderId, messageId: m.id })));
    });

    ctx.hooks.messageList.push((c, items) => attach(c.userId, items, c));

    ctx.hooks.messageView.push(async (c, msg) => {
      const t = triageStore.lookup(c.userId, [{ accountId: c.accountId, folderId: c.folderId, id: msg.id, messageIdHeader: msg.messageIdHeader }]);
      const triage = t.values().next().value;
      return triage ? { ...msg, triage } : msg;
    });

    ctx.bus.internal.on('account.deleted', (acc) => {
      q.dropAccount(acc.id);
      triageStore.removeAccount(acc.id);
      failedStore.removeAccount(acc.id);
    });

    const prune = () => {
      try {
        const n = triageStore.prune(RETENTION_DAYS) + failedStore.prune(RETENTION_DAYS);
        if (n) log.info({ removed: n }, 'Alte Triage-Einträge entfernt');
      } catch (err) {
        log.warn({ err }, 'Triage-Aufräumen fehlgeschlagen');
      }
    };
    setTimeout(prune, 60_000).unref();
    pruneTimer = setInterval(prune, 24 * 3600_000);
    pruneTimer.unref();
  },

  shutdown() {
    queue?.stop();
    if (pruneTimer) clearInterval(pruneTimer);
  },

  routes(app, ctx) {
    const requireAi = () => {
      if (!config.ai.enabled) throw new BadRequestError('Die KI ist serverseitig deaktiviert');
    };

    app.get('/status', async (req): Promise<TriageStatus & { stats: ReturnType<typeof triageStore.stats> }> => ({
      available: config.ai.enabled,
      backend: config.ai.backend,
      queued: queue?.queuedFor(req.user.id) ?? 0,
      ...(queue?.retryInfo(req.user.id) ?? {}),
      maxAttempts: MAX_ATTEMPTS,
      failed: failedStore.count(req.user.id),
      stats: triageStore.stats(req.user.id),
    }));

    /** Endgültig fehlgeschlagene Einordnungen (neueste zuerst) */
    app.get('/failed', async (req): Promise<TriageFailure[]> => failedStore.list(req.user.id, 200));

    /** Fehlgeschlagene erneut einreihen; Erfolg bzw. erneuter Fehlschlag aktualisiert die Liste */
    app.post('/failed/retry', async (req): Promise<TriageRunResult> => {
      requireAi();
      const failed = failedStore.list(req.user.id);
      const queued = queue!.enqueue(
        failed.map((f) => ({ userId: req.user.id, accountId: f.accountId, folderId: f.folderId, messageId: f.messageId, manual: true })),
      );
      return { queued, skipped: failed.length - queued };
    });

    /** Liste fehlgeschlagener Einordnungen leeren */
    app.post('/failed/clear', async (req) => ({ removed: failedStore.clear(req.user.id) }));

    /** Stopp: wartende Einordnungen verwerfen, laufende abbrechen, Modell entladen */
    app.post('/stop', async (req) => ({ stopped: queue?.cancelUser(req.user.id) ?? 0 }));

    /** Einzelne Nachrichten (neu) einordnen – z. B. „Mit KI einordnen“ in der Leseansicht */
    app.post('/run', async (req): Promise<TriageRunResult> => {
      requireAi();
      const body = parse(z.object({ accountId: z.string().min(1), folderId: z.string(), ids: z.array(z.string().min(1)).min(1).max(200) }), req.body);
      ctx.accounts.require(req.user.id, body.accountId, 'mail');
      const queued = queue!.enqueue(
        body.ids.map((id) => ({ userId: req.user.id, accountId: body.accountId, folderId: body.folderId, messageId: id, manual: true, overwrite: true })),
      );
      return { queued, skipped: body.ids.length - queued };
    });

    /** Die neuesten Mails im Posteingang aller (nicht ausgenommenen) Konten einordnen */
    app.post('/inbox', async (req): Promise<TriageRunResult> => {
      requireAi();
      const body = parse(z.object({ limit: z.number().int().min(1).max(200).default(30), accountId: z.string().optional() }), req.body ?? {});
      const s = getTriageSettings(users.getSettings(req.user.id));
      const accs = ctx.accounts
        .withCapability(req.user.id, 'mail')
        .filter((a) => (body.accountId ? a.id === body.accountId : !s.excludedAccounts.includes(a.id)));
      let queued = 0;
      let skipped = 0;
      for (const acc of accs) {
        try {
          const mail = ctx.accounts.providersFor(acc).mail!;
          const inbox = await mail.getSpecialFolderId('inbox');
          if (!inbox) continue;
          const page = await mail.listMessages({ folderId: inbox, limit: body.limit });
          const items = page.items.map((m) => ({ ...m, accountId: acc.id, folderId: m.folderId || inbox }));
          const known = triageStore.lookup(req.user.id, items);
          const todo = items.filter((m) => !known.has(refKey(m.accountId, m.folderId, m.id)));
          skipped += items.length - todo.length;
          const added = queue!.enqueue(todo.map((m) => ({ userId: req.user.id, accountId: acc.id, folderId: m.folderId, messageId: m.id, manual: true })));
          queued += added;
          skipped += todo.length - added;
        } catch (err) {
          req.log.warn({ err, accountId: acc.id }, 'Posteingang für KI-Triage nicht lesbar');
        }
      }
      return { queued, skipped };
    });

    /**
     * Einordnung von Hand überschreiben. Nicht angegebene Felder bleiben erhalten;
     * ohne vorhandene Einordnung gelten Priorität „normal“ und die Kategorie „Sonstiges“.
     */
    const patchSchema = z.object({
      priority: z.enum(['high', 'normal', 'low']).optional(),
      category: z.string().trim().min(1).max(60).optional(),
      done: z.boolean().optional(),
    });
    type Patch = z.infer<typeof patchSchema>;

    const applyPatch = (userId: string, ref: z.infer<typeof refSchema>, patch: Patch): TriageInfo => {
      const existing = triageStore.lookup(userId, [ref]).values().next().value as TriageInfo | undefined;
      const changesLabel = patch.priority !== undefined || patch.category !== undefined;
      const key = { userId, accountId: ref.accountId, folderId: ref.folderId, messageId: ref.id, messageIdHeader: ref.messageIdHeader };
      const triage = triageStore.set(key, {
        priority: patch.priority ?? existing?.priority ?? 'normal',
        category: patch.category ?? existing?.category ?? TRIAGE_FALLBACK_CATEGORY,
        // Begründung der KI passt nur, solange Priorität/Kategorie unverändert bleiben
        reason: changesLabel ? undefined : existing?.reason,
        source: changesLabel || !existing ? 'manual' : existing.source,
        done: patch.done ?? existing?.done ?? false,
      });
      failedStore.remove(key);
      return triage;
    };

    app.put('/message', async (req) => {
      const body = parse(refSchema.extend(patchSchema.shape), req.body);
      ctx.accounts.get(req.user.id, body.accountId);
      const triage = applyPatch(req.user.id, body, body);
      ctx.bus.publish(req.user.id, { type: 'mail.triage', accountId: body.accountId, items: [{ id: body.id, folderId: body.folderId, triage }] });
      return triage;
    });

    /** Mehrere Nachrichten auf einmal, z. B. eine ganze Unterhaltung als erledigt markieren */
    app.post('/messages', async (req) => {
      const body = parse(patchSchema.extend({ items: z.array(refSchema).min(1).max(200) }), req.body);
      const byAccount = new Map<string, { id: string; folderId: string; triage: TriageInfo }[]>();
      for (const ref of body.items) {
        ctx.accounts.get(req.user.id, ref.accountId);
        const triage = applyPatch(req.user.id, ref, body);
        const list = byAccount.get(ref.accountId) ?? [];
        list.push({ id: ref.id, folderId: ref.folderId, triage });
        byAccount.set(ref.accountId, list);
      }
      for (const [accountId, items] of byAccount) ctx.bus.publish(req.user.id, { type: 'mail.triage', accountId, items });
      return { updated: body.items.length };
    });

    /** Mehrere Nachrichten (neu) einordnen lassen, auch über Ordner hinweg (Unterhaltungen) */
    app.post('/run-many', async (req): Promise<TriageRunResult> => {
      requireAi();
      const body = parse(z.object({ items: z.array(refSchema).min(1).max(200) }), req.body);
      for (const accountId of new Set(body.items.map((i) => i.accountId))) ctx.accounts.require(req.user.id, accountId, 'mail');
      const queued = queue!.enqueue(
        body.items.map((i) => ({ userId: req.user.id, accountId: i.accountId, folderId: i.folderId, messageId: i.id, manual: true, overwrite: true })),
      );
      return { queued, skipped: body.items.length - queued };
    });

    /** Einordnung entfernen */
    app.post('/message/remove', async (req) => {
      const body = parse(refSchema, req.body);
      ctx.accounts.get(req.user.id, body.accountId);
      triageStore.remove({ userId: req.user.id, accountId: body.accountId, folderId: body.folderId, messageId: body.id, messageIdHeader: body.messageIdHeader });
      ctx.bus.publish(req.user.id, { type: 'mail.triage', accountId: body.accountId, items: [{ id: body.id, folderId: body.folderId, triage: null }] });
      return { ok: true };
    });
  },
});
