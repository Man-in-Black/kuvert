/**
 * LLM-Backends. Neue Anbieter implementieren `LlmBackend` und werden in
 * `createBackend` eingetragen.
 */
import type { AiModelInfo } from '@kuvert/shared';
import { config } from '../../config.js';
import { HttpError } from '../../core/errors.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature: number;
  signal: AbortSignal;
  /** Antwort als JSON-Objekt erzwingen (sofern das Backend es unterstützt, z. B. Ollama) */
  json?: boolean;
  /** Ollama: wie lange das Modell danach geladen bleibt (0 = sofort entladen, "5m", …) */
  keepAlive?: number | string;
  /** Ollama: Kontextgröße in Tokens (Standard des Servers, wenn nicht gesetzt) */
  numCtx?: number;
}

export interface LlmBackend {
  readonly name: string;
  listModels(): Promise<AiModelInfo[]>;
  /** Liefert die Antwort Stück für Stück */
  chatStream(model: string, messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  /** Modell aus dem Speicher entladen (falls das Backend das kann, z. B. Ollama) */
  unload?(model: string): Promise<void>;
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

async function ensureOk(res: Response, what: string) {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message ?? j.error ?? text;
  } catch {
    /* Text */
  }
  throw new HttpError(res.status, `${what}: ${msg || res.statusText}`);
}

/** Ollama (https://ollama.com) – /api/tags und /api/chat (NDJSON-Stream) */
export class OllamaBackend implements LlmBackend {
  readonly name = 'ollama';
  constructor(private baseUrl: string) {}

  async listModels(): Promise<AiModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    await ensureOk(res, 'Ollama nicht erreichbar');
    const json = (await res.json()) as {
      models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }[];
    };
    return (json.models ?? [])
      .map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        parameterSize: m.details?.parameter_size || undefined,
        quantization: m.details?.quantization_level || undefined,
        family: m.details?.family || undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async *chatStream(model: string, messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { temperature: opts.temperature, ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}) },
        ...(opts.json ? { format: 'json' } : {}),
        ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
      }),
      signal: opts.signal,
    });
    await ensureOk(res, 'Ollama-Fehler');
    if (!res.body) return;
    for await (const line of readLines(res.body)) {
      const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean };
      if (chunk.error) throw new HttpError(502, `Ollama: ${chunk.error}`);
      if (chunk.message?.content) yield chunk.message.content;
      if (chunk.done) break;
    }
  }

  /** Dokumentierter Weg: leere Anfrage mit keep_alive 0 */
  async unload(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
    await ensureOk(res, 'Ollama: Modell nicht entladen');
  }
}

/** OpenAI-kompatible APIs (LM Studio, vLLM, LocalAI, OpenAI …) – /v1/models und /v1/chat/completions (SSE) */
export class OpenAiCompatibleBackend implements LlmBackend {
  readonly name = 'openai';
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private url(path: string) {
    return /\/v1$/.test(this.baseUrl) ? `${this.baseUrl}${path}` : `${this.baseUrl}/v1${path}`;
  }

  async listModels(): Promise<AiModelInfo[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers(), signal: AbortSignal.timeout(5000) });
    await ensureOk(res, 'KI-Server nicht erreichbar');
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => ({ name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** opts.json/keepAlive werden bewusst ignoriert: nicht alle kompatiblen Server unterstützen sie */
  async *chatStream(model: string, messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string> {
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, messages, stream: true, temperature: opts.temperature }),
      signal: opts.signal,
    });
    await ensureOk(res, 'KI-Fehler');
    if (!res.body) return;
    for await (const line of readLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

export function createBackend(cfg: { backend: 'ollama' | 'openai'; baseUrl: string; apiKey: string }): LlmBackend {
  return cfg.backend === 'openai' ? new OpenAiCompatibleBackend(cfg.baseUrl, cfg.apiKey) : new OllamaBackend(cfg.baseUrl);
}

/** Gemeinsames Backend – wird neu erzeugt, sobald sich die Einstellungen (Admin-Bereich/.env) ändern */
let cached: { key: string; backend: LlmBackend } | null = null;
export function getBackend(): LlmBackend {
  const ai = config.ai;
  const key = `${ai.backend}|${ai.baseUrl}|${ai.apiKey}`;
  if (cached?.key !== key) cached = { key, backend: createBackend(ai) };
  return cached.backend;
}

/** Komplette (nicht gestreamte) Antwort */
export async function chatComplete(model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  let out = '';
  for await (const chunk of getBackend().chatStream(model, messages, opts)) out += chunk;
  return out;
}
