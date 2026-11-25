/**
 * API-Client für das Kuvert-Backend. Alle Aufrufe laufen über `api()`,
 * das Cookies mitsendet, den CSRF-Header setzt und Fehler vereinheitlicht.
 */
import type { UploadInfo } from '@kuvert/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

/** Wird aufgerufen, wenn der Server 401 meldet (Sitzung abgelaufen). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export function apiUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `/api${path}${s ? `?${s}` : ''}`;
}

/** Laufende schreibende Anfragen (z. B. damit ein Fenster erst danach schließt) */
let writesInFlight = 0;
const idleWaiters = new Set<() => void>();

/** Wartet, bis keine schreibende Anfrage (POST/PUT/PATCH/DELETE) mehr läuft. */
export function whenWritesIdle(): Promise<void> {
  if (!writesInFlight) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const write = (opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')) !== 'GET';
  if (!write) return request<T>(path, opts);
  writesInFlight++;
  try {
    return await request<T>(path, opts);
  } finally {
    writesInFlight--;
    if (!writesInFlight) {
      const waiters = [...idleWaiters];
      idleWaiters.clear();
      waiters.forEach((w) => w());
    }
  }
}

async function request<T>(path: string, opts: ApiOptions): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'kuvert', Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(apiUrl(path, opts.query), {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'unauthenticated') onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Fehler ${res.status}`, data?.details);
  }
  return data as T;
}

/** Datei hochladen (mit Fortschritt) → Upload-ID für Anhänge */
export function uploadFile(file: File | Blob, filename?: string, onProgress?: (pct: number) => void): Promise<UploadInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-Requested-With', 'kuvert');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: any;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadInfo);
      else reject(new ApiError(xhr.status, data?.error ?? 'upload_failed', data?.message ?? 'Upload fehlgeschlagen'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Netzwerkfehler beim Upload'));
    const fd = new FormData();
    fd.append('file', file, filename ?? (file instanceof File ? file.name : 'datei'));
    xhr.send(fd);
  });
}

/**
 * Streamt eine Textantwort (z. B. KI-Ausgabe). onChunk erhält jeweils den bisher
 * vollständigen Text. Gibt den Gesamttext zurück.
 */
export async function streamText(path: string, body: unknown, onChunk: (full: string) => void, signal?: AbortSignal): Promise<string> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kuvert' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Fehler ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    onChunk(full);
  }
  return full;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
