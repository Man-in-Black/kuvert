import type { FastifyBaseLogger } from 'fastify';
import type { AccountInfo, AccountSettings, AccountStatus, Capability } from '@kuvert/shared';
import { getDb } from './db.js';
import { decryptJson, encryptJson, uuid } from './crypto.js';
import { AppError, AuthError, NotFoundError, NotSupportedError } from './errors.js';
import type { AccountContext, AccountRecord, AccountSetupResult } from './module.js';
import type { ProviderSet } from './providers.js';
import type { Registry } from './registry.js';
import type { EventBus } from './events.js';

const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777', '#4f46e5', '#059669'];

const DEFAULT_SETTINGS: AccountSettings = { includeInUnifiedInbox: true, notify: true };

interface AccountRow {
  id: string;
  user_id: string;
  type: string;
  name: string;
  email: string;
  color: string;
  config_json: string;
  settings_json: string;
  secrets_enc: string | null;
  enabled: number;
  status: AccountStatus;
  status_message: string | null;
  sort: number;
}

function rowToRecord(r: AccountRow): AccountRecord {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    name: r.name,
    email: r.email,
    color: r.color,
    config: JSON.parse(r.config_json || '{}'),
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings_json || '{}') },
    secrets: decryptJson(r.secrets_enc),
    enabled: !!r.enabled,
    status: r.status,
    statusMessage: r.status_message,
    sort: r.sort,
  };
}

type CapKey = keyof ProviderSet;

/**
 * Verwaltet Konten und hält pro Konto eine (gecachte) Provider-Instanz.
 * Provider werden in einen Proxy gehüllt, der Authentifizierungsfehler erkennt
 * und den Kontostatus automatisch auf "reauth" setzt.
 */
export class AccountService {
  private cache = new Map<string, ProviderSet>();

  constructor(
    private registry: Registry,
    private bus: EventBus,
    private log: FastifyBaseLogger,
  ) {}

  /* ───────────── Lesen ───────────── */

  list(userId: string): AccountRecord[] {
    const rows = getDb().prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY sort, created_at').all(userId) as AccountRow[];
    return rows.map(rowToRecord);
  }

  listAllEnabled(): AccountRecord[] {
    const rows = getDb().prepare('SELECT * FROM accounts WHERE enabled = 1').all() as AccountRow[];
    return rows.map(rowToRecord);
  }

