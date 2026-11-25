/**
 * Verwaltet eine dauerhafte IMAP-Verbindung pro Konto (lazy connect,
 * automatischer Neuaufbau, serialisierter Postfachzugriff über Locks)
 * sowie eine separate IDLE-Verbindung für Push-Benachrichtigungen.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { FastifyBaseLogger } from 'fastify';
import { AuthError } from '../../core/errors.js';
import { mapImapError } from './config.js';

const CONNECTION_ERRORS = new Set([
  'NoConnection',
  'EConnectionClosed',
  'StateLogout',
  'ECONNRESET',
  'EPIPE',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
]);

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return !!code && CONNECTION_ERRORS.has(code);
}

export class ImapConnection {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private closed = false;

  constructor(
    private options: () => ImapFlowOptions,
    private log: FastifyBaseLogger,
  ) {}

  private host() {
    return this.options().host;
  }

  async get(): Promise<ImapFlow> {
    if (this.closed) throw new Error('IMAP-Verbindung wurde beendet');
    if (this.client?.usable) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<ImapFlow> {
    const old = this.client;
    this.client = null;
    if (old) old.close();
    const c = new ImapFlow(this.options());
    c.on('error', (err: Error) => this.log.warn({ err: err.message }, 'IMAP-Verbindungsfehler'));
    c.on('close', () => {
      if (this.client === c) this.client = null;
    });
    try {
      await c.connect();
    } catch (err) {
      c.close();
      throw mapImapError(err, this.host());
    }
    this.client = c;
    return c;
  }

  /** Führt einen Befehl ohne Postfachauswahl aus (LIST, STATUS, APPEND …). */
  async run<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.get();
      try {
        return await fn(c);
      } catch (err) {
        if (attempt === 0 && (isConnectionError(err) || !c.usable)) {
          this.reset(c);
          continue;
        }
        throw mapImapError(err, this.host());
      }
    }
  }

  /** Wählt ein Postfach exklusiv aus und führt fn aus. */
  async withMailbox<T>(path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.get();
      let lock: { release(): void } | undefined;
      try {
        lock = await c.getMailboxLock(path, { acquireTimeout: 60_000 });
        return await fn(c);
      } catch (err) {
        if (attempt === 0 && (isConnectionError(err) || !c.usable)) {
          lock?.release();
          lock = undefined;
          this.reset(c);
          continue;
        }
        const e = err as { serverResponseCode?: string; responseText?: string };
        if (e?.serverResponseCode === 'NONEXISTENT' || /nonexistent|doesn.t exist|not exist|unknown mailbox/i.test(e?.responseText ?? '')) {
          throw mapImapError(Object.assign(new Error(`Ordner "${path}" existiert nicht`), { responseText: `Ordner "${path}" existiert nicht` }));
        }
        throw mapImapError(err, this.host());
      } finally {
        lock?.release();
      }
    }
  }

  private reset(c: ImapFlow) {
    if (this.client === c) this.client = null;
    try {
      c.close();
    } catch {
      /* egal */
    }
  }

  async close() {
    this.closed = true;
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }
}

/**
 * Dauerhafte IDLE-Verbindung auf den Posteingang. Ruft onChange (entprellt) bei
 * neuen/gelöschten Nachrichten oder Flag-Änderungen auf und verbindet sich bei
 * Abbruch mit Backoff neu.
 */
export class ImapIdleWatcher {
  private client: ImapFlow | null = null;
  private stopped = false;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    private options: () => ImapFlowOptions,
    private onChange: () => void,
    private log: FastifyBaseLogger,
    private mailbox = 'INBOX',
  ) {}

  start() {
    void this.connect();
  }

  private trigger = () => {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      try {
        this.onChange();
      } catch (err) {
        this.log.warn({ err }, 'IDLE-Callback fehlgeschlagen');
      }
    }, 500);
  };

  private async connect() {
    if (this.stopped) return;
    const c = new ImapFlow({ ...this.options(), maxIdleTime: 25 * 60_000 });
    this.client = c;
    c.on('error', (err: Error) => this.log.debug({ err: err.message }, 'IMAP-IDLE-Fehler'));
    c.on('exists', this.trigger);
    c.on('expunge', this.trigger);
    c.on('flags', this.trigger);
    c.on('close', () => {
      if (this.client === c) this.client = null;
      this.scheduleReconnect();
    });
    try {
      await c.connect();
      // Lock bleibt dauerhaft bestehen → imapflow geht automatisch in IDLE
      await c.getMailboxLock(this.mailbox);
      this.retry = 0;
    } catch (err) {
      const mapped = mapImapError(err);
      this.log.warn({ err: mapped.message }, 'IMAP-IDLE-Verbindung fehlgeschlagen');
      c.close();
      // Bei falschen Zugangsdaten nicht endlos neu versuchen
      if (mapped instanceof AuthError) this.stopped = true;
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.timer) return;
    this.retry = Math.min(this.retry + 1, 8);
    const delay = Math.min(5_000 * 2 ** (this.retry - 1), 10 * 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }
}
