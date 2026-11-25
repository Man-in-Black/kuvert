/**
 * Google-Modul: Gmail, Google Kalender (inkl. Meet), Kontakte (People API),
 * Google Tasks, Google Drive und Google Meet – alles über ein OAuth-Konto.
 *
 * Konfiguration: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (OAuth-Client "Webanwendung"),
 * Redirect-URI: <PUBLIC_URL>/api/oauth/callback
 */
import { config } from '../../config.js';
import { defineModule } from '../../core/module.js';
import { GoogleCalendarProvider } from './calendar.js';
import { GoogleClient } from './client.js';
import { GoogleContactsProvider } from './contacts.js';
import { GoogleDriveProvider } from './drive.js';
import { GmailProvider } from './gmail.js';
import { GoogleMeetProvider } from './meet.js';
import { googleOAuth } from './oauth.js';
import { GoogleTasksProvider } from './tasks.js';

export default defineModule({
  id: 'google',
  name: 'Google',
  description: 'Gmail, Google Kalender, Kontakte, Aufgaben, Drive und Meet',
  accountTypes: [
    {
      type: 'google',
      label: 'Google',
      description: 'Gmail, Kalender, Kontakte, Aufgaben, Google Drive und Google Meet',
      icon: 'google',
      capabilities: ['mail', 'calendar', 'contacts', 'tasks', 'storage', 'meetings'],
      auth: 'oauth',
      isConfigured: () => !!config.google.clientId,
      oauth: googleOAuth,
      createProviders(ctx) {
        const client = new GoogleClient(ctx);
        return {
          mail: new GmailProvider(client),
          calendar: new GoogleCalendarProvider(client),
          contacts: new GoogleContactsProvider(client),
          tasks: new GoogleTasksProvider(client),
          storage: new GoogleDriveProvider(client),
          meetings: new GoogleMeetProvider(client),
        };
      },
    },
  ],
});
