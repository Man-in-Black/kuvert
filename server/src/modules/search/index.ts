/**
 * Volltext-Suchindex (Meilisearch): blitzschnelle Suche über alle Konten,
 * inkl. Tippfehlertoleranz, Suchbefehlen (from:, is:unread, has:attachment …)
 * und Hervorhebung der Treffer. Ohne Index fällt die App auf die Live-Suche
 * beim jeweiligen Anbieter zurück.
 */
import { z } from 'zod';
import type { SearchAdminStatus, SearchResult, SearchStatus } from '@kuvert/shared';
import { config } from '../../config.js';
import { audit } from '../../core/audit.js';
import { BadRequestError } from '../../core/errors.js';
import { defineModule } from '../../core/module.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { INDEX_UID, SearchIndexer } from './indexer.js';
import { MeiliClient } from './meili.js';
import { plainText } from './query.js';

let indexer: SearchIndexer | null = null;

export default defineModule({
  id: 'search',
  name: 'Suchindex',
  description: 'Volltext-Suche über alle Konten (Meilisearch)',
  /** Feature-Flag nur, wenn ein Index eingerichtet ist */
  get features() {
    return config.search.enabled && config.search.url ? ['search'] : [];
  },

  init(ctx) {
    indexer = new SearchIndexer(ctx, ctx.log.child({ module: 'search' }));
    const ix = indexer;
    ctx.hooks.searchIndex = {
      readyAccounts: (userId) => ix.readyAccounts(userId),
      search: (userId, opts) => ix.search(userId, opts),
      plainText,
    };
    ix.start();
  },

  shutdown() {
    indexer?.stop();
  },

  routes(app, ctx) {
    const ix = () => {
      if (!indexer) throw new BadRequestError('Suchindex nicht initialisiert');
      return indexer;
    };

    /** Index-Status der eigenen Konten */
    app.get('/status', async (req): Promise<SearchStatus> => ({
      available: ix().available,
      enabled: ix().configured,
      error: ix().configured && !ix().available ? ix().error : null,
      accounts: ix().configured ? await ix().userStatus(req.user.id) : [],
    }));

    /** Schnelle Suche (z. B. Befehlspalette) – nur Index, keine Live-Suche */
    app.get<{ Querystring: { q?: string; accountId?: string; folderId?: string; limit?: string; offset?: string } }>('/query', async (req): Promise<SearchResult> => {
      const ready = await ix().readyAccounts(req.user.id);
      const ids = req.query.accountId ? [...ready].filter((id) => id === req.query.accountId) : [...ready];
      const res = await ix().search(req.user.id, {
        q: req.query.q ?? '',
        accountIds: ids,
        folderId: req.query.folderId || undefined,
        limit: Math.min(Number(req.query.limit ?? 20) || 20, 100),
        offset: Math.max(Number(req.query.offset ?? 0) || 0, 0),
      });
      return { ...res, indexed: true, liveAccounts: [], errors: [] };
    });

    /** Konto neu indizieren */
    app.post<{ Params: { id: string } }>('/accounts/:id/reindex', async (req) => {
      ctx.accounts.get(req.user.id, req.params.id);
      await ix().reindexAccount(req.params.id);
      return { ok: true };
    });

    /** Konto vom Index aus-/einschließen */
    app.put<{ Params: { id: string } }>('/accounts/:id/excluded', async (req) => {
      const body = parse(z.object({ excluded: z.boolean() }), req.body);
      ctx.accounts.update(req.user.id, req.params.id, { settings: { searchIndex: !body.excluded } });
      if (body.excluded) await ix().dropAccount(req.params.id);
      else ix().requestHeadSync(req.params.id);
      return { ok: true };
    });

    /* ───────────── Admin ───────────── */

    app.get('/admin/status', async (req): Promise<SearchAdminStatus> => {
      requireAdmin(req);
      const i = ix();
      const status: SearchAdminStatus = {
        enabled: config.search.enabled,
        configured: i.configured,
        reachable: false,
        documents: 0,
        isIndexing: i.isRunning(),
        accounts: { total: 0, ready: 0, indexing: 0, errors: 0 },
      };
      const states = i.accountStates();
      status.accounts = {
        total: states.length,
        ready: states.filter((s) => s.ready && !s.error).length,
        indexing: states.filter((s) => !s.ready && !s.error).length,
        errors: states.filter((s) => !!s.error).length,
      };
      const client = i.getClient();
      if (!client) return status;
      try {
        status.version = (await client.version()).pkgVersion;
        status.reachable = true;
        const stats = await client.stats(INDEX_UID).catch(() => null);
        status.documents = stats?.numberOfDocuments ?? 0;
        status.isIndexing = status.isIndexing || !!stats?.isIndexing;
        const g = await client.globalStats().catch(() => null);
        status.sizeBytes = g?.usedDatabaseSize ?? g?.databaseSize ?? stats?.rawDocumentDbSize ?? null;
      } catch (err) {
        status.error = (err as Error).message;
      }
      return status;
    });

    /** Verbindung testen – optional mit noch nicht gespeicherten Werten */
    app.post('/admin/test', async (req) => {
      requireAdmin(req);
      const body = parse(z.object({ url: z.string().optional(), apiKey: z.string().optional() }), req.body ?? {});
      const url = (body.url || config.search.url).replace(/\/+$/, '');
      if (!url) return { ok: false, error: 'Keine URL angegeben' };
      const client = new MeiliClient(url, body.apiKey || config.search.apiKey);
      try {
        await client.health();
        const v = await client.version();
        return { ok: true, version: v.pkgVersion };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    /** Index komplett neu aufbauen */
    app.post('/admin/rebuild', async (req) => {
      requireAdmin(req);
      await ix().rebuildAll();
      audit.log('admin.search_rebuild', { req });
      return { ok: true };
    });
  },
});
