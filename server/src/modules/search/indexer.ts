/**
 * Indexer: liest Nachrichten aller Konten in Meilisearch ein und hält den Index aktuell.
 *
 *  - Erstbefüllung ("Backfill"): je Ordner von neu nach alt, seitenweise, fortsetzbar
 *  - Neue Nachrichten: Kopf jedes Ordners im Intervall + sofort bei "mail.new"
 *  - Änderungen durch Kuvert (Flags, Verschieben, Löschen): sofort über "mail.mutated"
 *  - Abgleich alle 12 h: gelöschte/verschobene Nachrichten und Flags von anderen Clients
 *
 * Sicherheit: Jedes Dokument trägt die userId; jede Suche filtert serverseitig darauf.
 * Verschlüsselte S/MIME-Inhalte werden bewusst NICHT im Klartext indiziert.
 */
import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailAddress, FolderRole, MailFolder, MessageSummary, SearchAccountStatus } from '@kuvert/shared';
import { HIGHLIGHT_END, HIGHLIGHT_START } from '@kuvert/shared';
import { config } from '../../config.js';
import { runInBackground } from '../../core/background.js';
import { kv } from '../../core/db.js';
import type { MailMutation } from '../../core/events.js';
import { htmlToText, looksLikeSmime } from '../../core/mime.js';
import type { AccountRecord, ModuleContext } from '../../core/module.js';
import type { MailProvider } from '../../core/providers.js';
import { MeiliClient, q } from './meili.js';
import { parseQuery, terms } from './query.js';

export const INDEX_UID = 'kuvert_messages';

const PAGE = 100;
const HEAD_PAGE = 50;
const MAX_PARALLEL_ACCOUNTS = 3;
/** Konten ohne offene Arbeit frühestens nach dieser Pause erneut prüfen (knapp unter dem 20-s-Takt) */
const IDLE_RECHECK_MS = 15_000;
const BODY_CONCURRENCY = 3;
const MAX_BODY_CHARS = 30_000;
const MAX_MESSAGE_SIZE_FOR_BODY = 15 * 1024 * 1024;
const RECONCILE_MS = 12 * 3600_000;

interface MessageDoc {
  id: string;
  userId: string;
  accountId: string;
  folderId: string;
  folderRole: FolderRole;
  folderName: string;
  folderKey: string;
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
  fromObj?: EmailAddress;
  fromTerms: string[];
  to: string;
  toObj: EmailAddress[];
  ccObj?: EmailAddress[];
  toTerms: string[];
  date: number;
  dateIso: string;
  preview: string;
  body?: string;
  attachments: string[];
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  importance?: string;
  size?: number;
  hasBody: boolean;
}

interface FolderState {
  name: string;
  role: FolderRole;
  cursor?: string | null;
  done: boolean;
  lastHead?: number;
  lastReconcile?: number;
}

interface AccountState {
  folders: Record<string, FolderState>;
  ready: boolean;
  lastSyncAt?: string | null;
  error?: string | null;
}

const RETRIEVE = [
  'id',
  'accountId',
  'folderId',
  'folderRole',
  'messageId',
  'threadId',
  'subject',
  'fromObj',
  'toObj',
  'ccObj',
  'dateIso',
  'preview',
  'hasAttachments',
  'seen',
  'flagged',
  'answered',
  'importance',
  'size',
];

export function docId(accountId: string, folderId: string, messageId: string): string {
  return crypto.createHash('sha1').update(`${accountId}\n${folderId}\n${messageId}`).digest('hex');
}

const fmt = (a?: EmailAddress) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

