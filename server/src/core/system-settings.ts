/**
 * Dienst-Einstellungen (Microsoft-/Google-OAuth-App, KI-Backend), die Administratoren
 * in der Oberfläche pflegen. Werte aus der .env dienen als Vorgabe; im Admin-Bereich
 * gesetzte Werte überschreiben sie und wirken sofort (ohne Neustart).
 * Geheimnisse werden AES-256-GCM-verschlüsselt gespeichert und nie ausgeliefert.
 */
import type { ServiceFieldState, ServiceKey, ServiceSettingsPatch, ServiceSettingsView } from '@kuvert/shared';
import { config, setServiceOverrides, type ServiceConfig, type ServiceOverrides } from '../config.js';
import { kv } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { BadRequestError } from './errors.js';

type FieldType = 'string' | 'secret' | 'boolean' | 'number' | 'enum';

interface FieldDef {
  type: FieldType;
  env: string[];
  options?: string[];
  validate?: (v: unknown) => string | null;
}

const urlCheck = (v: unknown) => (typeof v === 'string' && !/^https?:\/\/[^\s]+$/.test(v) ? 'Bitte eine gültige http(s)-URL angeben' : null);

export const SERVICE_FIELDS: { [K in ServiceKey]: Record<keyof ServiceConfig[K], FieldDef> } = {
  microsoft: {
    clientId: { type: 'string', env: ['MS_CLIENT_ID'] },
    clientSecret: { type: 'secret', env: ['MS_CLIENT_SECRET'] },
    tenant: { type: 'string', env: ['MS_TENANT'] },
  },
  google: {
    clientId: { type: 'string', env: ['GOOGLE_CLIENT_ID'] },
    clientSecret: { type: 'secret', env: ['GOOGLE_CLIENT_SECRET'] },
    placesApiKey: { type: 'secret', env: ['GOOGLE_PLACES_API_KEY'] },
  },
  ai: {
    enabled: { type: 'boolean', env: ['AI_ENABLED', 'OLLAMA_ENABLED'] },
    backend: { type: 'enum', env: ['AI_BACKEND'], options: ['ollama', 'openai'] },
    baseUrl: { type: 'string', env: ['AI_BASE_URL', 'OLLAMA_URL'], validate: urlCheck },
    model: { type: 'string', env: ['AI_MODEL', 'OLLAMA_MODEL'] },
    apiKey: { type: 'secret', env: ['AI_API_KEY'] },
    temperature: {
      type: 'number',
      env: ['AI_TEMPERATURE'],
      validate: (v) => (typeof v === 'number' && (v < 0 || v > 2) ? 'Temperatur muss zwischen 0 und 2 liegen' : null),
    },
  },
  search: {
    enabled: { type: 'boolean', env: ['SEARCH_ENABLED'] },
    url: { type: 'string', env: ['MEILI_URL'], validate: urlCheck },
    apiKey: { type: 'secret', env: ['MEILI_MASTER_KEY', 'MEILI_API_KEY'] },
    indexBodies: { type: 'boolean', env: ['SEARCH_INDEX_BODIES'] },
    maxAgeDays: {
      type: 'number',
      env: ['SEARCH_MAX_AGE_DAYS'],
      validate: (v) => (typeof v === 'number' && (v < 0 || v > 36500) ? 'Ungültige Anzahl Tage' : null),
    },
    includeTrash: { type: 'boolean', env: ['SEARCH_INCLUDE_TRASH'] },
    syncIntervalMin: {
      type: 'number',
      env: ['SEARCH_SYNC_INTERVAL'],
      validate: (v) => (typeof v === 'number' && (v < 1 || v > 1440) ? 'Intervall zwischen 1 und 1440 Minuten' : null),
    },
  },
};

const KEYS = Object.keys(SERVICE_FIELDS) as ServiceKey[];

/** Gespeichertes Format: Geheimnisse verschlüsselt */
type Stored = { [K in ServiceKey]?: Record<string, string | number | boolean> };

function loadStored(): Stored {
  return kv.get<Stored>('system', 'services') ?? {};
}

function toOverrides(stored: Stored): ServiceOverrides {
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of KEYS) {
    const section = stored[key];
    if (!section) continue;
    out[key] = {};
    for (const [field, value] of Object.entries(section)) {
      const def = (SERVICE_FIELDS[key] as Record<string, FieldDef>)[field];
      if (!def) continue;
      try {
        out[key][field] = def.type === 'secret' ? decrypt(String(value)) : value;
      } catch {
        /* nicht entschlüsselbar (APP_SECRET geändert?) → ignorieren */
      }
    }
  }
  return out as ServiceOverrides;
}

