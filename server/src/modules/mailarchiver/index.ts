/**
 * Mail-Archiver-Integration (https://github.com/s1t5/mail-archiver):
 * Durchsuchen und Öffnen archivierter E-Mails direkt in Kuvert, Anhänge laden,
 * Nachrichten als .eml herunterladen oder weiterleiten.
 *
 * Jeder Benutzer hinterlegt seinen persönlichen API-Schlüssel (ma_…), damit
 * die Sichtbarkeitsregeln des Archivs gelten. Der Admin legt die Standard-URL fest.
 * Vorbelegung per Umgebung: MAILARCHIVER_URL
 */
import { z } from 'zod';
import type {
  ArchiverAccount,
  ArchiverAdminConfig,
  ArchiverEmailDetail,
  ArchiverFolder,
  ArchiverSearchResult,
  ArchiverStats,
  ArchiverUserConfig,
} from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { emlFilename } from '../../core/mime.js';
import { defineModule } from '../../core/module.js';
import { uploads } from '../../core/uploads.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse, sendFile } from '../../routes/util.js';
import { ArchiverClient, normalizeArchiverUrl } from './client.js';
import { adminConfig, credentials, migrations } from './store.js';

type IdParams = { Params: { id: string } };

const searchSchema = z.object({
  q: z.string().max(500).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.coerce.number().int().positive().optional(),
  folder: z.string().max(500).optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['sentDate', 'receivedDate', 'subject', 'from', 'to']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const numericId = (v: string, what = 'ID') => {
  if (!/^\d+$/.test(v)) throw new BadRequestError(`Ungültige ${what}`);
  return v;
};

/** Original (raw) bevorzugen, sonst rekonstruierte .eml */
async function loadEml(client: ArchiverClient, id: string) {
  try {
    return await client.binary(`emails/${id}/raw`);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return client.binary(`emails/${id}/eml`);
    throw err;
  }
}

export default defineModule({
  id: 'mailarchiver',
  name: 'Mail-Archiver',
  description: 'Archivierte E-Mails aus Mail-Archiver durchsuchen und öffnen',
  migrations,
  /** Feature-Flag nur, wenn der Admin die Anbindung aktiviert hat */
  get features() {
    try {
      return adminConfig.get().enabled ? ['mailarchiver'] : [];
    } catch {
      return [];
    }
  },

  routes(app) {
    /* ═════════════════════════════ Admin ═════════════════════════════ */

    app.get('/admin/config', async (req): Promise<ArchiverAdminConfig> => {
      requireAdmin(req);
      return adminConfig.get();
    });

    app.put('/admin/config', async (req): Promise<ArchiverAdminConfig> => {
      requireAdmin(req);
      const b = parse(z.object({ enabled: z.boolean(), baseUrl: z.string().max(500).default('') }), req.body);
      const cfg = { enabled: b.enabled, baseUrl: b.baseUrl.trim() ? normalizeArchiverUrl(b.baseUrl) : '' };
      adminConfig.set(cfg);
      audit.log('mailarchiver.config_updated', { req, details: cfg });
      return cfg;
    });

    /** Erreichbarkeit prüfen; mit eigenem Schlüssel des Admins auch die Anmeldung */
    app.post('/admin/test', async (req) => {
      requireAdmin(req);
      const b = parse(z.object({ baseUrl: z.string().max(500).optional() }), req.body ?? {});
      const url = normalizeArchiverUrl(b.baseUrl || adminConfig.get().baseUrl);
      const key = credentials.apiKey(req.user.id);
      if (key) {
        const stats = await new ArchiverClient(url, key).json<ArchiverStats>('stats');
        return { ok: true, authenticated: true, stats, message: 'Verbindung und eigener API-Schlüssel funktionieren' };
      }
      // Ohne Schlüssel: 401 bedeutet "API erreichbar und aktiv"
      let res: Response;
      try {
        res = await fetch(`${url}/api/v1/accounts`, { signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        throw new AppError(502, 'archiver_unreachable', `Mail-Archiver nicht erreichbar: ${(err as Error).message}`);
      }
      if (res.status === 401) return { ok: true, authenticated: false, message: 'API erreichbar – zum vollständigen Test einen eigenen Schlüssel unter „Mail-Archiv“ hinterlegen' };
      if (res.status === 404) throw new AppError(400, 'archiver_api_disabled', 'API nicht gefunden – im Mail-Archiver Api__Enabled=true setzen');
      throw new AppError(400, 'archiver_unexpected', `Unerwartete Antwort (${res.status}) – ist die URL korrekt?`);
    });

    /* ═════════════════════════════ Eigene Konfiguration ═════════════════════════════ */

    app.get('/me/config', async (req): Promise<ArchiverUserConfig> => credentials.info(req.user.id));

    app.put('/me/config', async (req): Promise<ArchiverUserConfig> => {
      const b = parse(z.object({ apiKey: z.string().max(500).optional(), baseUrl: z.string().max(500).nullable().optional() }), req.body);
      const admin = adminConfig.get();
      if (!admin.enabled) throw new AppError(403, 'archiver_disabled', 'Die Mail-Archiver-Anbindung ist vom Administrator deaktiviert');
      const existingKey = credentials.apiKey(req.user.id);
      const key = b.apiKey?.trim() || existingKey;
      if (!key) throw new BadRequestError('API-Schlüssel fehlt');
      const override = b.baseUrl === undefined ? (credentials.row(req.user.id)?.base_url ?? null) : b.baseUrl?.trim() ? normalizeArchiverUrl(b.baseUrl) : null;
      const url = override || admin.baseUrl;
      if (!url) throw new BadRequestError('Bitte die URL des Mail-Archivers angeben');
      // Schlüssel vor dem Speichern prüfen
      await new ArchiverClient(url, key).json<ArchiverStats>('stats');
      credentials.save(req.user.id, key, override);
      return credentials.info(req.user.id);
    });

    app.delete('/me/config', async (req) => {
      credentials.delete(req.user.id);
      return { ok: true };
    });

    app.get('/me/status', async (req): Promise<ArchiverStats> => credentials.client(req.user.id).json<ArchiverStats>('stats'));

    /* ═════════════════════════════ Archiv durchsuchen ═════════════════════════════ */

    app.get('/accounts', async (req): Promise<ArchiverAccount[]> => credentials.client(req.user.id).json<ArchiverAccount[]>('accounts'));

    app.get<IdParams>('/accounts/:id/folders', async (req): Promise<ArchiverFolder[]> =>
      credentials.client(req.user.id).json<ArchiverFolder[]>(`accounts/${numericId(req.params.id, 'Konto-ID')}/folders`),
    );

    app.get('/emails', async (req): Promise<ArchiverSearchResult> => {
      const q = parse(searchSchema, req.query);
      return credentials.client(req.user.id).json<ArchiverSearchResult>('emails', q);
    });

    app.get<IdParams>('/emails/:id', async (req): Promise<ArchiverEmailDetail> =>
      credentials.client(req.user.id).json<ArchiverEmailDetail>(`emails/${numericId(req.params.id)}`),
    );

    app.get<IdParams & { Params: { aid: string }; Querystring: { inline?: string } }>('/emails/:id/attachments/:aid', async (req, reply) => {
      const file = await credentials.client(req.user.id).binary(`emails/${numericId(req.params.id)}/attachments/${numericId(req.params.aid, 'Anhang-ID')}`);
      return sendFile(reply, { filename: file.filename ?? `anhang-${req.params.aid}`, contentType: file.contentType, data: file.data }, req.query.inline === '1');
    });

    app.get<IdParams>('/emails/:id/eml', async (req, reply) => {
      const id = numericId(req.params.id);
      const file = await loadEml(credentials.client(req.user.id), id);
      return sendFile(reply, { filename: await emlFilename(file.data, `archiv-${id}`), contentType: 'message/rfc822', data: file.data });
    });

    /** Nachricht als .eml-Upload bereitstellen (zum Weiterleiten als Anhang) */
    app.post<IdParams>('/emails/:id/to-upload', async (req) => {
      const id = numericId(req.params.id);
      const file = await loadEml(credentials.client(req.user.id), id);
      return uploads.save(req.user.id, await emlFilename(file.data, `archiv-${id}`), 'message/rfc822', file.data);
    });
  },
});
