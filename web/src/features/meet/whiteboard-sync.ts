/**
 * Abgleich des Whiteboards (Excalidraw) zwischen den Teilnehmenden über den Datenkanal des Anrufs.
 *
 * Kein Server-Zustand: Jeder hält die Szene; neue Teilnehmende fragen nach („request“), und einer
 * der anderen schickt den vollen Stand („full“). Änderungen gehen als „update“ mit den geänderten
 * Elementen raus. Konflikte löst die Elementversion (höhere gewinnt, bei Gleichstand die kleinere
 * versionNonce – wie bei Excalidraw selbst). Große Nachrichten werden in Stücke zerlegt, weil
 * zuverlässige Datenpakete bei LiveKit auf wenige KB begrenzt sind.
 */
import { RoomEvent, type Room, type RemoteParticipant } from 'livekit-client';
import { MEET_TOPIC_WHITEBOARD } from '@kuvert/shared';

/** Excalidraw-Element (nur die Felder, die der Abgleich braucht) */
export interface WbElement {
  id: string;
  version: number;
  versionNonce: number;
  index?: string | null;
  isDeleted?: boolean;
  [key: string]: unknown;
}

/** Eingebettete Datei (Bild) */
export interface WbFile {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
  [key: string]: unknown;
}

export interface WbPointer {
  identity: string;
  name: string;
  x: number;
  y: number;
  button: 'down' | 'up';
}

type Msg =
  | { t: 'update' | 'full'; els: WbElement[]; files?: WbFile[] }
  | { t: 'request' }
  | { t: 'open'; name: string }
  | { t: 'pointer'; x: number; y: number; button: 'down' | 'up' };

type Chunk = { t: 'chunk'; id: string; i: number; n: number; d: string };

const CHUNK = 12_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Gewinnt das entfernte Element gegen das bekannte? */
const newer = (remote: WbElement, local: WbElement | undefined) =>
  !local || remote.version > local.version || (remote.version === local.version && remote.versionNonce < local.versionNonce);

export class WhiteboardSync {
  readonly elements = new Map<string, WbElement>();
  readonly files = new Map<string, WbFile>();
  /** Höchste Version, die die anderen kennen (gesendet oder empfangen) */
  private known = new Map<string, number>();
  private knownFiles = new Set<string>();
  private outEls = new Map<string, WbElement>();
  private outFiles = new Map<string, WbFile>();
  private flushTimer: number | null = null;
  private replyTimer: number | null = null;
  private chunks = new Map<string, { parts: string[]; got: number; at: number }>();
  private lastPointer = 0;

  private sceneListeners = new Set<(els: WbElement[], files: WbFile[]) => void>();
  private pointerListeners = new Set<(p: WbPointer) => void>();
  private openListeners = new Set<(name: string) => void>();

  constructor(private room: Room) {
    room.on(RoomEvent.DataReceived, this.onData);
    room.on(RoomEvent.ParticipantDisconnected, this.onLeft);
    room.on(RoomEvent.ParticipantConnected, this.onJoined);
  }

