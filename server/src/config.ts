import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function list(name: string): string[] {
  return env(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Version aus server/package.json – gebündelt liegt der Code in server/dist/,
 * im Dev-Betrieb (tsx) in server/src/; in beiden Fällen ist sie eine Ebene höher.
 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version || 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

const dataDir = path.resolve(env('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });

/** Liest ein persistentes Secret aus der Umgebung oder erzeugt es einmalig im Datenverzeichnis. */
function persistentSecret(envName: string, file: string, gen: () => string): string {
  const fromEnv = env(envName);
  if (fromEnv) return fromEnv;
  const p = path.join(dataDir, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const value = gen();
  fs.writeFileSync(p, value, { mode: 0o600 });
  return value;
}

/* ───────────── Dienste: .env-Vorgaben + Laufzeit-Überschreibungen aus dem Admin-Bereich ───────────── */

export interface ServiceConfig {
  microsoft: { clientId: string; clientSecret: string; tenant: string };
  google: {
    clientId: string;
    clientSecret: string;
    /** API-Schlüssel für die Ortssuche (Places API New) im Termin-Dialog */
    placesApiKey: string;
  };
  ai: { enabled: boolean; backend: 'ollama' | 'openai'; baseUrl: string; apiKey: string; model: string; temperature: number };
  search: {
    enabled: boolean;
    /** Meilisearch-URL, z. B. http://meilisearch:7700 (leer = kein Index, Live-Suche beim Anbieter) */
    url: string;
    apiKey: string;
    /** Nachrichtentext indizieren (sonst nur Betreff, Absender, Empfänger, Vorschau, Anhangnamen) */
    indexBodies: boolean;
    /** Nur Nachrichten der letzten n Tage (0 = alle) */
    maxAgeDays: number;
    /** Papierkorb und Spam mit indizieren */
    includeTrash: boolean;
    /** Abgleich-Intervall für neue Nachrichten in Minuten */
    syncIntervalMin: number;
  };
}

export type ServiceOverrides = { [K in keyof ServiceConfig]?: Partial<ServiceConfig[K]> };

const envDefaults: ServiceConfig = {
  microsoft: {
    clientId: env('MS_CLIENT_ID'),
    clientSecret: env('MS_CLIENT_SECRET'),
    tenant: env('MS_TENANT', 'common'),
  },
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    placesApiKey: env('GOOGLE_PLACES_API_KEY'),
  },
  ai: {
    enabled: env('AI_ENABLED', env('OLLAMA_ENABLED', 'true')) !== 'false',
    backend: env('AI_BACKEND', 'ollama') as 'ollama' | 'openai',
    baseUrl: env('AI_BASE_URL', env('OLLAMA_URL', 'http://ollama:11434')).replace(/\/+$/, ''),
    apiKey: env('AI_API_KEY'),
    model: env('AI_MODEL', env('OLLAMA_MODEL', 'llama3.1:8b')),
    temperature: Number(env('AI_TEMPERATURE', '0.4')),
  },
  search: {
    enabled: env('SEARCH_ENABLED', 'true') !== 'false',
    url: env('MEILI_URL').replace(/\/+$/, ''),
    apiKey: env('MEILI_MASTER_KEY', env('MEILI_API_KEY')),
    indexBodies: env('SEARCH_INDEX_BODIES', 'true') !== 'false',
    maxAgeDays: Number(env('SEARCH_MAX_AGE_DAYS', '0')),
    includeTrash: env('SEARCH_INCLUDE_TRASH', 'false') === 'true',
    syncIntervalMin: Number(env('SEARCH_SYNC_INTERVAL', '5')),
  },
};

let overrides: ServiceOverrides = {};

/** Wird von core/system-settings.ts gesetzt (Start + jede Änderung im Admin-Bereich). */
export function setServiceOverrides(o: ServiceOverrides) {
  overrides = o;
}

function merged<K extends keyof ServiceConfig>(key: K): ServiceConfig[K] {
  const result = { ...envDefaults[key] } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides[key] ?? {})) {
    if (v !== undefined && v !== null && v !== '') result[k] = v;
  }
  return result as ServiceConfig[K];
}

const publicUrl = env('PUBLIC_URL', `http://localhost:${env('PORT', '8080')}`).replace(/\/+$/, '');

export const config = {
  appName: env('APP_NAME', 'Kuvert'),
  version: appVersion(),
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir,
  appSecret: persistentSecret('APP_SECRET', 'app-secret.key', () => crypto.randomBytes(48).toString('base64url')),
  logLevel: env('LOG_LEVEL', 'info'),
  /** Statische Dateien des Web-Clients (Produktion) */
  webDist: path.resolve(env('WEB_DIST', path.join(process.cwd(), '../web/dist'))),
  allowRegistration: env('ALLOW_REGISTRATION', 'false') === 'true',
  sessionDays: Number(env('SESSION_DAYS', '30')),
  /** Nur diese Module laden (leer = alle) */
  enabledModules: list('KUVERT_MODULES'),
  /** Diese Module nicht laden */
  disabledModules: list('KUVERT_DISABLED_MODULES'),
  pollIntervalSec: Number(env('POLL_INTERVAL', '60')),
  /** Gmail-Quota je Nutzer und Minute (Google-Standard 15.000; Instanzen mit gleichem OAuth-Projekt teilen sie) */
  gmailQuotaPerMin: Math.max(500, Number(env('GMAIL_QUOTA_PER_MIN', '15000')) || 15000),
  uploadMaxMb: Number(env('UPLOAD_MAX_MB', '35')),

  /** Microsoft 365 – .env-Vorgabe, im Admin-Bereich überschreibbar */
  get microsoft(): ServiceConfig['microsoft'] {
    return merged('microsoft');
  },
  /** Google – .env-Vorgabe, im Admin-Bereich überschreibbar */
  get google(): ServiceConfig['google'] {
    return merged('google');
  },
  /** KI-Backend: "ollama" (Standard) oder "openai" (OpenAI-kompatibel: LM Studio, vLLM, LocalAI …) */
  get ai(): ServiceConfig['ai'] {
    return merged('ai');
  },
  /** Volltext-Suchindex (Meilisearch) – .env-Vorgabe, im Admin-Bereich überschreibbar */
  get search(): ServiceConfig['search'] {
    return merged('search');
  },
  /** Ursprüngliche Werte aus der Umgebung (.env), ohne Admin-Überschreibungen */
  envDefaults,
  vapid: {
    subject: env('VAPID_SUBJECT', 'mailto:admin@localhost'),
    publicKey: env('VAPID_PUBLIC_KEY'),
    privateKey: env('VAPID_PRIVATE_KEY'),
  },
  smime: {
    opensslBin: env('OPENSSL_BIN', 'openssl'),
    caFile: env('SMIME_CA_FILE', '/etc/ssl/certs/ca-certificates.crt'),
    /**
     * Mozilla-Wurzeln mit E-Mail-Vertrauensbit (server/assets/) – das Systembundle enthält nur
     * TLS-Wurzeln, reine S/MIME-CAs (Sectigo, HARICA, D-Trust SBR, …) fehlen dort.
     * Liegt wie package.json eine Ebene über src/ bzw. dist/.
     */
    emailRootsFile: env('SMIME_ROOTS_FILE', fileURLToPath(new URL('../assets/smime-roots.pem', import.meta.url))),
    /** Zusätzliche vertrauenswürdige CAs, z. B. eine firmeninterne Zertifizierungsstelle (PEM) */
    extraCaFile: env('SMIME_EXTRA_CA_FILE', ''),
  },
  /** Redirect-URI für alle OAuth-Provider */
  get oauthRedirectUri() {
    return `${publicUrl}/api/oauth/callback`;
  },
};

export type AppConfig = typeof config;
