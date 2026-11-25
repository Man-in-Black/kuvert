/**
 * Defensive Umwandlung der mailcow-Antworten (Felder variieren je nach Version,
 * Zahlen kommen teils als Strings, Wahrheitswerte als "1"/1/true).
 */
import type {
  MailcowAlias,
  MailcowAppPassword,
  MailcowContainer,
  MailcowDomain,
  MailcowMailbox,
  MailcowQuarantineItem,
  MailcowStatus,
  MailcowSyncJob,
  MailcowTempAlias,
} from '@kuvert/shared';

type Raw = Record<string, unknown>;

export const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.').replace(/[%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

/** Unix-Sekunden, ISO-String oder "YYYY-MM-DD HH:MM:SS" → ISO */
export function iso(v: unknown): string | null {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return null;
  if (typeof v === 'number' || /^\d{9,11}$/.test(String(v))) return new Date(num(v) * 1000).toISOString();
  const s = String(v).replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function mapMailbox(r: Raw): MailcowMailbox {
  const username = str(r.username);
  const [localPart, domain] = username.includes('@') ? username.split('@') : [str(r.local_part), str(r.domain)];
  const quota = num(r.quota);
  const quotaUsed = num(r.quota_used);
  return {
    username,
    name: str(r.name),
    domain: str(r.domain) || domain || '',
    localPart: str(r.local_part) || localPart || '',
    active: bool(r.active) || bool(r.active_int),
    quota,
    quotaUsed,
    percentInUse: r.percent_in_use !== undefined && r.percent_in_use !== '- ' ? num(r.percent_in_use) : quota > 0 ? Math.round((quotaUsed / quota) * 100) : 0,
    messages: num(r.messages),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(str) : undefined,
    lastLogin: iso(r.last_imap_login ?? (r.last_login as Raw | undefined)?.imap),
  };
}

export function mapDomain(r: Raw): MailcowDomain {
  return {
    domain: str(r.domain_name ?? r.domain),
    active: bool(r.active) || bool(r.active_int),
    description: str(r.description) || undefined,
    mailboxes: r.mboxes_in_domain !== undefined ? num(r.mboxes_in_domain) : undefined,
    maxMailboxes: r.max_num_mboxes_for_domain !== undefined ? num(r.max_num_mboxes_for_domain) : r.mailboxes !== undefined ? num(r.mailboxes) : undefined,
    aliases: r.aliases_in_domain !== undefined ? num(r.aliases_in_domain) : undefined,
    maxAliases: r.max_num_aliases_for_domain !== undefined ? num(r.max_num_aliases_for_domain) : r.aliases_left !== undefined ? num(r.aliases_left) : undefined,
    quotaUsed: r.quota_used_in_domain !== undefined ? num(r.quota_used_in_domain) : r.bytes_total !== undefined ? num(r.bytes_total) : undefined,
    maxQuota: r.max_quota_for_domain !== undefined ? num(r.max_quota_for_domain) : undefined,
  };
}

export function mapAlias(r: Raw): MailcowAlias {
  return {
    id: str(r.id),
    address: str(r.address),
    goto: str(r.goto),
    active: bool(r.active) || bool(r.active_int),
    domain: str(r.domain) || undefined,
    isCatchAll: bool(r.is_catch_all),
    comment: str(r.public_comment || r.private_comment) || undefined,
  };
}

export function mapTempAlias(r: Raw): MailcowTempAlias {
  return {
    address: str(r.address),
    goto: str(r.goto),
    validUntil: iso(r.validity),
    createdAt: iso(r.created),
    description: str(r.description) || null,
  };
}

export function mapAppPassword(r: Raw): MailcowAppPassword {
  const protocols: string[] = [];
  for (const p of ['imap_access', 'smtp_access', 'dav_access', 'eas_access', 'pop3_access', 'sieve_access']) {
    if (bool(r[p])) protocols.push(p);
  }
  if (Array.isArray(r.protocols)) for (const p of r.protocols as unknown[]) if (!protocols.includes(str(p))) protocols.push(str(p));
  return { id: str(r.id), name: str(r.name ?? r.app_name), active: bool(r.active) || bool(r.active_int), protocols, createdAt: iso(r.created) };
}

export function mapQuarantine(r: Raw): MailcowQuarantineItem {
  return {
    id: str(r.id),
    qid: str(r.qid) || undefined,
    sender: str(r.sender),
    recipient: str(r.rcpt),
    subject: str(r.subject),
    score: r.score !== undefined ? num(r.score) : null,
    createdAt: iso(r.created),
    virus: bool(r.virus_flag),
    notified: bool(r.notified),
  };
}

export function mapSyncJob(r: Raw): MailcowSyncJob {
  return {
    id: str(r.id),
    mailbox: str(r.user2 ?? r.username),
    host: str(r.host1),
    remoteUser: str(r.user1),
    active: bool(r.active) || bool(r.active_int),
    running: bool(r.is_running),
    lastRun: iso(r.last_run),
    intervalMin: r.mins_interval !== undefined ? num(r.mins_interval) : null,
  };
}

export function mapStatus(version: unknown, containers: unknown, vmail: unknown): MailcowStatus {
  const list: MailcowContainer[] = [];
  if (containers && typeof containers === 'object') {
    for (const [key, v] of Object.entries(containers as Record<string, Raw>)) {
      if (!v || typeof v !== 'object') continue;
      const state = str(v.state);
      list.push({
        name: str(v.container) || key,
        state,
        running: state === 'running',
        image: str(v.image) || undefined,
        startedAt: iso(v.started_at),
      });
    }
  }
  const vm = vmail && typeof vmail === 'object' ? (vmail as Raw) : null;
  return {
    version: version && typeof version === 'object' ? str((version as Raw).version) || null : null,
    containers: list.sort((a, b) => a.name.localeCompare(b.name)),
    vmail: vm ? { used: str(vm.used) || undefined, total: str(vm.total) || undefined, usedPercent: vm.used_percent !== undefined ? num(vm.used_percent) : null } : null,
  };
}
