/**
 * Minimaler Meilisearch-Client (REST). Bewusst ohne zusätzliche Abhängigkeit.
 * Doku: https://www.meilisearch.com/docs/reference/api/overview
 */
import http from 'node:http';
import https from 'node:https';
import { HttpError } from '../../core/errors.js';

/*
 * Bewusst node:http statt fetch: fetch (undici) schreibt Header und Body in getrennten
 * Paketen; zusammen mit TCP-Delayed-ACK kostet das auf Keep-Alive-Verbindungen ~40 ms
 * pro Anfrage. Mit einem einzigen Schreibvorgang antwortet Meilisearch in ~1 ms.
 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function rawRequest(url: string, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method,
        agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung nach ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

export interface MeiliTask {
  taskUid: number;
}

export interface MeiliSearchParams {
  q?: string;
  filter?: string | (string | string[])[];
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  attributesToCrop?: string[];
  cropLength?: number;
  cropMarker?: string;
  highlightPreTag?: string;
  highlightPostTag?: string;
  matchingStrategy?: 'last' | 'all' | 'frequency';
  attributesToSearchOn?: string[];
  facets?: string[];
}

export interface MeiliSearchResponse<T> {
  hits: (T & { _formatted?: Partial<Record<keyof T, unknown>> })[];
  estimatedTotalHits?: number;
  totalHits?: number;
  processingTimeMs: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

export class MeiliClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: { status: number; text: string };
    try {
      res = await rawRequest(`${this.baseUrl}${path}`, method, headers, body === undefined ? undefined : JSON.stringify(body), timeoutMs);
    } catch (err) {
      throw new HttpError(502, `Meilisearch nicht erreichbar (${this.baseUrl}): ${(err as Error).message}`);
    }
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = res.text;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (json as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      throw new HttpError(res.status === 401 || res.status === 403 ? 502 : res.status, `Meilisearch: ${msg}`, json);
    }
    return json as T;
  }

  health() {
    return this.request<{ status: string }>('GET', '/health', undefined, 4000);
  }

  version() {
    return this.request<{ pkgVersion: string }>('GET', '/version', undefined, 4000);
  }

  async waitTask(taskUid: number, timeoutMs = 60_000): Promise<{ status: string; error?: { message: string } }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.request<{ status: string; error?: { message: string } }>('GET', `/tasks/${taskUid}`);
      if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'canceled') {
        if (t.status === 'failed') throw new HttpError(502, `Meilisearch-Aufgabe fehlgeschlagen: ${t.error?.message ?? 'unbekannt'}`);
        return t;
      }
      if (Date.now() > until) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async getIndex(uid: string): Promise<{ uid: string } | null> {
    try {
      return await this.request<{ uid: string }>('GET', `/indexes/${uid}`);
    } catch (err) {
      if ((err as HttpError).status === 404) return null;
      throw err;
    }
  }

  async createIndex(uid: string, primaryKey: string) {
    const t = await this.request<MeiliTask>('POST', '/indexes', { uid, primaryKey });
    await this.waitTask(t.taskUid);
  }

  async deleteIndex(uid: string) {
    const t = await this.request<MeiliTask>('DELETE', `/indexes/${uid}`);
    await this.waitTask(t.taskUid);
  }

  async updateSettings(uid: string, settings: Record<string, unknown>) {
    const t = await this.request<MeiliTask>('PATCH', `/indexes/${uid}/settings`, settings);
    await this.waitTask(t.taskUid, 300_000);
  }

  /** Dokumente hinzufügen/ersetzen (asynchron in Meilisearch) */
  addDocuments(uid: string, docs: object[]) {
    return this.request<MeiliTask>('POST', `/indexes/${uid}/documents`, docs, 60_000);
  }

  /** Teil-Update vorhandener Dokumente */
  updateDocuments(uid: string, docs: object[]) {
    return this.request<MeiliTask>('PUT', `/indexes/${uid}/documents`, docs, 60_000);
  }

  deleteByFilter(uid: string, filter: string) {
    return this.request<MeiliTask>('POST', `/indexes/${uid}/documents/delete`, { filter });
  }

  deleteIds(uid: string, ids: string[]) {
    return this.request<MeiliTask>('POST', `/indexes/${uid}/documents/delete-batch`, ids);
  }

  fetchDocuments<T>(uid: string, opts: { filter?: string; fields?: string[]; limit?: number; offset?: number }) {
    return this.request<{ results: T[]; total: number }>('POST', `/indexes/${uid}/documents/fetch`, opts, 30_000);
  }

  search<T>(uid: string, params: MeiliSearchParams) {
    return this.request<MeiliSearchResponse<T>>('POST', `/indexes/${uid}/search`, params, 10_000);
  }

  stats(uid: string) {
    return this.request<{ numberOfDocuments: number; isIndexing: boolean; rawDocumentDbSize?: number }>('GET', `/indexes/${uid}/stats`);
  }

  globalStats() {
    return this.request<{ databaseSize?: number; usedDatabaseSize?: number }>('GET', '/stats');
  }
}

/** Wert für Meilisearch-Filter sicher in Anführungszeichen setzen */
export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
