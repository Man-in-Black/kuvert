/**
 * Modul "microsoft": Microsoft 365 / Outlook.com über Microsoft Graph.
 * Mail (inkl. freigegebener Postfächer), Kalender (inkl. Teams-Besprechungen),
 * Kontakte, Aufgaben (To Do), OneDrive und Teams-Online-Meetings.
 *
 * Konfiguration: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT (Standard "common").
 * Redirect-URI der App-Registrierung: <PUBLIC_URL>/api/oauth/callback
 *
 * Alternativ legt Kuvert die App-Registrierung selbst an (Admin → Dienste & Anmeldung →
 * „Automatisch einrichten“): Ein Microsoft-365-Admin meldet sich per Gerätecode an, Kuvert
 * erstellt App, Berechtigungen, Administratorzustimmung und Geheimnis (siehe provision.ts).
 */
import { z } from 'zod';
import type { MsProvisionOverview } from '@kuvert/shared';
import { config } from '../../config.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { defineModule, type AccountTypeDefinition } from '../../core/module.js';
import { requireAdmin } from '../../routes/admin.js';
import { parse } from '../../routes/util.js';
import { GraphCalendarProvider } from './calendar.js';
import { GraphContactsProvider } from './contacts.js';
import { GraphClient } from './graph.js';
import { GraphMailProvider } from './mail.js';
import { TeamsMeetingsProvider } from './meetings.js';
import { msOAuth } from './oauth.js';
import { cancelJob, getJob, latestJob, provisionedApp, startProvisioning } from './provision.js';
import { OneDriveProvider } from './storage.js';
import { GraphTasksProvider } from './tasks.js';

const microsoftAccount: AccountTypeDefinition = {
  type: 'microsoft',
  label: 'Microsoft 365',
  description: 'Exchange Online / Outlook.com: E-Mail, freigegebene Postfächer, Kalender, Kontakte, To Do, OneDrive und Teams',
  icon: 'microsoft',
  capabilities: ['mail', 'calendar', 'contacts', 'tasks', 'storage', 'meetings'],
  auth: 'oauth',
  isConfigured: () => !!config.microsoft.clientId,
  oauth: msOAuth,
  createProviders(ctx) {
    const graph = new GraphClient(ctx);
    return {
      mail: new GraphMailProvider(graph, ctx),
      calendar: new GraphCalendarProvider(graph, ctx),
      contacts: new GraphContactsProvider(graph, ctx),
      tasks: new GraphTasksProvider(graph, ctx),
      storage: new OneDriveProvider(graph, ctx),
      meetings: new TeamsMeetingsProvider(graph),
    };
  },
};

export default defineModule({
  id: 'microsoft',
  name: 'Microsoft 365',
  description: 'Anbindung an Microsoft 365 über Microsoft Graph',
  features: ['microsoft'],
  accountTypes: [microsoftAccount],

  routes(app, ctx) {
    type JobParams = { Params: { id: string } };

    /** Automatisch eingerichtete App + laufender Vorgang */
    app.get('/provision', async (req): Promise<MsProvisionOverview> => {
      requireAdmin(req);
      const info = provisionedApp(ctx);
      return { app: info, active: !!info && info.appId === config.microsoft.clientId, job: latestJob(req.user.id) };
    });

    /** Einrichtung starten: liefert den Gerätecode für die Admin-Anmeldung bei Microsoft */
    app.post('/provision', async (req) => {
      requireAdmin(req);
      const body = parse(
        z.object({
          adminEmail: z.string().trim().max(320).optional(),
          audience: z.enum(['tenant', 'orgs', 'multi']).default('tenant'),
          displayName: z.string().trim().min(1).max(120).default('Kuvert'),
        }),
        req.body ?? {},
      );
      if (body.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.adminEmail)) throw new BadRequestError('Bitte eine gültige E-Mail-Adresse angeben');
      return startProvisioning(ctx, { userId: req.user.id, adminEmail: body.adminEmail || undefined, audience: body.audience, displayName: body.displayName });
    });

    app.get<JobParams>('/provision/:id', async (req) => {
      requireAdmin(req);
      const job = getJob(req.params.id, req.user.id);
      if (!job) throw new NotFoundError('Einrichtungsvorgang');
      return job;
    });

    app.delete<JobParams>('/provision/:id', async (req) => {
      requireAdmin(req);
      if (!cancelJob(req.params.id, req.user.id)) throw new NotFoundError('Einrichtungsvorgang');
      return { ok: true };
    });
  },
});
