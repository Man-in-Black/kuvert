/**
 * Paperless-ngx-Integration (https://docs.paperless-ngx.com):
 *  - Dokumente im Editor suchen und anhängen (Archiv-PDF oder Original) oder als Freigabelink einfügen
 *  - Mail-Anhänge an Paperless übergeben (Titel, Korrespondent, Dokumenttyp, Tags optional)
 *
 * Jeder Benutzer hinterlegt seinen persönlichen API-Token, damit die Berechtigungen
 * aus Paperless gelten. Der Admin legt die Standard-URL fest.
 * Vorbelegung per Umgebung: PAPERLESS_URL
 */
import { z } from 'zod';
import type {
  PaperlessAdminConfig,
  PaperlessDocument,
  PaperlessMeta,
  PaperlessNamed,
  PaperlessSearchResult,
  PaperlessShareLink,
  PaperlessStats,
  PaperlessTaskStatus,
  PaperlessUploadResult,
  PaperlessUserConfig,
} from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { defineModule } from '../../core/module.js';
import { uploads } from '../../core/uploads.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse, sendFile } from '../../routes/util.js';
import { normalizePaperlessUrl, PaperlessClient } from './client.js';
import { adminConfig, credentials, migrations } from './store.js';

type IdParams = { Params: { id: string } };

/* ───────────────────────────── Rohdaten der API ───────────────────────────── */

interface RawDoc {
  id: number;
  title: string;
  created?: string | null;
  created_date?: string | null;
  added?: string | null;
  correspondent: number | null;
  document_type: number | null;
  tags?: number[];
  original_file_name?: string | null;
  archived_file_name?: string | null;
  mime_type?: string | null;
  page_count?: number | null;
  __search_hit__?: { highlights?: string | null } | null;
}

interface RawNamed {
  id: number;
  name: string;
  color?: string | null;
  document_count?: number | null;
}

interface RawStats {
  documents_total?: number;
  documents_inbox?: number | null;
  correspondent_count?: number;
  tag_count?: number;
}

