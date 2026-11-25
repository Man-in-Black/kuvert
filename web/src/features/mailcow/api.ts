/** API-Zugriffe und Query-Hooks der mailcow-Integration. */
import { useQuery } from '@tanstack/react-query';
import type {
  MailcowAlias,
  MailcowAppPassword,
  MailcowDomain,
  MailcowInstanceInfo,
  MailcowLink,
  MailcowLinkedMailbox,
  MailcowMailbox,
  MailcowQuarantineItem,
  MailcowStatus,
  MailcowSyncJob,
  MailcowTempAlias,
} from '@kuvert/shared';
import { api } from '@/lib/api';

export const mk = {
  all: ['mailcow'] as const,
  instances: ['mailcow', 'instances'] as const,
  inst: (id: string, part: string) => ['mailcow', 'inst', id, part] as const,
  links: ['mailcow', 'links'] as const,
  mine: ['mailcow', 'me'] as const,
  me: (instanceId: string, mailbox: string, part: string) => ['mailcow', 'me', instanceId, mailbox, part] as const,
};

const e = encodeURIComponent;
export const instPath = (id: string, rest = '') => `/mailcow/instances/${e(id)}${rest}`;
export const mePath = (instanceId: string, mailbox: string, rest: string) => `/mailcow/me/${e(instanceId)}/${e(mailbox)}${rest}`;

export function useInstances(enabled = true) {
  return useQuery({ queryKey: mk.instances, queryFn: () => api<MailcowInstanceInfo[]>('/mailcow/instances'), enabled });
}

export function useInstanceData<T>(id: string | undefined, part: 'status' | 'domains' | 'mailboxes' | 'aliases' | 'quarantine' | 'syncjobs') {
  return useQuery({
    queryKey: mk.inst(id ?? '', part),
    queryFn: () => api<T>(instPath(id!, `/${part}`)),
    enabled: !!id,
    retry: false,
  });
}

export const useStatus = (id?: string) => useInstanceData<MailcowStatus>(id, 'status');
export const useDomains = (id?: string) => useInstanceData<MailcowDomain[]>(id, 'domains');
export const useMailboxes = (id?: string) => useInstanceData<MailcowMailbox[]>(id, 'mailboxes');
export const useAliases = (id?: string) => useInstanceData<MailcowAlias[]>(id, 'aliases');
export const useQuarantine = (id?: string) => useInstanceData<MailcowQuarantineItem[]>(id, 'quarantine');
export const useSyncJobs = (id?: string) => useInstanceData<MailcowSyncJob[]>(id, 'syncjobs');

export function useLinks(enabled = true) {
  return useQuery({ queryKey: mk.links, queryFn: () => api<MailcowLink[]>('/mailcow/links'), enabled });
}

export function useMyMailboxes() {
  return useQuery({ queryKey: mk.mine, queryFn: () => api<MailcowLinkedMailbox[]>('/mailcow/me/mailboxes'), staleTime: 30_000 });
}

export function useMine<T>(instanceId: string, mailbox: string, part: 'aliases' | 'temp-aliases' | 'app-passwords' | 'quarantine') {
  return useQuery({ queryKey: mk.me(instanceId, mailbox, part), queryFn: () => api<T>(mePath(instanceId, mailbox, `/${part}`)), retry: false });
}

export const useMyAliases = (i: string, m: string) => useMine<MailcowAlias[]>(i, m, 'aliases');
export const useMyTempAliases = (i: string, m: string) => useMine<MailcowTempAlias[]>(i, m, 'temp-aliases');
export const useMyAppPasswords = (i: string, m: string) => useMine<MailcowAppPassword[]>(i, m, 'app-passwords');
export const useMyQuarantine = (i: string, m: string) => useMine<MailcowQuarantineItem[]>(i, m, 'quarantine');

export const PROTOCOL_LABELS: Record<string, string> = {
  imap_access: 'IMAP',
  smtp_access: 'SMTP',
  dav_access: 'Kalender/Kontakte (DAV)',
  eas_access: 'ActiveSync',
  pop3_access: 'POP3',
  sieve_access: 'Sieve (Filter)',
};

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toLocaleString('de-DE', { maximumFractionDigits: i >= 3 ? 1 : 0 })} ${units[i]}`;
}

export function formatDate(iso?: string | null, withTime = true): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('de-DE', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function generatePassword(len = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+?';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  // mind. je ein Groß-, Kleinbuchstabe, Ziffer, Sonderzeichen
  const base = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${base.slice(0, len - 4)}Aa7#`;
}
