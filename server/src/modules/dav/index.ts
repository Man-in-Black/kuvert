/**
 * Modul "dav": CalDAV (Kalender + Aufgaben), CardDAV (Kontakte) und WebDAV-Dateien.
 * Kontotypen: caldav (generisch), nextcloud (alles inkl. Dateien/Freigaben), webdav (nur Dateien).
 */
import { defineModule } from '../../core/module.js';
import { caldavAccountType, nextcloudAccountType, webdavAccountType } from './accounts.js';

export default defineModule({
  id: 'dav',
  name: 'CalDAV/CardDAV/WebDAV',
  description: 'Kalender, Aufgaben, Kontakte und Dateien über offene DAV-Standards (inkl. Nextcloud)',
  accountTypes: [caldavAccountType, nextcloudAccountType, webdavAccountType],
});
