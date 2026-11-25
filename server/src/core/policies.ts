import type { SystemPolicies } from '@kuvert/shared';
import { config } from '../config.js';
import { kv } from './db.js';

/** Systemweite Richtlinien (Admin-Bereich). Umgebungsvariablen liefern die Standardwerte. */
export const policies = {
  get(): SystemPolicies {
    const stored = kv.get<Partial<SystemPolicies>>('system', 'policies') ?? {};
    return {
      allowRegistration: config.allowRegistration,
      require2fa: false,
      sessionDays: config.sessionDays,
      allowedAccountTypes: [],
      maxAccountsPerUser: 0,
      usersCanCreateApiTokens: true,
      ...stored,
    };
  },

  set(patch: Partial<SystemPolicies>): SystemPolicies {
    const next = { ...this.get(), ...patch };
    kv.set('system', 'policies', next);
    return next;
  },

  accountTypeAllowed(type: string): boolean {
    const allowed = this.get().allowedAccountTypes;
    return !allowed.length || allowed.includes(type);
  },
};
