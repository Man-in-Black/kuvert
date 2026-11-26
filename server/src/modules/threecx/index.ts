/**
 * 3CX-Anbindung (V20, Call Control API): Click-to-Call aus Kuvert.
 *
 * Der Admin verbindet die Anlage (Adresse, Client-ID und API-Schlüssel einer API-Anwendung aus
 * 3CX → Integrationen → API) und ordnet Kuvert-Benutzern ihre Nebenstelle zu – von Hand oder
 * automatisch über die E-Mail-Adresse (braucht zusätzlich „3CX Configuration API Access“).
 * Benutzer wählen nur das bevorzugte Gerät; die Nebenstelle selbst legt der Admin fest, damit
 * niemand von fremden Apparaten aus telefoniert.
 *
 * Vorbelegung per Umgebung: THREECX_URL, THREECX_CLIENT_ID, THREECX_API_KEY
 */
import { z } from 'zod';
import type {
  ThreeCxAdminConfig,
  ThreeCxAssignmentList,
  ThreeCxAutoAssignResult,
  ThreeCxCallResult,
  ThreeCxMe,
  ThreeCxTestResult,
} from '@kuvert/shared';
import { audit } from '../../core/audit.js';
import { AppError, BadRequestError } from '../../core/errors.js';
import { defineModule } from '../../core/module.js';
import { users } from '../../core/users.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { normalizeExtension, normalizeNumber, normalizeThreeCxUrl } from './client.js';
import { adminConfig, extensions, migrations } from './store.js';

