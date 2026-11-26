/**
 * Zustand des KI-Chats. Ein Chat ist aktiv; jeder Chat mit Nachrichten wird
 * automatisch pro Benutzer auf dem Server gespeichert (/api/ai/chats) und taucht im
 * Verlauf auf. Der Stream läuft im Store weiter, auch wenn das Panel geschlossen wird.
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { AiChatContext, AiChatEvent, AiChatRecord, AiChatRequest, AiChatSource, MessageDetail } from '@kuvert/shared';
import { ApiError, api, apiUrl, errorMessage } from '@/lib/api';
import type { MessageRef } from '@/features/mail/api';
import { closeSidePanelIf, openSidePanel } from '@/layout/side-panel-store';

/** ID des KI-Chats in der Seitenleiste rechts */
export const AI_PANEL_ID = 'ai-chat';

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Zwischenschritt während der Antwort (Suche, Nachdenken) */
  status?: string;
  sources?: AiChatSource[];
  searchQuery?: string;
  error?: string;
  streaming?: boolean;
}

/** Womit der Chat geöffnet wird: ohne Kontext = globaler Chat */
export interface AiChatTarget {
  context: AiChatContext;
  /** Nachricht, auf die "Als Antwort öffnen" antwortet (detail fehlt bei geladenen Chats) */
  replyTo?: { ref: MessageRef; detail?: MessageDetail };
  /** Gleiche Kontexte öffnen denselben Chat wieder (z. B. "message|konto|ordner|id") */
  key: string;
}

export interface AiChatSession {
  id: string;
  title: string;
  /** Titel vom Benutzer vergeben */
  titleManual: boolean;
  target: AiChatTarget | null;
  messages: AiChatMessage[];
  searchMailbox: boolean;
}

