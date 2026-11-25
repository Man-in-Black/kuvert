/**
 * Registry aller Frontend-Module. Reihenfolge = Priorität bei Erweiterungspunkten.
 */
import type { ModuleActivationContext, WebModule } from './types';
import mail from '@/features/mail/module';
import calendar from '@/features/calendar/module';
import contacts from '@/features/contacts/module';
import tasks from '@/features/tasks/module';
import files from '@/features/files/module';
import settings from '@/features/settings/module';
import ai from '@/features/ai/module';
import smime from '@/features/smime/module';
import meetings from '@/features/meetings/module';
import notifications from '@/features/notifications/module';
import admin from '@/features/admin/module';
import profile from '@/features/profile/module';
import mailcow from '@/features/mailcow/module';
import archive from '@/features/archive/module';
import search from '@/features/search/module';
import chat from '@/features/chat/module';
import triage from '@/features/triage/module';

export const allModules: WebModule[] = [
  mail,
  chat,
  calendar,
  contacts,
  tasks,
  files,
  archive,
  settings,
  search,
  profile,
  admin,
  ai,
  triage,
  smime,
  meetings,
  notifications,
  mailcow,
];

export function activeModules(ctx: ModuleActivationContext): WebModule[] {
  return allModules.filter((m) => (!m.feature || ctx.app.features[m.feature]) && (!m.isActive || m.isActive(ctx)));
}
