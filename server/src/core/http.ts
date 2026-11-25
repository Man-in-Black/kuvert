import { AuthError, HttpError } from './errors.js';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Objekt → JSON, string/Buffer → unverändert */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Bearer-Token (String oder asynchroner Lieferant, wird bei 401 einmal neu geholt) */
  token?: string | (() => Promise<string>);
  /** Maximale Wiederholungen bei 429/503 */
  retries?: number;
  timeoutMs?: number;
  /** Bei 401 nicht AuthError, sondern HttpError werfen */
  noAuthError?: boolean;
  /** Vor jedem Versuch (auch Wiederholungen), z. B. um auf freie Quota zu warten */
  beforeAttempt?: () => Promise<void>;
  /** Der Anbieter hat gedrosselt (429/503/504 bzw. Google-403 rateLimitExceeded) */
  onThrottled?: (info: { status: number; retryAfterMs?: number }) => void;
}

export function withQuery(url: string, query?: RequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch mit Fehlerbehandlung, Retry bei Throttling (429/503, Retry-After) und
 * Umwandlung von 401 in AuthError (→ Konto wird als "neu verbinden" markiert).
 */
export async function apiFetch(url: string, opts: RequestOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const fullUrl = withQuery(url, opts.query);
  let body: RequestInit['body'] | undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string' || opts.body instanceof Uint8Array || opts.body instanceof ArrayBuffer || opts.body instanceof URLSearchParams) {
      body = opts.body as RequestInit['body'];
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] ??= 'application/json';
    }
  }

  for (let attempt = 0; ; attempt++) {
    if (opts.beforeAttempt) await opts.beforeAttempt();
    if (opts.token) {
      const t = typeof opts.token === 'function' ? await opts.token() : opts.token;
      headers['Authorization'] = `Bearer ${t}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(fullUrl, { method: opts.method ?? 'GET', headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new HttpError(502, `Verbindung zu ${new URL(fullUrl).host} fehlgeschlagen: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    const ra = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    const backoff = () => sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, 30_000) : 1000 * 2 ** attempt);
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      opts.onThrottled?.({ status: res.status, retryAfterMs });
      if (attempt < retries) {
        await res.body?.cancel().catch(() => undefined);
        await backoff();
        continue;
      }
    }
    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* kein JSON */
    }
    if (res.status === 403 && isGoogleRateLimit(parsed)) {
      opts.onThrottled?.({ status: res.status, retryAfterMs });
      if (attempt < retries) {
        await backoff();
        continue;
      }
    }
    const msg = extractErrorMessage(parsed) ?? `${res.status} ${res.statusText}`;
    if (res.status === 401 && !opts.noAuthError) throw new AuthError(`Anbieter meldet: ${msg}`, parsed);
    throw new HttpError(res.status, msg, parsed);
  }
}

export async function apiJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiFetch(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiBuffer(url: string, opts: RequestOptions = {}): Promise<{ data: Buffer; contentType: string; headers: Headers }> {
  const res = await apiFetch(url, opts);
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    headers: res.headers,
  };
}

/** Google meldet Ratenbegrenzung teils als 403 (rateLimitExceeded/userRateLimitExceeded) statt 429 */
function isGoogleRateLimit(body: unknown): boolean {
  const e = (body as { error?: unknown } | null)?.error as
    | { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] }
    | undefined;
  if (!e || typeof e !== 'object') return false;
  if (e.status === 'RESOURCE_EXHAUSTED') return true;
  const list = (v: unknown) => (Array.isArray(v) ? (v as { reason?: string }[]) : []);
  return [...list(e.errors), ...list(e.details)].some(
    (x) => x?.reason === 'rateLimitExceeded' || x?.reason === 'userRateLimitExceeded' || x?.reason === 'RATE_LIMIT_EXCEEDED',
  );
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body.length < 300 ? body : undefined;
  const b = body as Record<string, any>;
  return (
    b.error?.message ??
    b.error_description ??
    (typeof b.error === 'string' ? b.error : undefined) ??
    b.message ??
    undefined
  );
}