interface RawTask {
  status?: string;
  result?: string | null;
  related_document?: string | number | null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');

function mapDoc(d: RawDoc): PaperlessDocument {
  const hl = d.__search_hit__?.highlights;
  return {
    id: d.id,
    title: d.title,
    created: d.created_date ?? d.created?.slice(0, 10) ?? null,
    added: d.added ?? null,
    correspondent: d.correspondent ?? null,
    documentType: d.document_type ?? null,
    tags: d.tags ?? [],
    originalFileName: d.original_file_name ?? null,
    archivedFileName: d.archived_file_name ?? null,
    mimeType: d.mime_type ?? null,
    pageCount: d.page_count ?? null,
    snippet: hl ? decodeEntities(hl.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null : null,
  };
}

const mapNamed = (n: RawNamed): PaperlessNamed => ({ id: n.id, name: n.name, color: n.color ?? null, documentCount: n.document_count ?? null });

const mapStats = (s: RawStats): PaperlessStats => ({
  documents: s.documents_total ?? 0,
  inbox: s.documents_inbox ?? null,
  correspondents: s.correspondent_count ?? null,
  tags: s.tag_count ?? null,
});

function mapTask(t: RawTask | undefined): PaperlessTaskStatus {
  if (!t) return { status: 'pending', message: null, documentId: null };
  const s = (t.status ?? '').toUpperCase();
  const status: PaperlessTaskStatus['status'] =
    s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'REVOKED' ? 'failure' : s === 'STARTED' ? 'running' : 'pending';
  const doc = t.related_document != null && /^\d+$/.test(String(t.related_document)) ? Number(t.related_document) : null;
  return { status, message: t.result ?? null, documentId: doc };
}

const numericId = (v: string) => {
  if (!/^\d+$/.test(v)) throw new BadRequestError('Ungültige Dokument-ID');
  return v;
};

/** Dateiname des Archiv-PDFs bzw. Originals (Fallback, falls Paperless keinen liefert) */
function fallbackName(id: string, original: boolean) {
  return original ? `dokument-${id}` : `dokument-${id}.pdf`;
}

const searchSchema = z.object({
  q: z.string().max(500).optional(),
  correspondent: z.coerce.number().int().positive().optional(),
  documentType: z.coerce.number().int().positive().optional(),
  tag: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export default defineModule({
  id: 'paperless',
  name: 'Paperless-ngx',
  description: 'Dokumente aus Paperless-ngx anhängen und Mail-Anhänge an Paperless übergeben',
  migrations,
  /** Feature-Flag nur, wenn der Admin die Anbindung aktiviert hat */
  get features() {
    try {
      return adminConfig.get().enabled ? ['paperless'] : [];
    } catch {
      return [];
    }
  },

  routes(app, ctx) {
    /* ═════════════════════════════ Admin ═════════════════════════════ */

    app.get('/admin/config', async (req): Promise<PaperlessAdminConfig> => {
      requireAdmin(req);
      return adminConfig.get();
    });

    app.put('/admin/config', async (req): Promise<PaperlessAdminConfig> => {
      requireAdmin(req);
      const b = parse(z.object({ enabled: z.boolean(), baseUrl: z.string().max(500).default('') }), req.body);
      const cfg = { enabled: b.enabled, baseUrl: b.baseUrl.trim() ? normalizePaperlessUrl(b.baseUrl) : '' };
      adminConfig.set(cfg);
      audit.log('paperless.config_updated', { req, details: cfg });
      return cfg;
    });

    /** Erreichbarkeit prüfen; mit eigenem Token des Admins auch die Anmeldung */
    app.post('/admin/test', async (req) => {
      requireAdmin(req);
      const b = parse(z.object({ baseUrl: z.string().max(500).optional() }), req.body ?? {});
      const url = normalizePaperlessUrl(b.baseUrl || adminConfig.get().baseUrl);
      const token = credentials.token(req.user.id);
      if (token) {
        const stats = mapStats(await new PaperlessClient(url, token).json<RawStats>('statistics/'));
        return { ok: true, authenticated: true, stats, message: 'Verbindung und eigener API-Token funktionieren' };
      }
      // Ohne Token: 401/403 bedeutet "API erreichbar". Nicht /api/ selbst abfragen –
      // neuere Versionen leiten dort auf die API-Doku (schema/view/) um.
      let res: Response;
      try {
        res = await fetch(`${url}/api/statistics/`, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        throw new AppError(502, 'paperless_unreachable', `Paperless nicht erreichbar: ${(err as Error).message}`);
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: true, authenticated: false, message: 'API erreichbar – zum vollständigen Test einen eigenen Token unter „Einstellungen → Paperless“ hinterlegen' };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') ?? '';
        throw new AppError(400, 'paperless_redirect', `Weiterleitung (${res.status}${loc ? ` nach ${loc}` : ''}) – vorgeschalteter Login (z. B. SSO-Proxy) oder falsche URL?`);
      }
      if (res.status === 404) throw new AppError(400, 'paperless_not_found', 'Unter dieser Adresse wurde keine Paperless-API gefunden (404)');
      throw new AppError(400, 'paperless_unexpected', `Unerwartete Antwort (${res.status}) – ist die URL korrekt?`);
    });

    /* ═════════════════════════════ Eigene Konfiguration ═════════════════════════════ */

    app.get('/me/config', async (req): Promise<PaperlessUserConfig> => credentials.info(req.user.id));

    app.put('/me/config', async (req): Promise<PaperlessUserConfig> => {
      const b = parse(z.object({ token: z.string().max(500).optional(), baseUrl: z.string().max(500).nullable().optional() }), req.body);
      const admin = adminConfig.get();
      if (!admin.enabled) throw credentials.disabled();
      const token = b.token?.trim() || credentials.token(req.user.id);
      if (!token) throw new BadRequestError('API-Token fehlt');
      const override = b.baseUrl === undefined ? (credentials.row(req.user.id)?.base_url ?? null) : b.baseUrl?.trim() ? normalizePaperlessUrl(b.baseUrl) : null;
      const url = override || admin.baseUrl;
      if (!url) throw new BadRequestError('Bitte die URL von Paperless angeben');
      // Token vor dem Speichern prüfen
      await new PaperlessClient(url, token).json<RawStats>('statistics/');
      credentials.save(req.user.id, token, override);
      return credentials.info(req.user.id);
    });

    app.delete('/me/config', async (req) => {
      credentials.delete(req.user.id);
      return { ok: true };
    });

    app.get('/me/status', async (req): Promise<PaperlessStats> => mapStats(await credentials.client(req.user.id).json<RawStats>('statistics/')));

    /* ═════════════════════════════ Dokumente ═════════════════════════════ */

    app.get('/meta', async (req): Promise<PaperlessMeta> => {
      const c = credentials.client(req.user.id);
      const [correspondents, documentTypes, tags] = await Promise.all([
        c.all<RawNamed>('correspondents/'),
        c.all<RawNamed>('document_types/'),
        c.all<RawNamed>('tags/'),
      ]);
      const byName = (a: PaperlessNamed, b: PaperlessNamed) => a.name.localeCompare(b.name, 'de');
      return {
        correspondents: correspondents.map(mapNamed).sort(byName),
        documentTypes: documentTypes.map(mapNamed).sort(byName),
        tags: tags.map(mapNamed).sort(byName),
      };
    });

    app.get('/documents', async (req): Promise<PaperlessSearchResult> => {
      const q = parse(searchSchema, req.query);
      const text = q.q?.trim();
      const r = await credentials.client(req.user.id).json<{ count: number; results: RawDoc[] }>('documents/', {
        // Volltextsuche (Inhalt, Titel, Korrespondent …); ohne Suchtext neueste zuerst
        query: text || undefined,
        ordering: text ? undefined : '-created',
        correspondent__id: q.correspondent,
        document_type__id: q.documentType,
        tags__id__all: q.tag,
        truncate_content: true,
        page: q.page,
        page_size: q.pageSize,
      });
      return { count: r.count, page: q.page, pageSize: q.pageSize, results: r.results.map(mapDoc) };
    });

    app.get<IdParams>('/documents/:id/thumb', async (req, reply) => {
      const id = numericId(req.params.id);
      const file = await credentials.client(req.user.id).binary(`documents/${id}/thumb/`);
      return sendFile(reply, { filename: `vorschau-${id}`, contentType: file.contentType, data: file.data }, true);
    });

    /** Archiv-PDF (bzw. Original, falls keins existiert) zum Ansehen im Browser */
    app.get<IdParams>('/documents/:id/preview', async (req, reply) => {
      const id = numericId(req.params.id);
      const file = await credentials.client(req.user.id).binary(`documents/${id}/preview/`);
      return sendFile(reply, { filename: file.filename ?? fallbackName(id, false), contentType: file.contentType, data: file.data }, true);
    });

    /** Dokument als Upload bereitstellen (zum Anhängen im Editor) */
    app.post<IdParams>('/documents/:id/attach', async (req) => {
      const id = numericId(req.params.id);
      const b = parse(z.object({ original: z.boolean().default(false) }), req.body ?? {});
      const file = await credentials.client(req.user.id).binary(`documents/${id}/download/`, b.original ? { original: 'true' } : undefined);
      return uploads.save(req.user.id, file.filename ?? fallbackName(id, b.original), file.contentType, file.data);
    });

    /** Öffentlichen Freigabelink erzeugen (statt Anhang) */
    app.post<IdParams>('/documents/:id/share', async (req): Promise<PaperlessShareLink> => {
      const id = numericId(req.params.id);
      const b = parse(z.object({ expiresDays: z.number().int().min(1).max(3650).nullable().default(30), original: z.boolean().default(false) }), req.body ?? {});
      const c = credentials.client(req.user.id);
      const expires = b.expiresDays ? new Date(Date.now() + b.expiresDays * 86_400_000).toISOString() : null;
      const link = await c.post<{ slug: string; expiration?: string | null }>('share_links/', {
        document: Number(id),
        expiration: expires,
        file_version: b.original ? 'original' : 'archive',
      });
      audit.log('paperless.share_created', { req, details: { document: Number(id), expires } });
      return { url: `${c.baseUrl}/share/${link.slug}`, expires: link.expiration ?? expires };
    });

    /* ═════════════════════════════ An Paperless übergeben ═════════════════════════════ */

    app.post('/upload-attachment', async (req): Promise<PaperlessUploadResult> => {
      const b = parse(
        z.object({
          mail: z.object({ accountId: z.string(), folderId: z.string(), messageId: z.string(), attachmentId: z.string() }),
          title: z.string().max(300).optional(),
          correspondent: z.number().int().positive().nullable().optional(),
          documentType: z.number().int().positive().nullable().optional(),
          tags: z.array(z.number().int().positive()).max(50).optional(),
        }),
        req.body,
      );
      const c = credentials.client(req.user.id);
      const file = await ctx.accounts
        .require(req.user.id, b.mail.accountId, 'mail')
        .getAttachment(b.mail.folderId, b.mail.messageId, b.mail.attachmentId);

      const form = new FormData();
      form.append('document', new Blob([new Uint8Array(file.data)], { type: file.contentType || 'application/octet-stream' }), file.filename || 'anhang');
      if (b.title?.trim()) form.append('title', b.title.trim());
      if (b.correspondent) form.append('correspondent', String(b.correspondent));
      if (b.documentType) form.append('document_type', String(b.documentType));
      for (const t of b.tags ?? []) form.append('tags', String(t));

      const res = await c.fetch('documents/post_document/', { method: 'POST', body: form, timeoutMs: 120_000 });
      const taskId = (await res.json()) as unknown;
      if (typeof taskId !== 'string') throw new AppError(502, 'paperless_unexpected', 'Paperless hat keine Aufgaben-ID geliefert');
      audit.log('paperless.document_uploaded', { req, details: { filename: file.filename, taskId } });
      return { taskId };
    });

    app.get<IdParams>('/tasks/:id', async (req): Promise<PaperlessTaskStatus> => {
      if (!/^[\w-]{1,100}$/.test(req.params.id)) throw new BadRequestError('Ungültige Aufgaben-ID');
      const r = await credentials.client(req.user.id).json<RawTask[] | { results?: RawTask[] }>('tasks/', { task_id: req.params.id });
      const list = Array.isArray(r) ? r : (r.results ?? []);
      return mapTask(list[0]);
    });
  },
});
