/**
 * Ein- und Ausschalten von Modulen.
 *
 * Reihenfolge der Entscheidung (beim Start):
 *  1. Umgebungsvariablen KUVERT_MODULES / KUVERT_DISABLED_MODULES – haben Vorrang und sind
 *     in der Oberfläche nicht änderbar,
 *  2. isEnabled() des Moduls (z. B. S/MIME nur mit openssl) – „nicht verfügbar“,
 *  3. Abschaltliste aus dem Admin-Bereich (kv 'system'/'modules').
 *
 * Routen, Hooks und Hintergrundjobs werden nur beim Start eingehängt – Änderungen
 * im Admin-Bereich wirken daher erst nach einem Neustart.
 */
import fs from 'node:fs';
import type { AdminModulesView, AdminModuleState } from '@kuvert/shared';
import { config } from '../config.js';
import { getDb, kv } from './db.js';
import type { ServerModule } from './module.js';

interface Stored {
  disabled?: string[];
}

/** Per Umgebungsvariable zugelassen? */
export function envAllows(mod: ServerModule): boolean {
  if (config.enabledModules.length && !config.enabledModules.includes(mod.id)) return false;
  return !config.disabledModules.includes(mod.id);
}

/** Technisch nutzbar (isEnabled des Moduls)? */
export function moduleAvailable(mod: ServerModule): boolean {
  try {
    return mod.isEnabled ? mod.isEnabled() : true;
  } catch {
    return false;
  }
}

/**
 * Lässt sich Kuvert aus der Oberfläche neu starten? Nur in einem Container – dort startet die
 * Restart-Richtlinie (docker-compose: unless-stopped) den Prozess nach dem Beenden wieder.
 * KUVERT_RESTARTABLE=true/false überschreibt die Erkennung (z. B. für systemd oder Kubernetes).
 */
export function restartable(): boolean {
  const env = process.env.KUVERT_RESTARTABLE?.trim().toLowerCase();
  if (env === 'true' || env === '1') return true;
  if (env === 'false' || env === '0') return false;
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

export const moduleSettings = {
  /** Im Admin-Bereich abgeschaltete Module (erst nach runMigrations lesbar) */
  disabled(): string[] {
    return kv.get<Stored>('system', 'modules')?.disabled ?? [];
  },

  setEnabled(id: string, enabled: boolean) {
    const current = new Set(this.disabled());
    if (enabled) current.delete(id);
    else current.add(id);
    kv.set('system', 'modules', { disabled: [...current].sort() } satisfies Stored);
  },

  /** Übersicht aller Module; loadedIds = beim Start tatsächlich geladene Module */
  view(all: ServerModule[], loadedIds: Set<string>): AdminModulesView {
    const disabled = new Set(this.disabled());
    const rows = getDb().prepare('SELECT type, COUNT(*) AS n FROM accounts GROUP BY type').all() as { type: string; n: number }[];
    const accountsByType = new Map(rows.map((r) => [r.type, r.n]));

    const modules = all.map((mod): AdminModuleState => {
      const env = envAllows(mod);
      const available = env && moduleAvailable(mod);
      const status: AdminModuleState['status'] = !env ? 'env' : !available ? 'unavailable' : disabled.has(mod.id) ? 'disabled' : 'active';
      const loaded = loadedIds.has(mod.id);
      const accountTypes = (mod.accountTypes ?? []).map((t) => t.type);
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        status,
        loaded,
        // Nur Änderungen aus dem Admin-Bereich gelten als „wartet auf Neustart“
        pending: available && loaded !== (status === 'active'),
        toggleable: available,
        accountTypes,
        accounts: accountTypes.reduce((sum, t) => sum + (accountsByType.get(t) ?? 0), 0),
      };
    });
    return { modules, restartable: restartable(), pending: modules.some((m) => m.pending) };
  },
};
