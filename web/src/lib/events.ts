/**
 * Echtzeit-Ereignisse vom Server (Server-Sent Events).
 * Eine einzige EventSource pro Tab; Komponenten abonnieren per `useServerEvent`.
 */
import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@kuvert/shared';

type Handler = (e: ServerEvent) => void;
const handlers = new Set<Handler>();
let source: EventSource | null = null;
let retry = 0;

/** Alle Ereignistypen – als Record, damit der Typecheck bei einem neuen ServerEvent-Typ auf das Fehlen hinweist */
const TYPE_SET: Record<ServerEvent['type'], true> = {
  hello: true,
  ping: true,
  'mail.new': true,
  'mail.changed': true,
  'mail.triage': true,
  'calendar.reminder': true,
  'calendar.changed': true,
  'account.status': true,
  'send.status': true,
  'chat.message': true,
  'chat.message.updated': true,
  'chat.conversation': true,
  'chat.read': true,
  'chat.typing': true,
  'chat.presence': true,
  'chat.connection': true,
  'chat.categories': true,
  'chat.call': true,
  'threecx.call': true,
  'timetrack.changed': true,
  'meet.invite': true,
  'meet.state': true,
};
const TYPES = Object.keys(TYPE_SET) as ServerEvent['type'][];

export function connectEvents() {
  if (source) return;
  source = new EventSource('/api/events', { withCredentials: true });
  for (const t of TYPES) {
    source.addEventListener(t, (msg) => {
      retry = 0;
      try {
        const e = JSON.parse((msg as MessageEvent).data) as ServerEvent;
        handlers.forEach((h) => h(e));
      } catch {
        /* ignorieren */
      }
    });
  }
  source.onerror = () => {
    source?.close();
    source = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(connectEvents, 1000 * 2 ** retry);
  };
}

export function disconnectEvents() {
  source?.close();
  source = null;
}

export function onServerEvent(fn: Handler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** Abonniert Server-Ereignisse (optional gefiltert nach Typ). */
export function useServerEvent<T extends ServerEvent['type']>(
  type: T | T[] | '*',
  handler: (e: Extract<ServerEvent, { type: T }>) => void,
) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const types = type === '*' ? null : Array.isArray(type) ? type : [type];
    return onServerEvent((e) => {
      if (!types || (types as string[]).includes(e.type)) ref.current(e as Extract<ServerEvent, { type: T }>);
    });
  }, [Array.isArray(type) ? type.join(',') : type]);
}

/** Standard-Invalidierung von Query-Caches bei Ereignissen. Query-Keys siehe Feature-Module. */
export function installQueryInvalidation(qc: QueryClient) {
  return onServerEvent((e) => {
    switch (e.type) {
      case 'mail.new':
      case 'mail.changed':
        qc.invalidateQueries({ queryKey: ['mail'] });
        break;
      case 'calendar.changed':
        qc.invalidateQueries({ queryKey: ['calendar'] });
        break;
      case 'account.status':
        qc.invalidateQueries({ queryKey: ['accounts'] });
        break;
      case 'send.status':
        qc.invalidateQueries({ queryKey: ['mail', 'scheduled'] });
        break;
    }
  });
}

/* ───────────── Abgleich zwischen Fenstern/Tabs ───────────── */

let channel: BroadcastChannel | null | undefined;
function syncChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('kuvert.sync');
    } catch {
      channel = null;
    }
  }
  return channel;
}

/**
 * Andere Fenster/Tabs derselben Sitzung (z. B. Hauptfenster ↔ Lesefenster) bitten,
 * Daten unter `queryKey` neu zu laden – etwa nach Verschieben oder Markieren.
 */
export function notifyOtherWindows(queryKey: readonly unknown[]) {
  try {
    syncChannel()?.postMessage({ type: 'invalidate', queryKey: [...queryKey] });
  } catch {
    /* egal */
  }
}

/** Reagiert auf notifyOtherWindows() aus anderen Fenstern (kurz gebündelt). */
export function installCrossWindowSync(qc: QueryClient) {
  const ch = syncChannel();
  if (!ch) return () => {};
  const pending = new Map<string, unknown[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; queryKey?: unknown[] } | null;
    if (d?.type !== 'invalidate' || !Array.isArray(d.queryKey)) return;
    pending.set(JSON.stringify(d.queryKey), d.queryKey);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const keys = [...pending.values()];
      pending.clear();
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    }, 150);
  };
  ch.addEventListener('message', onMessage);
  return () => {
    clearTimeout(timer);
    ch.removeEventListener('message', onMessage);
  };
}