interface State {
  session: AiChatSession;
  /** Gewähltes Modell (leer = Standard aus den Einstellungen) */
  model: string | null;
  /** Wird nach jedem Speichern/Löschen erhöht – die Verlaufsliste lädt dann neu */
  historyVersion: number;
  /** Ein gespeicherter Chat wird gerade geladen */
  loading: boolean;
}

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${++seq}`;

/** Chat-ID für den Server (getRandomValues gibt es auch ohne HTTPS, randomUUID nicht) */
function chatId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const newSession = (target: AiChatTarget | null): AiChatSession => ({
  id: chatId(),
  title: '',
  titleManual: false,
  target,
  messages: [],
  // Global: Postfach standardmäßig einbeziehen; mit geöffneter Mail reicht meist der Kontext
  searchMailbox: !target,
});

let state: State = { session: newSession(null), model: null, historyVersion: 0, loading: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  scheduleSave();
};
let abort: AbortController | null = null;

export function useAiChat(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/* ───────────────────────────── Speichern ───────────────────────────── */

function autoTitle(s: AiChatSession): string {
  if (s.titleManual && s.title) return s.title;
  if (s.target?.context.title) return s.target.context.title.slice(0, 200);
  const first = s.messages.find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').trim() ?? '';
  return (first.length > 80 ? `${first.slice(0, 78)} …` : first) || 'Neuer Chat';
}

/** Laufende Antworten für die Ablage abschließen (z. B. beim Wechsel des Chats) */
function finalize(m: AiChatMessage): AiChatMessage {
  if (!m.streaming) return m;
  return m.content ? { ...m, streaming: false, status: undefined, content: `${m.content} …` } : { ...m, streaming: false, status: undefined, error: 'Abgebrochen' };
}

function toPayload(s: AiChatSession) {
  return {
    title: autoTitle(s),
    titleManual: s.titleManual,
    contextKey: s.target?.key ?? null,
    context: s.target?.context ?? null,
    replyRef: s.target?.replyTo?.ref ?? null,
    searchMailbox: s.searchMailbox,
    model: state.model,
    messages: s.messages.map(({ id, role, content, sources, searchQuery, error }) => ({ id, role, content, sources, searchQuery, error })),
  };
}

const lastSaved = new Map<string, string>();
let pending: { session: AiChatSession; timer: ReturnType<typeof setTimeout> } | null = null;
let saveErrorShown = false;

async function save(session: AiChatSession) {
  if (!session.messages.length) return;
  const body = JSON.stringify(toPayload(session));
  if (lastSaved.get(session.id) === body) return;
  try {
    await api(`/ai/chats/${session.id}`, { method: 'PUT', body: JSON.parse(body) });
    lastSaved.set(session.id, body);
    saveErrorShown = false;
    state = { ...state, historyVersion: state.historyVersion + 1 };
    listeners.forEach((l) => l());
  } catch (err) {
    if (!saveErrorShown) toast.error(`KI-Chat konnte nicht gespeichert werden: ${errorMessage(err)}`);
    saveErrorShown = true;
  }
}

/** Gespeichert wird, sobald keine Antwort mehr läuft (kurz entprellt) */
function scheduleSave() {
  const s = state.session;
  if (!s.messages.length || s.messages.some((m) => m.streaming)) return;
  if (pending && pending.session.id !== s.id) flushSave();
  if (pending) clearTimeout(pending.timer);
  pending = { session: s, timer: setTimeout(flushSave, 400) };
}

function flushSave() {
  if (!pending) return;
  clearTimeout(pending.timer);
  const s = pending.session;
  pending = null;
  void save(s);
}

/** Vor dem Wechsel: laufende Antwort abbrechen und den bisherigen Chat sichern */
function leaveSession() {
  const s = state.session;
  stopAiChat();
  flushSave();
  if (s.messages.some((m) => m.streaming)) void save({ ...s, messages: s.messages.map(finalize) });
}

function fromRecord(r: AiChatRecord, target?: AiChatTarget): AiChatSession {
  const stored: AiChatTarget | null = r.context
    ? { context: r.context, key: r.contextKey ?? `chat|${r.id}`, replyTo: r.replyRef ? { ref: r.replyRef } : undefined }
    : null;
  const messages = r.messages.map((m) => ({ ...m }));
  lastSaved.set(r.id, JSON.stringify(toPayload({ id: r.id, title: r.title, titleManual: !!r.titleManual, target: stored, messages, searchMailbox: r.searchMailbox })));
  return {
    id: r.id,
    title: r.title,
    titleManual: !!r.titleManual,
    // Beim Öffnen aus der Mail: frischen Kontext (und Nachricht für "Als Antwort") verwenden
    target: target ?? stored,
    messages,
    searchMailbox: r.searchMailbox,
  };
}

/* ───────────────────────────── Öffnen / Wechseln ───────────────────────────── */

/**
 * Öffnet den Chat. Mit Ziel: derselbe Kontext → bestehender Chat; sonst der zuletzt
 * gespeicherte Chat zu diesem Kontext oder ein neuer. Ohne Ziel: ein laufender
 * globaler Chat wird fortgesetzt, sonst ein neuer globaler.
 */
export function openAiChat(target?: AiChatTarget) {
  const current = state.session;
  const same = target ? current.target?.key === target.key : !current.target;
  if (same) {
    // Kontext auffrischen (z. B. neu geladene Nachricht), Verlauf behalten
    set({ session: target ? { ...current, target } : current });
    openSidePanel(AI_PANEL_ID);
    return;
  }
  leaveSession();
  const fresh = newSession(target ?? null);
  set({ session: fresh, loading: !!target });
  openSidePanel(AI_PANEL_ID);
  if (!target) return;
  api<AiChatRecord | null>('/ai/chats/by-key', { query: { key: target.key } })
    .then((r) => {
      // Nur übernehmen, wenn der Benutzer inzwischen nichts anderes gestartet hat
      if (r && state.session.id === fresh.id && !state.session.messages.length) {
        set({ session: fromRecord(r, target), model: r.model ?? state.model });
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (state.session.id === fresh.id) set({ loading: false });
    });
}

/** Gespeicherten Chat aus dem Verlauf öffnen */
export async function loadAiChat(id: string) {
  if (state.session.id === id) return;
  leaveSession();
  set({ loading: true });
  try {
    const r = await api<AiChatRecord>(`/ai/chats/${id}`);
    set({ session: fromRecord(r), model: r.model ?? state.model });
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    set({ loading: false });
  }
}

export async function deleteAiChat(id: string) {
  if (pending?.session.id === id) {
    clearTimeout(pending.timer);
    pending = null;
  }
  if (state.session.id === id) {
    stopAiChat();
    set({ session: newSession(null) });
  }
  lastSaved.delete(id);
  try {
    await api(`/ai/chats/${id}`, { method: 'DELETE' });
  } catch (err) {
    toast.error(errorMessage(err));
  }
  set({ historyVersion: state.historyVersion + 1 });
}

export async function deleteAllAiChats() {
  if (pending) {
    clearTimeout(pending.timer);
    pending = null;
  }
  stopAiChat();
  lastSaved.clear();
  set({ session: newSession(null) });
  try {
    await api('/ai/chats', { method: 'DELETE' });
  } catch (err) {
    toast.error(errorMessage(err));
  }
  set({ historyVersion: state.historyVersion + 1 });
}

export async function renameAiChat(id: string, title: string) {
  const t = title.trim();
  if (!t) return;
  try {
    await api(`/ai/chats/${id}`, { method: 'PATCH', body: { title: t } });
    if (state.session.id === id) {
      const session = { ...state.session, title: t, titleManual: true };
      lastSaved.set(id, JSON.stringify(toPayload(session)));
      set({ session });
    }
    set({ historyVersion: state.historyVersion + 1 });
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function closeAiChat() {
  closeSidePanelIf(AI_PANEL_ID);
}

/** Neuer Chat (der bisherige bleibt im Verlauf) */
export function resetAiChat(keepContext = true) {
  leaveSession();
  set({ session: newSession(keepContext ? state.session.target : null) });
}

/** Kontext entfernen → der Chat wird zum globalen Chat (Verlauf bleibt) */
export function dropAiChatContext() {
  set({ session: { ...state.session, target: null } });
}

export function setAiChatSearch(on: boolean) {
  set({ session: { ...state.session, searchMailbox: on } });
}

export function setAiChatModel(model: string | null) {
  set({ model });
}

export function stopAiChat() {
  abort?.abort();
  abort = null;
}

function patchMessage(sessionId: string, id: string, fn: (m: AiChatMessage) => AiChatMessage) {
  if (state.session.id !== sessionId) return;
  set({ session: { ...state.session, messages: state.session.messages.map((m) => (m.id === id ? fn(m) : m)) } });
}

/** NDJSON-Stream lesen, ein Ereignis je Zeile */
async function streamEvents(body: AiChatRequest, onEvent: (e: AiChatEvent) => void, signal: AbortSignal) {
  const res = await fetch(apiUrl('/ai/chat'), {
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
  let buffer = '';
  const flush = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as AiChatEvent);
    } catch {
      /* unvollständige Zeile – ignorieren */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      flush(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  flush(buffer);
}

/** Frage senden (oder mit text=undefined die letzte Antwort neu erzeugen) */
export async function sendAiChat(text: string | undefined, opts: { model?: string; search: boolean }) {
  if (state.session.messages.some((m) => m.streaming)) return;
  let messages = state.session.messages;
  if (text === undefined) {
    // Neu generieren: letzte Antwort verwerfen
    while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages = messages.slice(0, -1);
    if (!messages.length) return;
  } else {
    const trimmed = text.trim();
    if (!trimmed) return;
    messages = [...messages, { id: nextId(), role: 'user', content: trimmed }];
  }
  const answer: AiChatMessage = { id: nextId(), role: 'assistant', content: '', streaming: true, status: 'Verbinde …' };
  const session = { ...state.session, messages: [...messages, answer] };
  set({ session });

  const ctrl = new AbortController();
  abort = ctrl;
  const sid = session.id;
  const request: AiChatRequest = {
    // Fehlgeschlagene Antworten nicht als Verlauf mitschicken
    messages: messages.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content })),
    context: session.target?.context,
    searchMailbox: opts.search,
    model: state.model || opts.model,
  };

  try {
    await streamEvents(
      request,
      (e) => {
        switch (e.t) {
          case 'status':
            patchMessage(sid, answer.id, (m) => ({ ...m, status: e.text }));
            break;
          case 'sources':
            patchMessage(sid, answer.id, (m) => ({ ...m, sources: e.items, searchQuery: e.query }));
            break;
          case 'delta':
            patchMessage(sid, answer.id, (m) => ({ ...m, content: m.content + e.v, status: undefined }));
            break;
          case 'error':
            patchMessage(sid, answer.id, (m) => ({ ...m, error: e.message }));
            break;
          case 'done':
            break;
        }
      },
      ctrl.signal,
    );
  } catch (err) {
    if (!ctrl.signal.aborted) patchMessage(sid, answer.id, (m) => ({ ...m, error: errorMessage(err) }));
  } finally {
    patchMessage(sid, answer.id, (m) => {
      const done = { ...m, streaming: false, status: undefined };
      if (!ctrl.signal.aborted) return done.content || done.error ? done : { ...done, error: 'Keine Antwort erhalten' };
      return m.content ? { ...done, content: `${m.content} …` } : { ...done, error: 'Abgebrochen' };
    });
    if (abort === ctrl) abort = null;
  }
}