  findById(id: string): AccountRecord | undefined {
    const row = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  get(userId: string, id: string): AccountRecord {
    const acc = this.findById(id);
    if (!acc || acc.userId !== userId) throw new NotFoundError('Konto');
    return acc;
  }

  capabilities(acc: AccountRecord): Capability[] {
    const def = this.registry.getAccountType(acc.type);
    if (!def) return [];
    return def.getCapabilities ? def.getCapabilities(acc) : def.capabilities;
  }

  toInfo(acc: AccountRecord): AccountInfo {
    return {
      id: acc.id,
      type: acc.type,
      name: acc.name,
      email: acc.email,
      color: acc.color,
      capabilities: this.capabilities(acc),
      enabled: acc.enabled,
      status: acc.status,
      statusMessage: acc.statusMessage,
      settings: acc.settings,
      config: acc.config,
      sort: acc.sort,
    };
  }

  /** Alle aktiven Konten eines Benutzers mit einer bestimmten Fähigkeit */
  withCapability(userId: string, cap: Capability): AccountRecord[] {
    return this.list(userId).filter((a) => a.enabled && this.capabilities(a).includes(cap));
  }

  /* ───────────── Schreiben ───────────── */

  create(userId: string, type: string, setup: AccountSetupResult): AccountRecord {
    const def = this.registry.getAccountType(type);
    if (!def) throw new AppError(400, 'unknown_type', `Unbekannter Kontotyp: ${type}`);
    const existing = this.list(userId);
    const id = uuid();
    const color = setup.color ?? PALETTE[existing.length % PALETTE.length];
    getDb()
      .prepare(
        `INSERT INTO accounts (id, user_id, type, name, email, color, config_json, settings_json, secrets_enc, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        type,
        setup.name || setup.email,
        setup.email,
        color,
        JSON.stringify(setup.config ?? {}),
        JSON.stringify({ ...DEFAULT_SETTINGS, ...(setup.settings ?? {}) }),
        encryptJson(setup.secrets),
        existing.length,
      );
    const acc = this.findById(id)!;
    this.bus.internal.emit('account.created', acc);
    return acc;
  }

  /** Bestehendes Konto (gleicher Typ + E-Mail) neu verbinden statt doppelt anlegen. */
  createOrReconnect(userId: string, type: string, setup: AccountSetupResult, accountId?: string): AccountRecord {
    const match = accountId
      ? this.get(userId, accountId)
      : this.list(userId).find((a) => a.type === type && a.email.toLowerCase() === setup.email.toLowerCase());
    if (!match) return this.create(userId, type, setup);
    this.update(userId, match.id, {
      config: { ...match.config, ...(setup.config ?? {}) },
      secrets: { ...match.secrets, ...setup.secrets },
      status: 'ok',
      statusMessage: null,
    });
    return this.findById(match.id)!;
  }

  update(
    userId: string,
    id: string,
    patch: Partial<Pick<AccountRecord, 'name' | 'color' | 'enabled' | 'config' | 'secrets' | 'status' | 'statusMessage' | 'sort' | 'email'>> & {
      settings?: Partial<AccountSettings>;
    },
  ): AccountRecord {
    const acc = this.get(userId, id);
    const next: AccountRecord = {
      ...acc,
      ...patch,
      settings: { ...acc.settings, ...(patch.settings ?? {}) },
    } as AccountRecord;
    getDb()
      .prepare(
        `UPDATE accounts SET name = ?, email = ?, color = ?, enabled = ?, config_json = ?, settings_json = ?, secrets_enc = ?,
         status = ?, status_message = ?, sort = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.email,
        next.color,
        next.enabled ? 1 : 0,
        JSON.stringify(next.config),
        JSON.stringify(next.settings),
        encryptJson(next.secrets),
        next.status,
        next.statusMessage ?? null,
        next.sort,
        id,
      );
    const connectionRelevant = patch.config || patch.secrets || patch.enabled !== undefined || patch.settings?.sharedMailboxes;
    if (connectionRelevant) void this.invalidate(id);
    const updated = this.findById(id)!;
    this.bus.internal.emit('account.updated', updated);
    return updated;
  }

  async delete(userId: string, id: string) {
    const acc = this.get(userId, id);
    await this.invalidate(id);
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.bus.internal.emit('account.deleted', acc);
  }

  reorder(userId: string, ids: string[]) {
    const stmt = getDb().prepare('UPDATE accounts SET sort = ? WHERE id = ? AND user_id = ?');
    getDb().transaction(() => ids.forEach((id, i) => stmt.run(i, id, userId)))();
  }

  setStatus(id: string, status: AccountStatus, message?: string | null) {
    const acc = this.findById(id);
    if (!acc || (acc.status === status && (acc.statusMessage ?? null) === (message ?? null))) return;
    getDb().prepare('UPDATE accounts SET status = ?, status_message = ? WHERE id = ?').run(status, message ?? null, id);
    this.bus.publish(acc.userId, { type: 'account.status', accountId: id, status, message: message ?? null });
  }

  /* ───────────── Provider ───────────── */

  async invalidate(id: string) {
    const set = this.cache.get(id);
    this.cache.delete(id);
    if (!set) return;
    for (const p of Object.values(set)) {
      try {
        await (p as { dispose?: () => Promise<void> })?.dispose?.();
      } catch (err) {
        this.log.warn({ err, accountId: id }, 'Provider dispose fehlgeschlagen');
      }
    }
  }

  /** Konto-Kontext für Module, die ein Konto außerhalb der Provider nutzen (z. B. Teams-Chat-Brücke) */
  contextFor(id: string): AccountContext {
    return this.context(id);
  }

  private context(id: string): AccountContext {
    const svc = this;
    return {
      get account() {
        const acc = svc.findById(id);
        if (!acc) throw new NotFoundError('Konto');
        return acc;
      },
      setSecrets(patch) {
        const acc = svc.findById(id);
        if (!acc) return;
        getDb().prepare('UPDATE accounts SET secrets_enc = ? WHERE id = ?').run(encryptJson({ ...acc.secrets, ...patch }), id);
      },
      setConfig(patch) {
        const acc = svc.findById(id);
        if (!acc) return;
        getDb().prepare('UPDATE accounts SET config_json = ? WHERE id = ?').run(JSON.stringify({ ...acc.config, ...patch }), id);
      },
      setStatus(status, message) {
        svc.setStatus(id, status, message);
      },
      log: this.log.child({ accountId: id }),
    };
  }

  /** Provider-Set eines Kontos (mit Prüfung, dass das Konto dem Benutzer gehört) */
  providers(userId: string, accountId: string): ProviderSet {
    const acc = this.get(userId, accountId);
    return this.providersFor(acc);
  }

  providersFor(acc: AccountRecord): ProviderSet {
    if (!acc.enabled) throw new AppError(409, 'account_disabled', `Konto "${acc.name}" ist deaktiviert`);
    let set = this.cache.get(acc.id);
    if (!set) {
      const def = this.registry.getAccountType(acc.type);
      if (!def) throw new AppError(500, 'unknown_type', `Kontotyp ${acc.type} ist nicht geladen (Modul deaktiviert?)`);
      const raw = def.createProviders(this.context(acc.id));
      set = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v) (set as Record<string, unknown>)[k] = this.wrap(acc.id, v as object);
      }
      this.cache.set(acc.id, set);
    }
    return set;
  }

  /** Liefert einen bestimmten Provider oder wirft einen verständlichen Fehler. */
  require<K extends CapKey>(userId: string, accountId: string, cap: K): NonNullable<ProviderSet[K]> {
    const p = this.providers(userId, accountId)[cap];
    if (!p) throw new NotSupportedError(`${cap} für dieses Konto`);
    return p as NonNullable<ProviderSet[K]>;
  }

  /** Proxy: Auth-Fehler → Status "reauth", erfolgreiche Aufrufe → Status "ok" */
  private wrap<T extends object>(accountId: string, provider: T): T {
    const svc = this;
    return new Proxy(provider, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'dispose') return value;
        return function (this: unknown, ...args: unknown[]) {
          let result: unknown;
          try {
            result = value.apply(target, args);
          } catch (err) {
            svc.onProviderError(accountId, err);
            throw err;
          }
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<unknown>).then(
              (v) => {
                const acc = svc.findById(accountId);
                if (acc && acc.status !== 'ok') svc.setStatus(accountId, 'ok', null);
                return v;
              },
              (err) => {
                svc.onProviderError(accountId, err);
                throw err;
              },
            );
          }
          return result;
        };
      },
    });
  }

  private onProviderError(accountId: string, err: unknown) {
    if (err instanceof AuthError) this.setStatus(accountId, 'reauth', err.message);
  }
}
