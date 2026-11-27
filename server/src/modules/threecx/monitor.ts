/**
 * Eingehende Anrufe an den Nebenstellen der Benutzer erkennen und melden (SSE + Web Push).
 *
 * Quelle ist der WebSocket der Call Control API (wss://…/callcontrol/ws): Er meldet nur, dass sich
 * an einer Nebenstelle etwas geändert hat; den Zustand (Ringing, Connected …) liest Kuvert dann
 * per REST. Klappt der WebSocket nicht, fragt Kuvert alle überwachten Nebenstellen alle paar
 * Sekunden ab (eine Anfrage für alle) und versucht es mit wachsendem Abstand erneut.
 *
 * Ablauf je Teilnehmer (Gesprächsbein an meiner Nebenstelle):
 *  Ringing → „klingelt“ · Connected → „angenommen“ · verschwindet ohne Annahme → „verpasst“
 *  (über Warteschlange/Ringgruppe nur „vorbei“ – da kann eine Kollegin angenommen haben).
 */
import type { ThreeCxIncomingCall } from '@kuvert/shared';
import { within } from '../../core/contact-search.js';
import { AppError } from '../../core/errors.js';
import type { ModuleContext } from '../../core/module.js';
import { pushStore } from '../notifications/push.js';
import { lookupCaller, warmCallerIndex, type CallerInfo } from './caller.js';
import type { CcParticipant, CcWsMessage, ThreeCxClient } from './client.js';
import { adminConfig, extensions } from './store.js';

const POLL_MS = 3_000;
const DEBOUNCE_MS = 250;
/** Neu verbinden, bevor das Token (60 min) abläuft */
const RECONNECT_EVERY_MS = 50 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Nach Click-to-Call aus Kuvert klingelt ggf. zuerst das eigene Telefon – das ist kein Anruf an mich */
const OUTGOING_GRACE_MS = 45_000;
/** Höchstens so lange auf die Kontaktsuche warten, bevor gemeldet wird */
const LOOKUP_WAIT_MS = 1_500;
const WARM_EVERY_MS = 25 * 60_000;

interface Tracked {
  id: string;
  dn: string;
  /** Wird gemeldet (sonst nur mitverfolgt, z. B. eigener Anruf) */
  notify: boolean;
  answered: boolean;
  /** Über Warteschlange/Ringgruppe – ohne Annahme nicht sicher verpasst */
  group: boolean;
  userIds: string[];
  /** Je Benutzer zuletzt gemeldeter Stand (Name kann je nach Kontakten verschieden sein) */
  calls: Map<string, ThreeCxIncomingCall>;
  /** Rufnummer für die Kontaktsuche (nicht bei internen Anrufen) */
  lookupNumber: string | null;
}

const clean = (v: string | null | undefined) => (v ?? '').trim() || null;
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

export class CallMonitor {
  private ws: WebSocket | null = null;
  private stopped = true;
  private failures = 0;
  private warned = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private warmTimer: NodeJS.Timeout | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private tracked = new Map<string, Tracked>();
  private outgoing = new Map<string, { until: number; dest: string }>();
  private polling = false;

  constructor(private ctx: ModuleContext) {}

