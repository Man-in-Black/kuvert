/**
 * KI-Modul: Umschreiben, Formulieren, Zusammenfassen, Übersetzen … über ein
 * lokales LLM (Ollama) oder eine OpenAI-kompatible API. Alles bleibt auf eigener
 * Infrastruktur – es werden keine Mails an Dritte geschickt.
 */
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AiChatEvent, AiChatRequest, AiRequest, AiStatus } from '@kuvert/shared';
import { config } from '../../config.js';
import { defineModule } from '../../core/module.js';
import { users } from '../../core/users.js';
import { parse } from '../../routes/util.js';
import { AppError, NotFoundError } from '../../core/errors.js';
import { getBackend } from './backends.js';
import { buildMessages, createFenceFilter } from './prompts.js';
import { buildChatSystem, formatSources, planSearch, searchMailbox, trimHistory } from './chat.js';
import { chatStore, migrations } from './store.js';

let pruneTimer: NodeJS.Timeout | null = null;

function requireEnabled() {
  if (!config.ai.enabled) throw new AppError(503, 'ai_disabled', 'Der KI-Assistent ist deaktiviert');
}

const requestSchema = z.object({
  action: z.enum(['rewrite', 'formal', 'friendly', 'shorter', 'longer', 'fix', 'translate', 'summarize', 'reply', 'compose', 'subject', 'extract_tasks', 'custom']),
  text: z.string().max(100_000).default(''),
  instruction: z.string().max(4000).optional(),
  language: z.string().max(60).optional(),
  context: z.string().max(100_000).optional(),
  model: z.string().max(200).optional(),
  html: z.boolean().optional(),
});

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(50_000) }))
    .min(1)
    .max(100)
    .refine((m) => m[m.length - 1]!.role === 'user', 'Die letzte Nachricht muss vom Benutzer sein'),
  context: z.object({ kind: z.enum(['message', 'conversation', 'meeting']), title: z.string().max(500), text: z.string().max(100_000) }).optional(),
  searchMailbox: z.boolean().optional(),
  model: z.string().max(200).optional(),
});

const sourceSchema = z.object({
  accountId: z.string().max(500),
  folderId: z.string().max(2000),
  id: z.string().max(2000),
  subject: z.string().max(2000),
  from: z.object({ name: z.string().max(500).optional(), address: z.string().max(500) }).optional(),
  date: z.string().max(60),
});

const storedChatSchema = z.object({
  title: z.string().trim().min(1).max(200),
  titleManual: z.boolean().optional(),
  contextKey: z.string().max(4000).nullish(),
  context: z.object({ kind: z.enum(['message', 'conversation', 'meeting']), title: z.string().max(500), text: z.string().max(100_000) }).nullish(),
  replyRef: z.object({ accountId: z.string().max(500), folderId: z.string().max(2000), id: z.string().max(2000) }).nullish(),
  searchMailbox: z.boolean(),
  model: z.string().max(200).nullish(),
  messages: z
    .array(
      z.object({
        id: z.string().max(100),
        role: z.enum(['user', 'assistant']),
        content: z.string().max(100_000),
        sources: z.array(sourceSchema).max(50).optional(),
        searchQuery: z.string().max(1000).optional(),
        error: z.string().max(2000).optional(),
      }),
    )
    .max(500),
});

const CHAT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Gespeicherte Chats nach der Aufbewahrungsfrist des jeweiligen Benutzers löschen */
function pruneChats(log: FastifyBaseLogger) {
  try {
    let removed = 0;
    for (const userId of chatStore.usersWithChats()) {
      const days = users.getSettings(userId).ai.chatRetentionDays ?? 90;
      if (days > 0) removed += chatStore.pruneUser(userId, days);
    }
    if (removed) log.info({ removed }, 'Alte KI-Chats entfernt');
  } catch (err) {
    log.warn({ err }, 'KI-Chats aufräumen fehlgeschlagen');
  }
}