  dispose() {
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeft);
    this.room.off(RoomEvent.ParticipantConnected, this.onJoined);
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    if (this.replyTimer) window.clearTimeout(this.replyTimer);
  }

  get hasContent(): boolean {
    for (const e of this.elements.values()) if (!e.isDeleted) return true;
    return false;
  }

  /** Szene nach Excalidraw-Reihenfolge (fractional index) */
  sceneElements(): WbElement[] {
    return [...this.elements.values()].sort((a, b) => ((a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : 0));
  }

  onScene(fn: (els: WbElement[], files: WbFile[]) => void) {
    this.sceneListeners.add(fn);
    return () => void this.sceneListeners.delete(fn);
  }
  onPointer(fn: (p: WbPointer) => void) {
    this.pointerListeners.add(fn);
    return () => void this.pointerListeners.delete(fn);
  }
  onOpen(fn: (name: string) => void) {
    this.openListeners.add(fn);
    return () => void this.openListeners.delete(fn);
  }

  /* ───────────── Senden ───────────── */

  /** Lokale Änderung aus Excalidraw (onChange) */
  local(els: readonly WbElement[], files: Record<string, WbFile>) {
    for (const e of els) {
      const cur = this.elements.get(e.id);
      if (!cur || cur.version !== e.version || cur.versionNonce !== e.versionNonce) this.elements.set(e.id, e);
      if ((this.known.get(e.id) ?? -1) < e.version) {
        this.known.set(e.id, e.version);
        this.outEls.set(e.id, e);
      }
    }
    for (const f of Object.values(files)) {
      this.files.set(f.id, f);
      if (!this.knownFiles.has(f.id)) {
        this.knownFiles.add(f.id);
        this.outFiles.set(f.id, f);
      }
    }
    if ((this.outEls.size || this.outFiles.size) && !this.flushTimer) this.flushTimer = window.setTimeout(this.flush, 120);
  }

  /** Whiteboard geöffnet: anderen Bescheid geben und ggf. den Stand erfragen */
  announceOpen(name: string) {
    this.send({ t: 'open', name });
    if (!this.hasContent) this.send({ t: 'request' });
  }

  /** Beim Betreten des Anrufs: vorhandenen Stand erfragen */
  requestState() {
    this.send({ t: 'request' });
  }

  pointer(x: number, y: number, button: 'down' | 'up') {
    const now = Date.now();
    if (now - this.lastPointer < 60) return;
    this.lastPointer = now;
    this.send({ t: 'pointer', x, y, button }, false);
  }

  private flush = () => {
    this.flushTimer = null;
    const els = [...this.outEls.values()];
    const files = [...this.outFiles.values()];
    this.outEls.clear();
    this.outFiles.clear();
    if (els.length || files.length) this.send({ t: 'update', els, ...(files.length ? { files } : {}) });
  };

  private send(msg: Msg, reliable = true, to?: string[]) {
    if (this.room.state !== 'connected' || this.room.remoteParticipants.size === 0) return;
    const text = JSON.stringify(msg);
    const lp = this.room.localParticipant;
    const opts = { reliable, topic: MEET_TOPIC_WHITEBOARD, ...(to ? { destinationIdentities: to } : {}) };
    if (text.length <= CHUNK) {
      void lp.publishData(enc.encode(text), opts).catch(() => undefined);
      return;
    }
    const id = Math.random().toString(36).slice(2, 10);
    const n = Math.ceil(text.length / CHUNK);
    void (async () => {
      for (let i = 0; i < n; i++) {
        const chunk: Chunk = { t: 'chunk', id, i, n, d: text.slice(i * CHUNK, (i + 1) * CHUNK) };
        try {
          await lp.publishData(enc.encode(JSON.stringify(chunk)), { ...opts, reliable: true });
        } catch {
          return;
        }
      }
    })();
  }

  /* ───────────── Empfangen ───────────── */

  /** Neu im Anruf: vorhandenen Stand direkt zuschicken (etwas verzögert, bis die Verbindung steht) */
  private onJoined = (p: RemoteParticipant) => {
    if (!this.hasContent) return;
    window.setTimeout(
      () => this.send({ t: 'full', els: [...this.elements.values()], files: [...this.files.values()] }, true, [p.identity]),
      800 + Math.random() * 800,
    );
  };

  private onLeft = (p: RemoteParticipant) => {
    for (const fn of this.pointerListeners) fn({ identity: p.identity, name: '', x: NaN, y: NaN, button: 'up' });
  };

  private onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (topic !== MEET_TOPIC_WHITEBOARD || !participant) return;
    let msg: Msg | Chunk;
    try {
      msg = JSON.parse(dec.decode(payload)) as Msg | Chunk;
    } catch {
      return;
    }
    if (msg.t === 'chunk') {
      const now = Date.now();
      for (const [k, v] of this.chunks) if (now - v.at > 60_000) this.chunks.delete(k);
      const key = `${participant.identity}:${msg.id}`;
      const entry = this.chunks.get(key) ?? { parts: new Array<string>(msg.n), got: 0, at: now };
      if (entry.parts[msg.i] === undefined) entry.got++;
      entry.parts[msg.i] = msg.d;
      this.chunks.set(key, entry);
      if (entry.got < msg.n) return;
      this.chunks.delete(key);
      try {
        msg = JSON.parse(entry.parts.join('')) as Msg;
      } catch {
        return;
      }
    }
    this.handle(msg, participant);
  };

  private handle(msg: Msg, from: RemoteParticipant) {
    switch (msg.t) {
      case 'update':
      case 'full': {
        if (msg.t === 'full' && this.replyTimer) {
          // Jemand anderes hat schon geantwortet
          window.clearTimeout(this.replyTimer);
          this.replyTimer = null;
        }
        const accepted: WbElement[] = [];
        for (const e of msg.els) {
          if ((this.known.get(e.id) ?? -1) < e.version) this.known.set(e.id, e.version);
          if (newer(e, this.elements.get(e.id))) {
            this.elements.set(e.id, e);
            accepted.push(e);
          }
        }
        const files: WbFile[] = [];
        for (const f of msg.files ?? []) {
          this.knownFiles.add(f.id);
          if (!this.files.has(f.id)) {
            this.files.set(f.id, f);
            files.push(f);
          }
        }
        if (accepted.length || files.length) for (const fn of this.sceneListeners) fn(accepted, files);
        break;
      }
      case 'request': {
        if (!this.hasContent || this.replyTimer) return;
        // Leicht verzögert und zufällig, damit nicht alle gleichzeitig den vollen Stand schicken
        this.replyTimer = window.setTimeout(() => {
          this.replyTimer = null;
          this.send({ t: 'full', els: [...this.elements.values()], files: [...this.files.values()] });
        }, 150 + Math.random() * 600);
        break;
      }
      case 'open':
        for (const fn of this.openListeners) fn(msg.name || from.name || from.identity);
        break;
      case 'pointer':
        for (const fn of this.pointerListeners) fn({ identity: from.identity, name: from.name || from.identity, x: msg.x, y: msg.y, button: msg.button });
        break;
    }
  }
}