type IdParams = { Params: { id: string } };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default defineModule({
  id: 'threecx',
  name: '3CX',
  description: 'Click-to-Call über die 3CX-Telefonanlage',
  migrations,
  /** Feature-Flag nur bei vollständiger Einrichtung durch den Admin */
  get features() {
    try {
      return adminConfig.ready() ? ['threecx'] : [];
    } catch {
      return [];
    }
  },

  routes(app, ctx) {
    /* ═════════════════════════════ Admin ═════════════════════════════ */

    app.get('/admin/config', async (req): Promise<ThreeCxAdminConfig> => {
      requireAdmin(req);
      return adminConfig.get();
    });

    app.put('/admin/config', async (req): Promise<ThreeCxAdminConfig> => {
      requireAdmin(req);
      const b = parse(
        z.object({
          enabled: z.boolean(),
          baseUrl: z.string().max(500).default(''),
          clientId: z.string().max(200).default(''),
          secret: z.string().max(500).optional(),
          plusPrefix: z.string().regex(/^\d{0,4}$/, 'nur Ziffern').default(''),
        }),
        req.body,
      );
      const cfg = {
        enabled: b.enabled,
        baseUrl: b.baseUrl.trim() ? normalizeThreeCxUrl(b.baseUrl) : '',
        clientId: b.clientId.trim(),
        plusPrefix: b.plusPrefix,
        secret: b.secret?.trim() || undefined,
      };
      adminConfig.set(cfg);
      audit.log('threecx.config_updated', { req, details: { enabled: cfg.enabled, baseUrl: cfg.baseUrl, clientId: cfg.clientId, secretChanged: !!cfg.secret } });
      return adminConfig.get();
    });

    /** Anmeldung und Call-Control-Zugriff prüfen (mit noch nicht gespeicherten Werten möglich) */
    app.post('/admin/test', async (req): Promise<ThreeCxTestResult> => {
      requireAdmin(req);
      const b = parse(z.object({ baseUrl: z.string().max(500).optional(), clientId: z.string().max(200).optional(), secret: z.string().max(500).optional() }), req.body ?? {});
      const client = adminConfig.client({
        baseUrl: b.baseUrl?.trim() ? normalizeThreeCxUrl(b.baseUrl) : undefined,
        clientId: b.clientId?.trim() || undefined,
        secret: b.secret?.trim() || undefined,
      });
      const entities = await client.entities();
      const monitored = entities.map((e) => e.dn).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
      return {
        ok: true,
        monitored,
        message: monitored.length
          ? `Verbunden – ${monitored.length} Nebenstelle${monitored.length === 1 ? '' : 'n'} abrufbar`
          : 'Verbunden – aber keine Nebenstellen abrufbar. In 3CX unter Integrationen → API die zu überwachenden Nebenstellen eintragen.',
      };
    });

    app.get('/admin/assignments', async (req): Promise<ThreeCxAssignmentList> => {
      requireAdmin(req);
      const ext = new Map(extensions.all().map((r) => [r.user_id, r.extension]));
      let monitored: string[] | null = null;
      let monitoredError: string | null = null;
      if (adminConfig.ready()) {
        try {
          monitored = (await adminConfig.client().entities()).map((e) => e.dn);
        } catch (err) {
          monitoredError = errText(err);
        }
      }
      return {
        users: users.list().map((u) => ({ userId: u.id, name: u.name, email: u.email, extension: ext.get(u.id) ?? null })),
        monitored,
        monitoredError,
      };
    });

    app.put<IdParams>('/admin/assignments/:id', async (req) => {
      requireAdmin(req);
      const u = users.get(req.params.id);
      if (!u) throw new AppError(404, 'not_found', 'Benutzer nicht gefunden');
      const b = parse(z.object({ extension: z.string().max(20).nullable() }), req.body);
      const extension = b.extension?.trim() ? normalizeExtension(b.extension) : null;
      extensions.set(u.id, extension);
      audit.log('threecx.extension_assigned', { req, userId: u.id, details: { extension } });
      return { ok: true };
    });

    /** Nebenstellen über die E-Mail-Adresse zuordnen (nur Benutzer ohne Zuordnung) */
    app.post('/admin/auto-assign', async (req): Promise<ThreeCxAutoAssignResult> => {
      requireAdmin(req);
      let pbxUsers: { number: string; email: string }[];
      try {
        pbxUsers = await adminConfig.client().users();
      } catch (err) {
        if (err instanceof AppError && (err.status === 403 || err.code === 'threecx_auth')) {
          throw new AppError(400, 'threecx_no_config_api', 'Die API-Anwendung hat keinen Zugriff auf die Konfigurations-API. In 3CX „3CX Configuration API Access“ aktivieren (Rolle mit Leserechten) – oder die Nebenstellen von Hand eintragen.');
        }
        throw err;
      }
      const byEmail = new Map(pbxUsers.map((p) => [p.email, p.number]));
      const assigned = new Set(extensions.all().map((r) => r.user_id));
      let count = 0;
      let unmatched = 0;
      for (const u of users.list()) {
        if (assigned.has(u.id)) continue;
        const number = byEmail.get(u.email.trim().toLowerCase());
        if (number && /^\d{1,10}$/.test(number)) {
          extensions.set(u.id, number);
          count++;
        } else unmatched++;
      }
      audit.log('threecx.auto_assigned', { req, details: { assigned: count, unmatched } });
      return { assigned: count, unmatched };
    });

    /* ═════════════════════════════ Eigene Einstellungen ═════════════════════════════ */

    app.get('/me', async (req): Promise<ThreeCxMe> => {
      const enabled = adminConfig.ready();
      const row = extensions.get(req.user.id);
      const me: ThreeCxMe = { enabled, extension: row?.extension ?? null, deviceId: row?.device_id ?? null, devices: [], devicesError: null };
      if (enabled && row) {
        try {
          me.devices = (await adminConfig.client().devices(row.extension)).map((d) => ({ deviceId: d.device_id, userAgent: d.user_agent || d.device_id }));
        } catch (err) {
          me.devicesError = errText(err);
        }
      }
      return me;
    });

    app.put('/me/device', async (req) => {
      const row = extensions.get(req.user.id);
      if (!row) throw new AppError(409, 'threecx_no_extension', 'Dir ist noch keine Nebenstelle zugeordnet');
      const b = parse(z.object({ deviceId: z.string().max(500).nullable() }), req.body);
      extensions.setDevice(req.user.id, b.deviceId || null);
      return { ok: true };
    });

    /* ═════════════════════════════ Anrufen ═════════════════════════════ */

    app.post('/call', async (req): Promise<ThreeCxCallResult> => {
      if (!adminConfig.ready()) throw new AppError(403, 'threecx_disabled', 'Die 3CX-Anbindung ist nicht aktiv');
      const row = extensions.get(req.user.id);
      if (!row) throw new AppError(409, 'threecx_no_extension', 'Dir ist noch keine 3CX-Nebenstelle zugeordnet – bitte an den Administrator wenden');
      const b = parse(z.object({ number: z.string().min(1).max(100) }), req.body);
      const destination = normalizeNumber(b.number, adminConfig.get().plusPrefix);
      if (destination === row.extension) throw new BadRequestError('Das ist deine eigene Nebenstelle');

      const client = adminConfig.client();
      const devices = await client.devices(row.extension);
      if (!devices.length) {
        throw new AppError(409, 'threecx_no_device', `Für Nebenstelle ${row.extension} ist kein Telefon und keine 3CX-App angemeldet`);
      }
      // Bevorzugtes Gerät, sonst das einzige; bei mehreren ohne Auswahl entscheidet 3CX
      const device = devices.find((d) => d.device_id === row.device_id) ?? (devices.length === 1 ? devices[0] : undefined);
      const res = await client.makeCall(row.extension, destination, device?.device_id ?? null);
      ctx.log.info({ userId: req.user.id, extension: row.extension, status: res.status }, '3CX: Anruf gestartet');

      const started = res.status === 200 && !!res.data?.result;
      return {
        status: started ? 'started' : 'accepted',
        destination,
        message: started ? `Anruf an ${destination} wird aufgebaut` : `Anruf an ${destination} an 3CX übergeben`,
      };
    });
  },
});
