/**
 * Liste aller Server-Module. Neue Module hier eintragen.
 * Einzelne Module lassen sich per KUVERT_DISABLED_MODULES=id1,id2 abschalten.
 */
import type { ServerModule } from '../core/module.js';
import microsoft from './microsoft/index.js';
import google from './google/index.js';
import imap from './imap/index.js';
import dav from './dav/index.js';
import smime from './smime/index.js';
import ai from './ai/index.js';
import notifications from './notifications/index.js';
import mailcow from './mailcow/index.js';
import mailarchiver from './mailarchiver/index.js';
import search from './search/index.js';
import chat from './chat/index.js';
import triage from './triage/index.js';
import threecx from './threecx/index.js';
import timetrack from './timetrack/index.js';
import meet from './meet/index.js';

export const allModules: ServerModule[] = [microsoft, google, imap, dav, smime, ai, notifications, mailcow, mailarchiver, search, chat, triage, threecx, timetrack, meet];
