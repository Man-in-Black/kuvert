/**
 * Modul "imap": klassische E-Mail-Konten über IMAP (Lesen, IDLE-Push) und SMTP (Senden).
 *
 * Routen:
 *   GET /api/imap/autoconfig?email=…  → Servereinstellungen aus der Thunderbird-ISPDB
 */
import { defineModule } from '../../core/module.js';
import { BadRequestError } from '../../core/errors.js';
import { imapFields, setupImap } from './config.js';
import { lookupAutoconfig } from './autoconfig.js';
import { ImapMailProvider } from './provider.js';

export default defineModule({
  id: 'imap',
  name: 'IMAP/SMTP',
  description: 'E-Mail-Konten beliebiger Anbieter über IMAP und SMTP',
  accountTypes: [
    {
      type: 'imap',
      label: 'IMAP / SMTP',
      description: 'Beliebiges E-Mail-Konto (z. B. GMX, web.de, Posteo, eigener Mailserver)',
      icon: 'mail',
      capabilities: ['mail'],
      auth: 'form',
      fields: imapFields,
      setup: setupImap,
      createProviders: (ctx) => ({ mail: new ImapMailProvider(ctx) }),
    },
  ],
  routes(app) {
    app.get<{ Querystring: { email?: string } }>('/autoconfig', async (req) => {
      const email = (req.query.email ?? '').trim();
      if (!email.includes('@')) throw new BadRequestError('Parameter "email" fehlt oder ist ungültig');
      return lookupAutoconfig(email);
    });
  },
});