  start() {
    this.stop();
    if (!adminConfig.ready()) return;
    this.stopped = false;
    void this.connect();
    this.warm();
    this.warmTimer = setInterval(() => this.warm(), WARM_EVERY_MS);
    this.warmTimer.unref();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.reconnectTimer, this.renewTimer, this.pollTimer]) if (t) clearTimeout(t);
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.reconnectTimer = this.renewTimer = this.pollTimer = this.warmTimer = null;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* egal */
    }
    this.failures = 0;
  }

  /** Click-to-Call aus Kuvert: Klingeln des eigenen Telefons nicht als eingehenden Anruf melden */
  noteOutgoing(dn: string, destination: string) {
    this.outgoing.set(dn, { until: Date.now() + OUTGOING_GRACE_MS, dest: digits(destination) });
  }

  private client(): ThreeCxClient {
    return adminConfig.client();
  }

  private cacheKey(): string {
    const c = adminConfig.get();
    return `${c.baseUrl}|${c.clientId}`;
  }

  /** Kontakte der Benutzer mit Nebenstelle vorladen (erste Meldung soll nicht auf sie warten) */
  private warm() {
    for (const r of extensions.all()) if (r.notify_calls) warmCallerIndex(this.ctx, r.user_id);
  }

  /* ─────────── Verbindung ─────────── */

  private async connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = await this.client().openEvents();
    } catch (err) {
      this.onDown((err as Error).message);
      return;
    }
    if (this.stopped) {
      ws.close();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.failures || this.warned) this.ctx.log.info('3CX: Echtzeit-Verbindung für Anrufe steht');
      this.failures = 0;
      this.warned = false;
      this.stopPolling();
      // Stand abgleichen (was während der Unterbrechung passiert ist)
      void this.refreshAll();
      this.renewTimer = setTimeout(() => {
        this.renewTimer = null;
        ws.close();
      }, RECONNECT_EVERY_MS);
      this.renewTimer.unref();
    });
    ws.addEventListener('message', (e) => {
      let msg: CcWsMessage;
      try {
        msg = JSON.parse(String(e.data)) as CcWsMessage;
      } catch {
        return;
      }
      const m = /^\/callcontrol\/([^/]+)\/participants(?:\/|$)/.exec(msg.event?.entity ?? '');
      if (m) this.refreshSoon(decodeURIComponent(m[1]!));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.renewTimer = null;
      this.onDown('Verbindung geschlossen');
    });
    ws.addEventListener('error', () => {
      /* "close" folgt */
    });
  }

  private onDown(reason: string) {
    if (this.stopped) return;
    this.failures++;
    if (this.failures >= 3 && !this.warned) {
      this.warned = true;
      this.ctx.log.warn({ reason }, '3CX: WebSocket für Anrufe nicht verfügbar – frage stattdessen regelmäßig ab');
    }
    this.startPolling();
    const delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(this.failures - 1, 8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private startPolling() {
    if (this.pollTimer || this.stopped) return;
    const tick = async () => {
      await this.refreshAll();
      if (!this.stopped && this.pollTimer) {
        this.pollTimer = setTimeout(() => void tick(), POLL_MS);
        this.pollTimer.unref();
      }
    };
    this.pollTimer = setTimeout(() => void tick(), 0);
    this.pollTimer.unref();
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /* ─────────── Zustand ─────────── */

  private refreshSoon(dn: string) {
    const prev = this.debounce.get(dn);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.debounce.delete(dn);
      void this.refresh(dn);
    }, DEBOUNCE_MS);
    t.unref();
    this.debounce.set(dn, t);
  }

  private async refresh(dn: string) {
    if (!this.relevant(dn)) return;
    try {
      this.apply(dn, await this.client().participants(dn));
    } catch (err) {
      if (err instanceof AppError && (err.status === 403 || err.status === 404)) this.apply(dn, []);
      else this.ctx.log.debug({ err, dn }, '3CX: Gespräche der Nebenstelle nicht abrufbar');
    }
  }

  private async refreshAll() {
    if (this.polling || this.stopped) return;
    // Niemand mit Nebenstelle und Benachrichtigung – die Anlage nicht umsonst abfragen
    if (!this.tracked.size && !extensions.all().some((r) => r.notify_calls)) return;
    this.polling = true;
    try {
      const entities = await this.client().entities();
      const seen = new Set<string>();
      for (const e of entities) {
        seen.add(e.dn);
        if (this.relevant(e.dn)) this.apply(e.dn, e.participants ?? []);
      }
      for (const dn of new Set([...this.tracked.values()].map((t) => t.dn))) if (!seen.has(dn)) this.apply(dn, []);
    } catch (err) {
      this.ctx.log.debug({ err }, '3CX: Abgleich der Gespräche fehlgeschlagen');
    } finally {
      this.polling = false;
    }
  }

  /** Nebenstelle gehört einem Benutzer mit Benachrichtigung – oder wird gerade verfolgt */
  private relevant(dn: string): boolean {
    return [...this.tracked.values()].some((t) => t.dn === dn) || extensions.all().some((r) => r.extension === dn && r.notify_calls);
  }

  private apply(dn: string, list: CcParticipant[]) {
    const seen = new Set<string>();
    for (const p of list) {
      const id = `${dn}|${p.callid ?? ''}|${p.id}`;
      seen.add(id);
      const t = this.tracked.get(id);
      const status = String(p.status ?? '');
      if (!t) {
        const fresh = this.track(id, dn, p, /^ringing$/i.test(status));
        this.tracked.set(id, fresh);
        if (fresh.notify) void this.announce(fresh);
        continue;
      }
      if (/^connected$/i.test(status) && !t.answered) {
        t.answered = true;
        if (t.notify) this.emit(t, 'answered');
      }
    }
    for (const [id, t] of this.tracked) {
      if (t.dn !== dn || seen.has(id)) continue;
      this.tracked.delete(id);
      if (t.notify) this.emit(t, t.answered || t.group ? 'ended' : 'missed');
    }
  }

  /** Neuen Teilnehmer aufnehmen; klingelt er bei mir, wird er gemeldet (notify) */
  private track(id: string, dn: string, p: CcParticipant, ringing: boolean): Tracked {
    const via = /queue|ring|hunt/i.test(p.originated_by_type ?? '') ? clean(p.originated_by_dn) : null;
    const t: Tracked = { id, dn, notify: false, answered: !ringing, group: !!via, userIds: [], calls: new Map(), lookupNumber: null };
    if (!ringing) return t;
    const number = clean(p.party_caller_id) ?? clean(p.party_dn);
    const out = this.outgoing.get(dn);
    if (out && out.until > Date.now()) {
      const d = digits(number);
      // Gegenstelle = gerade aus Kuvert gewählte Nummer (oder unbekannt) → eigener Anruf
      if (!d || !out.dest || d.endsWith(out.dest.slice(-8)) || out.dest.endsWith(d.slice(-8))) return t;
    }
    t.userIds = extensions
      .all()
      .filter((r) => r.extension === dn && r.notify_calls)
      .map((r) => r.user_id);
    if (!t.userIds.length) return t;
    t.notify = true;
    const internal = /extension/i.test(p.party_dn_type ?? '') || (!!number && digits(number).length > 0 && digits(number).length <= 5);
    const base: ThreeCxIncomingCall = {
      key: `${dn}-${p.callid ?? ''}-${p.id}`,
      state: 'ringing',
      number,
      name: clean(p.party_caller_name),
      company: null,
      internal,
      via,
      at: new Date().toISOString(),
    };
    for (const userId of t.userIds) t.calls.set(userId, { ...base });
    t.lookupNumber = internal ? null : number;
    return t;
  }

  /** Erste Meldung: Anrufer in den Kontakten suchen (kurz), dann melden */
  private async announce(t: Tracked) {
    const client = this.client();
    const key = this.cacheKey();
    const number = t.lookupNumber;
    await Promise.all(
      t.userIds.map(async (userId) => {
        const info = number ? await within<CallerInfo | null>(lookupCaller(this.ctx, userId, number, client, key), LOOKUP_WAIT_MS, null) : null;
        const call = t.calls.get(userId)!;
        if (info) {
          call.name = info.name;
          call.company = info.company;
        }
        // Inzwischen angenommen oder vorbei? Dann meldet emit() den neuen Stand
        if (call.state !== 'ringing' || this.tracked.get(t.id) !== t) return;
        this.send(userId, call);
      }),
    );
  }

  private emit(t: Tracked, state: ThreeCxIncomingCall['state']) {
    for (const userId of t.userIds) {
      const call = t.calls.get(userId);
      if (!call) continue;
      call.state = state;
      this.send(userId, call);
    }
  }

  private send(userId: string, call: ThreeCxIncomingCall) {
    this.ctx.bus.publish(userId, { type: 'threecx.call', call: { ...call } });
    if (call.state !== 'ringing' && call.state !== 'missed') return;
    if (!this.ctx.registry.modules.some((m) => m.id === 'notifications') || !pushStore.hasSubscriptions(userId)) return;
    const who = call.name ?? call.number ?? 'Unbekannt';
    const details = [call.name ? call.number : null, call.company, call.via ? `über ${call.via}` : null].filter(Boolean).join(' · ');
    void pushStore
      .send(userId, {
        title: call.state === 'missed' ? `Verpasster Anruf von ${who}` : `📞 ${who} ruft an`,
        body: details || (call.state === 'missed' ? 'Zum Zurückrufen öffnen' : 'Eingehender Anruf'),
        url: '/phone',
        // Gleicher Tag: "Verpasst" ersetzt auf dem Gerät die Klingel-Benachrichtigung
        tag: `threecx-${call.key}`,
      })
      .catch((err) => this.ctx.log.debug({ err }, '3CX: Web Push für Anruf fehlgeschlagen'));
  }
}
