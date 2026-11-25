/**
 * Gmail-Quota: Google begrenzt je Nutzer die "Quota Units" pro Minute (Standard 15.000),
 * jeder Aufruf kostet je nach Methode 1–100 Units. Ohne Drosselung schöpft der Suchindex
 * (Erstbefüllung, Volltext, Abgleich) das Budget aus und die Oberfläche bekommt 429.
 *
 * Gleitendes 60-s-Fenster je Google-Nutzer (alle Kuvert-Konten derselben Adresse teilen es):
 *  - Hintergrundarbeit (runInBackground) füllt das Fenster nur bis BACKGROUND_SHARE und
 *    pausiert nach einer Drosselung durch Google, bis das Fenster wieder leer ist.
 *  - Anfragen der Oberfläche dürfen bis INTERACTIVE_SHARE und warten nur, wenn es eng wird.
 */
import { config } from '../../config.js';

const WINDOW_MS = 60_000;
const BACKGROUND_SHARE = 0.4;
const INTERACTIVE_SHARE = 0.9;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kosten eines Gmail-Aufrufs in Quota Units (developers.google.com/gmail/api/reference/quota) */
export function gmailCost(method: string, url: string): number {
  const path = /\/gmail\/v1\/users\/[^/]+\/(.*)$/.exec(new URL(url).pathname)?.[1] ?? '';
  const [resource, sub] = path.split('/');
  const m = method.toUpperCase();
  switch (resource) {
    case 'messages':
      if (sub === 'send') return 100;
      if (sub === 'batchModify' || sub === 'batchDelete') return 50;
      if (sub === 'import' || (!sub && m === 'POST')) return 25;
      return m === 'DELETE' ? 10 : 5;
    case 'drafts':
      if (sub === 'send') return 100;
      if (m === 'PUT') return 15;
      return m === 'POST' || m === 'DELETE' ? 10 : 5;
    case 'threads':
      return m === 'DELETE' ? 20 : 10;
    case 'history':
      return 2;
    case 'profile':
      return 1;
    case 'labels':
    case 'settings':
      return m === 'GET' ? 1 : 5;
    default:
      return 5;
  }
}

export class QuotaWindow {
  private entries: { t: number; units: number }[] = [];
  private used = 0;
  /** Nach einer Drosselung durch Google pausiert Hintergrundarbeit bis hierhin */
  private pausedUntil = 0;

  constructor(
    private perWindow: number,
    private windowMs = WINDOW_MS,
  ) {}

  /** Wartet, bis `units` ins Fenster passen, und bucht sie. */
  async acquire(units: number, background: boolean): Promise<void> {
    const limit = this.perWindow * (background ? BACKGROUND_SHARE : INTERACTIVE_SHARE);
    for (;;) {
      const now = Date.now();
      this.prune(now);
      const pause = background ? this.pausedUntil - now : 0;
      if (pause <= 0 && (this.used + units <= limit || !this.entries.length)) {
        this.entries.push({ t: now, units });
        this.used += units;
        return;
      }
      await sleep(Math.max(pause, this.freeAt(units, limit) - now, 50));
    }
  }

  /** Google hat gedrosselt: Hintergrundarbeit pausieren (Retry-After oder ein ganzes Fenster) */
  throttled(retryAfterMs?: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (retryAfterMs ?? this.windowMs));
  }

  get usage(): number {
    this.prune(Date.now());
    return this.used;
  }

  private prune(now: number) {
    let i = 0;
    while (i < this.entries.length && this.entries[i]!.t <= now - this.windowMs) this.used -= this.entries[i++]!.units;
    if (i) this.entries.splice(0, i);
  }

  /** Zeitpunkt, ab dem genug alte Einträge aus dem Fenster gefallen sind (0 = schon jetzt) */
  private freeAt(units: number, limit: number): number {
    let excess = this.used + units - limit;
    if (excess <= 0) return 0;
    for (const e of this.entries) {
      excess -= e.units;
      if (excess <= 0) return e.t + this.windowMs + 1;
    }
    return 0;
  }
}

const windows = new Map<string, QuotaWindow>();

/** Quota-Fenster je Google-Nutzer */
export function gmailQuota(user: string): QuotaWindow {
  const key = user.toLowerCase();
  let w = windows.get(key);
  if (!w) windows.set(key, (w = new QuotaWindow(config.gmailQuotaPerMin)));
  return w;
}

export function isGmailUrl(url: string): boolean {
  return url.startsWith('https://gmail.googleapis.com/');
}