export default defineModule({
  id: 'ai',
  name: 'KI-Assistent',
  get description() {
    return `Schreibhilfe über ${config.ai.backend === 'openai' ? 'OpenAI-kompatible API' : 'Ollama'}`;
  },
  /** Feature-Flag folgt der Einstellung "KI aktiviert" (Admin-Bereich oder .env) */
  get features() {
    return config.ai.enabled ? ['ai'] : [];
  },
  migrations,

  init(ctx) {
    const log = ctx.log.child({ module: 'ai' });
    setTimeout(() => pruneChats(log), 90_000).unref();
    pruneTimer = setInterval(() => pruneChats(log), 24 * 3600_000);
    pruneTimer.unref();
  },

  shutdown() {
    if (pruneTimer) clearInterval(pruneTimer);
  },

  routes(app, ctx) {
    app.get('/status', async (): Promise<AiStatus> => {
      if (!config.ai.enabled) return { enabled: false, reachable: false, baseUrl: config.ai.baseUrl, model: config.ai.model, models: [] };
      try {
        const details = await getBackend().listModels();
        return { enabled: true, reachable: true, baseUrl: config.ai.baseUrl, model: config.ai.model, models: details.map((m) => m.name), modelDetails: details };
      } catch (err) {
        return { enabled: true, reachable: false, baseUrl: config.ai.baseUrl, model: config.ai.model, models: [], error: (err as Error).message };
      }
    });

    /** Führt eine KI-Aktion aus und streamt das Ergebnis als text/plain */
    app.post('/run', async (req, reply) => {
      requireEnabled();
      const body = parse(requestSchema, req.body) as AiRequest;
      const settings = users.getSettings(req.user.id);
      const model = body.model || settings.ai.model || config.ai.model;
      const messages = buildMessages(body, settings.ai.defaultLanguage || 'Deutsch');

      const controller = new AbortController();
      // Abbruch, wenn der Client die Verbindung schließt (nicht req 'close' – das feuert nach dem Body)
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });

      // Erstes Stück vorab holen, damit Fehler noch als JSON-Fehler zurückgehen können
      const iterator = getBackend().chatStream(model, messages, { temperature: config.ai.temperature, signal: controller.signal })[Symbol.asyncIterator]();
      const first = await iterator.next();

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      const filter = createFenceFilter();
      try {
        if (!first.done) res.write(filter.push(first.value));
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          const out = filter.push(next.value);
          if (out) res.write(out);
        }
        res.write(filter.end());
      } catch (err) {
        if (!controller.signal.aborted) {
          req.log.warn({ err }, 'KI-Stream abgebrochen');
          res.write(`\n\n[Fehler: ${(err as Error).message}]`);
        }
      } finally {
        res.end();
      }
    });

    /* ───────────── Gespeicherte Chats ───────────── */

    app.get('/chats', async (req) => chatStore.list(req.user.id));

    /** Neuester Chat zu einem Kontext (z. B. derselben Mail) – null, wenn keiner existiert */
    app.get<{ Querystring: { key?: string } }>('/chats/by-key', async (req) => (req.query.key ? chatStore.byKey(req.user.id, req.query.key) : null));

    app.get<{ Params: { id: string } }>('/chats/:id', async (req) => {
      const chat = chatStore.get(req.user.id, req.params.id);
      if (!chat) throw new NotFoundError('Chat');
      return chat;
    });

    /** Anlegen oder ersetzen (die ID vergibt der Client) */
    app.put<{ Params: { id: string } }>('/chats/:id', async (req) => {
      if (!CHAT_ID.test(req.params.id)) throw new AppError(400, 'invalid_id', 'Ungültige Chat-ID');
      const body = parse(storedChatSchema, req.body);
      const saved = chatStore.upsert(req.user.id, req.params.id, body);
      if (!saved) throw new NotFoundError('Chat');
      return saved;
    });

    app.patch<{ Params: { id: string } }>('/chats/:id', async (req) => {
      const { title } = parse(z.object({ title: z.string().trim().min(1).max(200) }), req.body);
      if (!chatStore.rename(req.user.id, req.params.id, title)) throw new NotFoundError('Chat');
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/chats/:id', async (req) => {
      chatStore.remove(req.user.id, req.params.id);
      return { ok: true };
    });

    app.delete('/chats', async (req) => ({ removed: chatStore.removeAll(req.user.id) }));

    /**
     * KI-Chat: freie Fragen (global, zu einer Mail oder zu einem Verlauf), optional mit
     * Postfach-Suche. Antwort als NDJSON-Stream (AiChatEvent je Zeile).
     */
    app.post('/chat', async (req, reply) => {
      requireEnabled();
      const body = parse(chatSchema, req.body) as AiChatRequest;
      const settings = users.getSettings(req.user.id);
      const model = body.model || settings.ai.model || config.ai.model;
      const language = settings.ai.defaultLanguage || 'Deutsch';
      const history = trimHistory(body.messages);

      const controller = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      const send = (e: AiChatEvent) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
      };

      try {
        let sources: string | undefined;
        let searchQuery: string | undefined;
        let searched = false;
        if (body.searchMailbox) {
          send({ t: 'status', text: 'Überlege, wonach gesucht werden soll …' });
          const planned = await planSearch(model, history, !!body.context, controller.signal);
          if (planned) {
            send({ t: 'status', text: `Durchsuche Postfach: ${planned}` });
            const found = await searchMailbox(ctx, req.user.id, planned);
            searched = true;
            searchQuery = found.query;
            if (found.items.length) {
              send({ t: 'status', text: `${found.items.length} Mails gefunden, lese die relevantesten …` });
              const formatted = await formatSources(ctx, req.user.id, found.items);
              sources = formatted.text;
              send({ t: 'sources', items: formatted.sources, query: found.query });
            } else {
              send({ t: 'sources', items: [], query: found.query });
            }
          }
        }
        if (controller.signal.aborted) return;

        const messages = [{ role: 'system' as const, content: buildChatSystem({ user: req.user, language, context: body.context, sources, searchQuery, searched }) }, ...history];
        send({ t: 'status', text: 'Die KI denkt nach …' });
        for await (const chunk of getBackend().chatStream(model, messages, { temperature: config.ai.temperature, signal: controller.signal })) {
          send({ t: 'delta', v: chunk });
        }
        send({ t: 'done' });
      } catch (err) {
        if (!controller.signal.aborted) {
          req.log.warn({ err }, 'KI-Chat fehlgeschlagen');
          send({ t: 'error', message: (err as Error).message });
        }
      } finally {
        res.end();
      }
    });
  },
});