export class SearchIndexer {
  private client: MeiliClient | null = null;
  private clientKey = '';
  private indexReady = false;
  private reachable = false;
  private lastError: string | null = null;
  private running = new Set<string>();
  /** Ende des letzten Laufs je Konto – bestimmt die Reihenfolge (wer am längsten wartet, zuerst) */
  private lastRun = new Map<string, number>();
  /** Konten, deren letzter Lauf noch Arbeit übrig ließ (Erstbefüllung, Volltext) */
  private unfinished = new Set<string>();
  /** Konten, die während ihres laufenden Durchgangs verworfen wurden (Neu indizieren, ausgeschlossen, gelöscht) */
  private dropped = new Set<string>();
  /** Konten, deren Index gerade geleert wird */
  private purges = new Map<string, Promise<void>>();
  private currentFolder = new Map<string, string>();
  private forcedHead = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private ctx: ModuleContext,
    private log: FastifyBaseLogger,
  ) {}

  /* ═════════════════════════════ Verbindung & Index ═════════════════════════════ */

  get configured(): boolean {
    const s = config.search;
    return s.enabled && !!s.url;
  }

  get available(): boolean {
    return this.configured && this.reachable && this.indexReady;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Client für aktuelle Einstellungen; bei Änderung neu aufbauen */
  getClient(): MeiliClient | null {
    if (!this.configured) return null;
    const { url, apiKey } = config.search;
    const key = `${url}|${apiKey}`;
    if (key !== this.clientKey) {
      this.client = new MeiliClient(url, apiKey);
      this.clientKey = key;
      this.indexReady = false;
      this.reachable = false;
    }
    return this.client;
  }

  /** Erreichbarkeit prüfen und Index samt Einstellungen anlegen */
  async ensureIndex(): Promise<boolean> {
    const client = this.getClient();
    if (!client) {
      this.reachable = false;
      return false;
    }
    try {
      await client.health();
      this.reachable = true;
      if (!this.indexReady) {
        if (!(await client.getIndex(INDEX_UID))) await client.createIndex(INDEX_UID, 'id');
        await client.updateSettings(INDEX_UID, {
          searchableAttributes: ['subject', 'from', 'to', 'attachments', 'body', 'preview'],
          filterableAttributes: [
            'userId',
            'accountId',
            'folderId',
            'folderRole',
            'folderKey',
            'messageId',
            'fromTerms',
            'toTerms',
            'date',
            'seen',
            'flagged',
            'hasAttachments',
            'hasBody',
          ],
          sortableAttributes: ['date'],
          // Alle Suchwörter → exakt vor Tippfehler → Betreff/Absender vor Text → neueste zuerst
          rankingRules: ['words', 'typo', 'attributeRank', 'sort', 'proximity', 'wordPosition', 'exactness'],
          typoTolerance: { minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 } },
          pagination: { maxTotalHits: 5000 },
          // Mails enthalten oft beides – deutsch + englisch
          localizedAttributes: [{ attributePatterns: ['*'], locales: ['deu', 'eng'] }],
        });
        this.indexReady = true;
      }
      this.lastError = null;
      return true;
    } catch (err) {
      this.reachable = false;
      this.lastError = (err as Error).message;
      return false;
    }
  }

  /* ═════════════════════════════ Lebenszyklus ═════════════════════════════ */

  start() {
    this.healthTimer = setInterval(() => void this.ensureIndex(), 60_000);
    this.healthTimer.unref();
    void this.ensureIndex().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    const bus = this.ctx.bus.internal;
    bus.on('mail.mutated', (m) => void this.onMutation(m).catch((err) => this.log.debug({ err }, 'Index-Aktualisierung fehlgeschlagen')));
    bus.on('user.event', (_uid, e) => {
      if (e.type === 'mail.new') this.requestHeadSync(e.accountId);
    });
    bus.on('account.created', () => setTimeout(() => void this.tick(), 1000).unref());
    bus.on('account.deleted', (acc) => void this.dropAccount(acc.id));
    bus.on('account.updated', (acc) => {
      if (acc.settings.searchIndex === false) void this.dropAccount(acc.id);
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  requestHeadSync(accountId: string) {
    this.forcedHead.add(accountId);
    setTimeout(() => void this.tick(), 2000).unref();
  }

  private eligible(): AccountRecord[] {
    return this.ctx.accounts
      .listAllEnabled()
      .filter((a) => a.settings.searchIndex !== false && this.ctx.accounts.capabilities(a).includes('mail'));
  }

  private async tick() {
    if (this.stopped || !this.configured) return;
    if (!this.available && !(await this.ensureIndex())) return;
    const now = Date.now();
    const last = (a: AccountRecord) => this.lastRun.get(a.id) ?? 0;
    // Reihum: Wer am längsten nicht dran war, kommt zuerst. In fester Reihenfolge belegten
    // stets dieselben ersten Konten alle Plätze – jedes weitere Konto wurde nie indiziert.
    const due = this.eligible()
      .filter((a) => !this.running.has(a.id) && !this.purges.has(a.id) && (this.forcedHead.has(a.id) || this.unfinished.has(a.id) || now - last(a) >= IDLE_RECHECK_MS))
      .sort((a, b) => last(a) - last(b));
    for (const acc of due) {
      if (this.running.size >= MAX_PARALLEL_ACCOUNTS) break;
      // Nachrangig gegenüber der Oberfläche (z. B. Gmail-Quota-Drosselung)
      void runInBackground(() => this.runAccount(acc));
    }
  }

  /* ═════════════════════════════ Zustand ═════════════════════════════ */

  private load(accountId: string): AccountState {
    return kv.get<AccountState>('search', accountId) ?? { folders: {}, ready: false };
  }

  private save(accountId: string, st: AccountState) {
    // Ein noch laufender Durchgang darf seinen alten Stand nicht über den verworfenen schreiben –
    // sonst gälte das Konto als fertig indiziert, obwohl sein Index geleert wurde
    if (this.dropped.has(accountId)) return;
    kv.set('search', accountId, st);
  }

  /** Durchgang beenden: Server fährt herunter oder das Konto wurde währenddessen verworfen */
  private aborted(accountId: string): boolean {
    return this.stopped || this.dropped.has(accountId);
  }

  /**
   * Alle Dokumente des Kontos entfernen und abwarten, bis Meilisearch das verarbeitet hat.
   * Solange startet kein neuer Durchgang: Er fände die alten Dokumente noch vor, hielte sie
   * für bereits indiziert und überspränge sie – nach dem Leeren fehlten sie dann.
   */
  private purge(accountId: string): Promise<void> {
    let p = this.purges.get(accountId);
    if (!p) {
      p = (async () => {
        const client = this.getClient();
        if (!client || !this.available) return;
        const task = await client.deleteByFilter(INDEX_UID, `accountId = ${q(accountId)}`);
        await client.waitTask(task.taskUid, 120_000);
      })()
        .catch((err) => this.log.debug({ err, accountId }, 'Suchindex: Konto nicht geleert'))
        .finally(() => this.purges.delete(accountId));
      this.purges.set(accountId, p);
    }
    return p;
  }

  async dropAccount(accountId: string) {
    kv.delete('search', accountId);
    // Beim nächsten Durchgang sofort wieder einreihen (Neu indizieren, erneut einschließen)
    this.lastRun.delete(accountId);
    this.unfinished.delete(accountId);
    // Ein laufender Durchgang bricht ab und leert den Index selbst, sobald er nichts mehr schreibt
    if (this.running.has(accountId)) this.dropped.add(accountId);
    else await this.purge(accountId);
  }

  async reindexAccount(accountId: string) {
    await this.dropAccount(accountId);
    setTimeout(() => void this.tick(), 500).unref();
  }

  async rebuildAll() {
    const client = this.getClient();
    if (!client) return;
    for (const id of this.running) this.dropped.add(id);
    for (const acc of this.eligible()) kv.delete('search', acc.id);
    kv.deleteScope('search');
    this.lastRun.clear();
    this.unfinished.clear();
    if (await client.getIndex(INDEX_UID)) await client.deleteIndex(INDEX_UID);
    this.indexReady = false;
    await this.ensureIndex();
    void this.tick();
  }

  /* ═════════════════════════════ Synchronisation eines Kontos ═════════════════════════════ */

  private wantedFolders(acc: AccountRecord, folders: MailFolder[]): MailFolder[] {
    const exclude = new Set<FolderRole>(['outbox']);
    if (!config.search.includeTrash) {
      exclude.add('trash');
      exclude.add('junk');
    }
    // Gmail: Labels überschneiden sich → nur "Alle Nachrichten" (enthält Posteingang, Gesendet, Archiv)
    if (acc.type === 'google') {
      const all = folders.find((f) => f.id === 'ALL');
      if (all) return [all, ...(config.search.includeTrash ? folders.filter((f) => f.role === 'trash' || f.role === 'junk') : [])];
    }
    return folders.filter((f) => f.selectable !== false && !exclude.has(f.role));
  }

  private async runAccount(acc: AccountRecord) {
    this.running.add(acc.id);
    let more = false;
    const st = this.load(acc.id);
    try {
      const mail = this.ctx.accounts.providersFor(acc).mail;
      if (!mail) return;
      const { folders } = await mail.listFolders();
      const wanted = this.wantedFolders(acc, folders);
      const client = this.getClient()!;

      // Entfernte/umbenannte Ordner aus dem Index löschen
      const wantedIds = new Set(wanted.map((f) => f.id));
      for (const fid of Object.keys(st.folders)) {
        if (!wantedIds.has(fid)) {
          await client.deleteByFilter(INDEX_UID, `accountId = ${q(acc.id)} AND folderId = ${q(fid)}`);
          delete st.folders[fid];
        }
      }

      const forced = this.forcedHead.delete(acc.id);
      const now = Date.now();
      const interval = Math.max(1, config.search.syncIntervalMin) * 60_000;

      for (const folder of wanted) {
        if (this.aborted(acc.id)) break;
        const fs = (st.folders[folder.id] ??= { name: folder.name, role: folder.role, done: false });
        fs.name = folder.name;
        fs.role = folder.role;
        this.currentFolder.set(acc.id, folder.name);
        if (!fs.done) {
          more = (await this.backfill(acc, mail, folder, fs, 10)) || more;
          this.save(acc.id, st);
        } else if (forced || now - (fs.lastHead ?? 0) > interval) {
          await this.headSync(acc, mail, folder);
          fs.lastHead = now;
        }
        if (fs.done && now - (fs.lastReconcile ?? 0) > RECONCILE_MS) {
          await this.reconcile(acc, mail, folder);
          fs.lastReconcile = Date.now();
        }
      }
      st.ready = wanted.every((f) => st.folders[f.id]?.done);
      // Sofort speichern: Konto ist ab jetzt über den Index durchsuchbar
      this.save(acc.id, st);
      if (st.ready && !this.aborted(acc.id)) {
        this.currentFolder.set(acc.id, 'Volltext');
        more = (await this.enrichBodies(acc, mail, wanted.map((f) => f.id), 8)) || more;
      }
      st.lastSyncAt = new Date().toISOString();
      st.error = null;
    } catch (err) {
      st.error = (err as Error).message;
      this.log.debug({ err, accountId: acc.id }, 'Suchindex: Synchronisation fehlgeschlagen');
    } finally {
      this.save(acc.id, st);
      const dropped = this.dropped.has(acc.id);
      // Was dieser Durchgang nach dem Verwerfen noch geschrieben hat, wieder entfernen – und zwar
      // bevor das Konto als frei gilt, damit der Neuaufbau erst danach beginnt
      if (dropped) await this.purge(acc.id);
      this.dropped.delete(acc.id);
      this.currentFolder.delete(acc.id);
      this.running.delete(acc.id);
      if (dropped) this.lastRun.delete(acc.id);
      else this.lastRun.set(acc.id, Date.now());
      if (more && !dropped) this.unfinished.add(acc.id);
      else this.unfinished.delete(acc.id);
      // Freien Platz gleich weitergeben: Erstbefüllung fortsetzen oder das nächste wartende Konto starten
      if (!this.stopped) setTimeout(() => void this.tick(), 200).unref();
    }
  }

  /** Bis zu `pages` Seiten eines Ordners einlesen. true = es gibt noch mehr. */
  private async backfill(acc: AccountRecord, mail: MailProvider, folder: MailFolder, fs: FolderState, pages: number): Promise<boolean> {
    const cutoff = config.search.maxAgeDays > 0 ? Date.now() - config.search.maxAgeDays * 86_400_000 : 0;
    for (let i = 0; i < pages; i++) {
      const page = await mail.listMessages({ folderId: folder.id, cursor: fs.cursor ?? undefined, limit: PAGE });
      if (this.aborted(acc.id)) return false;
      const items = cutoff ? page.items.filter((m) => new Date(m.date).getTime() >= cutoff) : page.items;
      await this.indexItems(acc, mail, folder, items);
      const reachedCutoff = cutoff > 0 && items.length < page.items.length;
      if (!page.nextCursor || reachedCutoff) {
        fs.done = true;
        fs.cursor = null;
        fs.lastHead = Date.now();
        fs.lastReconcile = Date.now();
        return false;
      }
      fs.cursor = page.nextCursor;
    }
    return true;
  }

  /** Neue Nachrichten am Anfang des Ordners nachziehen */
  private async headSync(acc: AccountRecord, mail: MailProvider, folder: MailFolder) {
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await mail.listMessages({ folderId: folder.id, cursor, limit: HEAD_PAGE });
      const added = await this.indexItems(acc, mail, folder, page.items);
      if (added < page.items.length || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  /** Abgleich: gelöschte Nachrichten entfernen, Flags anderer Clients übernehmen */
  private async reconcile(acc: AccountRecord, mail: MailProvider, folder: MailFolder) {
    const client = this.getClient()!;
    const live = new Map<string, MessageSummary>();
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await mail.listMessages({ folderId: folder.id, cursor, limit: 200 });
      // Nur beim Verwerfen abbrechen – beim Herunterfahren würde der Abgleich sonst als erledigt gespeichert
      if (this.dropped.has(acc.id)) return;
      for (const m of page.items) live.set(m.id, m);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const remove: string[] = [];
    const updates: Partial<MessageDoc>[] = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await client.fetchDocuments<Pick<MessageDoc, 'id' | 'messageId' | 'seen' | 'flagged'>>(INDEX_UID, {
        filter: `accountId = ${q(acc.id)} AND folderId = ${q(folder.id)}`,
        fields: ['id', 'messageId', 'seen', 'flagged'],
        limit: 1000,
        offset,
      });
      for (const d of res.results) {
        const m = live.get(d.messageId);
        if (!m) remove.push(d.id);
        else if (m.seen !== d.seen || m.flagged !== d.flagged) updates.push({ id: d.id, seen: m.seen, flagged: m.flagged });
      }
      if (res.results.length < 1000) break;
    }
    if (this.dropped.has(acc.id)) return;
    if (remove.length) await client.deleteIds(INDEX_UID, remove);
    if (updates.length) await client.updateDocuments(INDEX_UID, updates);
  }

  /** Indiziert fehlende Nachrichten einer Seite, aktualisiert Flags. Liefert Anzahl neuer Dokumente. */
  private async indexItems(acc: AccountRecord, mail: MailProvider, folder: MailFolder, items: MessageSummary[]): Promise<number> {
    if (!items.length) return 0;
    const client = this.getClient()!;
    const existing = await this.fetchExisting(acc.id, folder.id, items.map((m) => m.id));
    const missing = items.filter((m) => !existing.has(m.id));
    const flagUpdates = items
      .filter((m) => {
        const e = existing.get(m.id);
        return e && (e.seen !== m.seen || e.flagged !== m.flagged);
      })
      .map((m) => ({ id: docId(acc.id, folder.id, m.id), seen: m.seen, flagged: m.flagged }));
    if (flagUpdates.length) await client.updateDocuments(INDEX_UID, flagUpdates);
    if (!missing.length) return 0;

    // Stufe 1: nur Kopfdaten (sofort durchsuchbar); Texte ergänzt enrichBodies() im Hintergrund
    const docs = missing.map((m) => this.buildDoc(acc, folder, m));
    await client.addDocuments(INDEX_UID, docs);
    return missing.length;
  }

  private async fetchExisting(accountId: string, folderId: string, messageIds: string[]) {
    const out = new Map<string, { seen: boolean; flagged: boolean }>();
    const client = this.getClient()!;
    for (let i = 0; i < messageIds.length; i += 100) {
      const chunk = messageIds.slice(i, i + 100);
      const res = await client.fetchDocuments<Pick<MessageDoc, 'messageId' | 'seen' | 'flagged'>>(INDEX_UID, {
        filter: `accountId = ${q(accountId)} AND folderId = ${q(folderId)} AND messageId IN [${chunk.map(q).join(', ')}]`,
        fields: ['messageId', 'seen', 'flagged'],
        limit: chunk.length,
      });
      for (const d of res.results) out.set(d.messageId, { seen: d.seen, flagged: d.flagged });
    }
    return out;
  }

  private buildDoc(acc: AccountRecord, folder: MailFolder, m: MessageSummary): MessageDoc {
    const to = [...(m.to ?? []), ...(m.cc ?? [])];
    const ts = new Date(m.date).getTime();
    return {
      id: docId(acc.id, folder.id, m.id),
      userId: acc.userId,
      accountId: acc.id,
      folderId: folder.id,
      folderRole: folder.role,
      folderName: folder.name,
      folderKey: folder.name.toLowerCase(),
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject ?? '',
      from: fmt(m.from),
      fromObj: m.from,
      fromTerms: terms(m.from?.name, m.from?.address),
      to: to.map(fmt).join(', '),
      toObj: m.to ?? [],
      ccObj: m.cc,
      toTerms: terms(...to.flatMap((a) => [a.name, a.address])),
      date: Number.isFinite(ts) ? Math.floor(ts / 1000) : 0,
      dateIso: m.date,
      preview: m.preview ?? '',
      attachments: [],
      hasAttachments: m.hasAttachments,
      seen: m.seen,
      flagged: m.flagged,
      answered: m.answered,
      importance: m.importance,
      size: m.size,
      // Ohne Volltext-Indizierung gibt es nichts nachzuladen
      hasBody: !config.search.indexBodies,
    };
  }

  /**
   * Stufe 2: Nachrichtentexte und Anhangnamen nachladen (gebündelt, wenn der Provider
   * getMessageTexts() kann – z. B. IMAP: ein FETCH für 50 Nachrichten).
   * Liefert true, wenn noch Nachrichten ohne Text übrig sind.
   */
  private async enrichBodies(acc: AccountRecord, mail: MailProvider, folderIds: string[], batches: number): Promise<boolean> {
    if (!config.search.indexBodies) return false;
    const client = this.getClient()!;
    let done = 0;
    for (const folderId of folderIds) {
      while (done < batches) {
        const res = await client.fetchDocuments<Pick<MessageDoc, 'id' | 'messageId' | 'size'>>(INDEX_UID, {
          filter: `accountId = ${q(acc.id)} AND folderId = ${q(folderId)} AND hasBody = false`,
          fields: ['id', 'messageId', 'size'],
          limit: 50,
        });
        if (!res.results.length) break;
        done++;
        const docs = res.results;
        const small = docs.filter((d) => (d.size ?? 0) < MAX_MESSAGE_SIZE_FOR_BODY);
        const texts = new Map<string, { text: string; attachments: string[]; encrypted?: boolean }>();
        try {
          if (mail.getMessageTexts) {
            for (const [k, v] of await mail.getMessageTexts(folderId, small.map((d) => d.messageId))) texts.set(k, v);
          } else {
            await mapLimit(small, BODY_CONCURRENCY, async (d) => {
              try {
                const detail = await mail.getMessage(folderId, d.messageId);
                const encrypted = looksLikeSmime(detail) === 'encrypted';
                texts.set(d.messageId, {
                  // Verschlüsselte Inhalte nicht im Klartext ablegen
                  text: encrypted ? '' : detail.text || (detail.html ? htmlToText(detail.html) : ''),
                  attachments: detail.attachments.filter((a) => !a.inline && !/smime\.p7[ms]$/i.test(a.filename)).map((a) => a.filename),
                  encrypted,
                });
              } catch (err) {
                this.log.debug({ err, messageId: d.messageId }, 'Suchindex: Text nicht ladbar');
              }
            });
          }
        } catch (err) {
          this.log.debug({ err, folderId }, 'Suchindex: Texte nicht ladbar – nur Kopfdaten');
        }
        // Nach dem Verwerfen nichts mehr schreiben: ein Teil-Update legte gelöschte Dokumente als Rümpfe neu an
        if (this.aborted(acc.id)) return false;
        // Auch bei Fehlern hasBody=true setzen, damit nichts endlos erneut versucht wird
        const updates = docs.map((d) => {
          const t = texts.get(d.messageId);
          const body = t?.text ? t.text.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS) : undefined;
          return {
            id: d.id,
            hasBody: true,
            ...(body ? { body } : {}),
            ...(t?.attachments.length ? { attachments: t.attachments, hasAttachments: true } : {}),
          };
        });
        const task = await client.updateDocuments(INDEX_UID, updates);
        // Warten, damit die nächste Abfrage "hasBody = false" diese Nachrichten nicht erneut liefert
        await client.waitTask(task.taskUid, 120_000);
      }
      if (done >= batches) return true;
    }
    return false;
  }

  /* ═════════════════════════════ Änderungen durch Kuvert ═════════════════════════════ */

  private async onMutation(m: MailMutation) {
    if (!this.available) return;
    const client = this.getClient()!;
    if (m.action === 'flags') {
      const existing = await this.fetchExisting(m.accountId, m.folderId, m.ids);
      const updates = m.ids
        .filter((id) => existing.has(id))
        .map((id) => ({
          id: docId(m.accountId, m.folderId, id),
          ...(m.flags?.seen !== undefined ? { seen: m.flags.seen } : {}),
          ...(m.flags?.flagged !== undefined ? { flagged: m.flags.flagged } : {}),
        }));
      if (updates.length) await client.updateDocuments(INDEX_UID, updates);
      return;
    }
    // Verschieben/Löschen: alte Einträge entfernen, Zielordner beim nächsten Lauf nachziehen
    await client.deleteIds(INDEX_UID, m.ids.map((id) => docId(m.accountId, m.folderId, id)));
    if (m.action === 'move') this.requestHeadSync(m.accountId);
  }

  /* ═════════════════════════════ Suche ═════════════════════════════ */

  async readyAccounts(userId: string): Promise<Set<string>> {
    const ready = new Set<string>();
    if (!this.available) return ready;
    for (const acc of this.ctx.accounts.list(userId)) {
      if (!acc.enabled || acc.settings.searchIndex === false) continue;
      if (this.load(acc.id).ready) ready.add(acc.id);
    }
    return ready;
  }

  async search(
    userId: string,
    opts: { q: string; accountIds: string[]; folderId?: string; limit: number; offset: number },
  ): Promise<{ items: MessageSummary[]; total: number; processingTimeMs: number }> {
    const client = this.getClient();
    if (!client || !opts.accountIds.length) return { items: [], total: 0, processingTimeMs: 0 };
    const parsed = parseQuery(opts.q);
    const filters = [`userId = ${q(userId)}`, `accountId IN [${opts.accountIds.map(q).join(', ')}]`, ...parsed.filters];
    if (opts.folderId) filters.push(`folderId = ${q(opts.folderId)}`);
    const res = await client.search<MessageDoc>(INDEX_UID, {
      q: parsed.text,
      filter: filters.join(' AND '),
      sort: ['date:desc'],
      limit: opts.limit,
      offset: opts.offset,
      attributesToRetrieve: RETRIEVE,
      attributesToHighlight: ['subject', 'body', 'preview'],
      attributesToCrop: ['body', 'preview'],
      cropLength: 28,
      cropMarker: '…',
      highlightPreTag: HIGHLIGHT_START,
      highlightPostTag: HIGHLIGHT_END,
      matchingStrategy: 'all',
    });
    const items = res.hits.map((h): MessageSummary => {
      const f = (h._formatted ?? {}) as Partial<Record<string, unknown>>;
      const has = (v: unknown): v is string => typeof v === 'string' && v.includes(HIGHLIGHT_START);
      const snippet = has(f.body) ? f.body : has(f.preview) ? f.preview : undefined;
      return {
        id: h.messageId,
        accountId: h.accountId,
        folderId: h.folderId,
        threadId: h.threadId,
        subject: h.subject,
        from: h.fromObj,
        to: h.toObj ?? [],
        cc: h.ccObj,
        date: h.dateIso,
        preview: h.preview,
        seen: h.seen,
        flagged: h.flagged,
        answered: h.answered,
        hasAttachments: h.hasAttachments,
        importance: h.importance as MessageSummary['importance'],
        size: h.size,
        highlight: has(f.subject) || snippet ? { subject: has(f.subject) ? f.subject : undefined, snippet } : undefined,
      };
    });
    return { items, total: res.estimatedTotalHits ?? res.totalHits ?? items.length, processingTimeMs: res.processingTimeMs };
  }

  /* ═════════════════════════════ Status ═════════════════════════════ */

  async userStatus(userId: string): Promise<SearchAccountStatus[]> {
    const accs = this.ctx.accounts.list(userId).filter((a) => this.ctx.accounts.capabilities(a).includes('mail'));
    const counts = await this.documentCounts(accs.map((a) => a.id));
    const pending = await this.documentCounts(accs.map((a) => a.id), 'hasBody = false');
    return accs.map((a) => {
      const st = this.load(a.id);
      const folders = Object.values(st.folders);
      const excluded = a.settings.searchIndex === false;
      return {
        accountId: a.id,
        name: a.name,
        email: a.email,
        excluded,
        state: excluded || !a.enabled ? 'disabled' : st.error ? 'error' : st.ready ? (this.running.has(a.id) ? 'indexing' : 'ready') : folders.length || this.running.has(a.id) ? 'indexing' : 'pending',
        documents: counts.get(a.id) ?? 0,
        bodiesPending: pending.get(a.id) ?? 0,
        foldersDone: folders.filter((f) => f.done).length,
        foldersTotal: folders.length,
        currentFolder: this.currentFolder.get(a.id) ?? null,
        lastSyncAt: st.lastSyncAt ?? null,
        error: st.error ?? null,
      };
    });
  }

  /** Dokumente je Konto (über Facetten in einer Anfrage) */
  private async documentCounts(accountIds: string[], extraFilter?: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const client = this.getClient();
    if (!client || !this.available || !accountIds.length) return out;
    try {
      const res = await client.search<MessageDoc>(INDEX_UID, {
        q: '',
        filter: `accountId IN [${accountIds.map(q).join(', ')}]${extraFilter ? ` AND ${extraFilter}` : ''}`,
        limit: 0,
        facets: ['accountId'],
      });
      for (const [id, n] of Object.entries(res.facetDistribution?.accountId ?? {})) out.set(id, n);
    } catch {
      /* egal */
    }
    return out;
  }

  isRunning(): boolean {
    return this.running.size > 0;
  }

  accountStates(): AccountState[] {
    return this.eligible().map((a) => this.load(a.id));
  }
}

export { parseQuery };
