/**
 * Gemeinsame Hilfen für alle Google-APIs: authentifizierte Requests (mit einmaligem
 * Token-Refresh bei 401), Gmail-Quota-Drosselung, URL-Bau mit Mehrfachparametern,
 * Parallelitätsbegrenzung, Multipart-Bodies und ein kleiner LRU-Cache.
 */
import crypto from 'node:crypto';
import type { AccountContext } from '../../core/module.js';
import { isBackground } from '../../core/background.js';
import { AuthError } from '../../core/errors.js';
import { apiBuffer, apiFetch, apiJson, type RequestOptions } from '../../core/http.js';
import { createTokenManager } from '../../core/oauth.js';
import { googleOAuthClient } from './oauth.js';
import { gmailCost, gmailQuota, isGmailUrl } from './quota.js';

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];

/** URL mit (auch mehrfachen) Query-Parametern bauen */
export function gurl(base: string, params: Record<string, QueryValue> = {}): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export class GoogleClient {
  private tm;

  constructor(public readonly ctx: AccountContext) {
    this.tm = createTokenManager(ctx, googleOAuthClient);
  }

  get accountId(): string {
    return this.ctx.account.id;
  }

  get email(): string {
    return this.ctx.account.email;
  }

  private token = () => this.tm.getAccessToken();

  /** Führt den Request aus; bei 401 wird das Token einmal erneuert und erneut versucht. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      await this.tm.getAccessToken(true);
      return fn();
    }
  }

  /** Token und – für Gmail – Quota-Drosselung (Hintergrundarbeit nachrangig) */
  private opts(url: string, opts: Omit<RequestOptions, 'token'>): RequestOptions {
    if (!isGmailUrl(url)) return { ...opts, token: this.token };
    const quota = gmailQuota(this.email || this.accountId);
    const cost = gmailCost(opts.method ?? 'GET', url);
    const background = isBackground();
    return {
      ...opts,
      token: this.token,
      beforeAttempt: () => quota.acquire(cost, background),
      onThrottled: ({ retryAfterMs }) => quota.throttled(retryAfterMs),
    };
  }

  json<T = any>(url: string, opts: Omit<RequestOptions, 'token'> = {}): Promise<T> {
    return this.withRetry(() => apiJson<T>(url, this.opts(url, opts)));
  }

  fetch(url: string, opts: Omit<RequestOptions, 'token'> = {}): Promise<Response> {
    return this.withRetry(() => apiFetch(url, this.opts(url, opts)));
  }

  buffer(url: string, opts: Omit<RequestOptions, 'token'> = {}) {
    return this.withRetry(() => apiBuffer(url, this.opts(url, opts)));
  }

  /** Alle Seiten eines paginierten Endpunkts laden (nextPageToken). */
  async paged<T, R extends { nextPageToken?: string }>(
    makeUrl: (pageToken?: string) => string,
    pick: (res: R) => T[] | undefined,
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.json<R>(makeUrl(token));
      out.push(...(pick(res) ?? []));
      token = res.nextPageToken;
      if (!token) break;
    }
    return out;
  }
}

/** Führt fn für alle Elemente mit begrenzter Parallelität aus. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Baut einen multipart/related-Body (JSON-Metadaten + Binärinhalt). */
export function multipartRelated(metadata: unknown, data: Buffer, contentType: string): { body: Buffer; contentType: string } {
  const boundary = `kuvert_${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** Einfacher LRU-Cache mit Größenbegrenzung in Bytes. */
export class ByteLru<V extends { length: number }> {
  private map = new Map<string, V>();
  private bytes = 0;

  constructor(private maxBytes: number, private maxEntries = 50) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V) {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    if (value.length > this.maxBytes) return;
    this.map.set(key, value);
    this.bytes += value.length;
    while ((this.bytes > this.maxBytes || this.map.size > this.maxEntries) && this.map.size) {
      const [k, v] = this.map.entries().next().value as [string, V];
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }

  delete(key: string) {
    const v = this.map.get(key);
    if (v) {
      this.bytes -= v.length;
      this.map.delete(key);
    }
  }
}

/** Dekodiert RFC2047 encoded-words (=?utf-8?B?...?=), falls Google sie nicht schon dekodiert hat. */
export function decodeMimeWords(s: string | undefined): string {
  if (!s || !s.includes('=?')) return s ?? '';
  return s
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
                'latin1',
              );
        return new TextDecoder(charset.split('*')[0]!.toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