function envIsSet(names: string[]): boolean {
  return names.some((n) => (process.env[n] ?? '') !== '');
}

export const systemSettings = {
  /** Beim Start aufrufen: gespeicherte Überschreibungen aktivieren */
  init() {
    setServiceOverrides(toOverrides(loadStored()));
  },

  view(): ServiceSettingsView {
    const stored = loadStored();
    const build = <K extends ServiceKey>(key: K) => {
      const current = config[key] as unknown as Record<string, unknown>;
      const defaults = config.envDefaults[key] as unknown as Record<string, unknown>;
      const result: Record<string, ServiceFieldState> = {};
      for (const [field, def] of Object.entries(SERVICE_FIELDS[key] as Record<string, FieldDef>)) {
        const override = stored[key]?.[field];
        const hasOverride = override !== undefined && override !== '';
        const envSet = envIsSet(def.env);
        const secret = def.type === 'secret';
        result[field] = {
          secret,
          isSet: secret ? !!current[field] : current[field] !== '' && current[field] !== undefined,
          value: secret ? undefined : (current[field] as string | number | boolean),
          source: hasOverride ? 'admin' : envSet ? 'env' : 'default',
          envVar: def.env.join(' / '),
          envSet,
          envValue: secret ? undefined : (defaults[field] as string | number | boolean),
        };
      }
      return result;
    };
    return {
      microsoft: build('microsoft') as ServiceSettingsView['microsoft'],
      google: build('google') as ServiceSettingsView['google'],
      ai: build('ai') as ServiceSettingsView['ai'],
      search: build('search') as ServiceSettingsView['search'],
      publicUrl: config.publicUrl,
      redirectUri: config.oauthRedirectUri,
    };
  },

  /** Änderungen übernehmen; liefert die Liste geänderter Felder (für das Audit-Log, ohne Werte) */
  update(patch: ServiceSettingsPatch): string[] {
    const stored = loadStored();
    const changed: string[] = [];
    for (const key of KEYS) {
      const section = patch[key];
      if (!section) continue;
      const fields = SERVICE_FIELDS[key] as Record<string, FieldDef>;
      const target: Record<string, string | number | boolean> = { ...(stored[key] ?? {}) };
      for (const [field, raw] of Object.entries(section)) {
        const def = fields[field];
        if (!def) throw new BadRequestError(`Unbekanntes Feld: ${key}.${field}`);
        if (raw === undefined) continue;
        if (raw === null) {
          if (field in target) changed.push(`${key}.${field}`);
          delete target[field];
          continue;
        }
        let value: string | number | boolean = raw;
        switch (def.type) {
          case 'secret':
            if (typeof raw !== 'string') throw new BadRequestError(`${key}.${field} muss Text sein`);
            if (raw === '') continue; // leer = unverändert
            value = encrypt(raw.trim());
            break;
          case 'string':
            if (typeof raw !== 'string') throw new BadRequestError(`${key}.${field} muss Text sein`);
            value = raw.trim();
            if (field === 'baseUrl' || field === 'url') value = value.replace(/\/+$/, '');
            if (value === '') {
              if (field in target) changed.push(`${key}.${field}`);
              delete target[field];
              continue;
            }
            break;
          case 'boolean':
            if (typeof raw !== 'boolean') throw new BadRequestError(`${key}.${field} muss Ja/Nein sein`);
            break;
          case 'number':
            value = Number(raw);
            if (!Number.isFinite(value)) throw new BadRequestError(`${key}.${field} muss eine Zahl sein`);
            break;
          case 'enum':
            if (!def.options?.includes(String(raw))) throw new BadRequestError(`${key}.${field}: erlaubt sind ${def.options?.join(', ')}`);
            value = String(raw);
            break;
        }
        const problem = def.validate?.(def.type === 'secret' ? raw : value);
        if (problem) throw new BadRequestError(problem);
        target[field] = value;
        changed.push(`${key}.${field}`);
      }
      stored[key] = target;
    }
    kv.set('system', 'services', stored);
    setServiceOverrides(toOverrides(stored));
    return [...new Set(changed)];
  },
};
