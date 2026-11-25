import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@kuvert/shared';
import type { AccountRecord } from './module.js';

type Listener = (event: ServerEvent) => void;

/** Änderung an Nachrichten durch Kuvert selbst (für Suchindex, Caches …) */
export interface MailMutation {
  userId: string;
  accountId: string;
  folderId: string;
  ids: string[];
  action: 'flags' | 'move' | 'delete';
  flags?: { seen?: boolean; flagged?: boolean };
  targetFolderId?: string;
}

export interface InternalEvents {
  'account.created': [AccountRecord];
  'account.updated': [AccountRecord];
  'account.deleted': [AccountRecord];
  'user.event': [string, ServerEvent];
  /** Erste SSE-Verbindung eines Benutzers geöffnet (true) bzw. letzte geschlossen (false) */
  'user.connection': [string, boolean];
  'mail.mutated': [MailMutation];
}

/**
 * Ereignisbus:
 *  - publish(userId, event) → an alle offenen SSE-Verbindungen des Benutzers
 *  - internal → Ereignisse zwischen Modulen (Konto angelegt/gelöscht …)
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  readonly internal = new EventEmitter<InternalEvents>();

  constructor() {
    this.internal.setMaxListeners(100);
  }

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    const first = set.size === 0;
    set.add(fn);
    if (first) this.internal.emit('user.connection', userId, true);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set!.delete(fn);
      if (set!.size === 0) {
        this.listeners.delete(userId);
        this.internal.emit('user.connection', userId, false);
      }
    };
  }

  publish(userId: string, event: ServerEvent) {
    this.internal.emit('user.event', userId, event);
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* Verbindung ggf. bereits geschlossen */
      }
    }
  }

  hasListeners(userId: string): boolean {
    return (this.listeners.get(userId)?.size ?? 0) > 0;
  }

  /** Benutzer mit mindestens einer offenen SSE-Verbindung */
  onlineUserIds(): string[] {
    return [...this.listeners.keys()];
  }
}
