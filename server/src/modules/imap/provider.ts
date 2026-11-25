/**
 * MailProvider für IMAP (Lesen) + SMTP (Senden).
 * Ordner-ID = Postfachpfad, Nachrichten-ID = UID (als String).
 */
import crypto from 'node:crypto';
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type {
  FlagUpdate,
  FolderListResult,
  FolderRole,
  MailFolder,
  MailIdentity,
  MessageDetail,
  MessageListQuery,
  MessageSummary,
  Paged,
  ThreadQuery,
} from '@kuvert/shared';
import { AppError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { buildMime, parseRawMessage, type ParsedRaw } from '../../core/mime.js';
import type { AccountContext } from '../../core/module.js';
import type { BinaryContent, MailProvider, PollResult, RawSendEnvelope, ResolvedOutgoingMessage } from '../../core/providers.js';
import { imapOptions, smtpTransport, type ImapConfig, type ImapSecrets } from './config.js';
import { ImapConnection, ImapIdleWatcher } from './connection.js';
import {
  attachmentNames,
  LruCache,
  detectRole,
  findTextPart,
  hasAttachments,
  parseAliasList,
  previewFromPart,
  roleOrder,
  smimeOf,
  stripHeaders,
  toAddress,
  toAddressList,
  type TextPart,
} from './util.js';

const FOLDER_TTL = 5 * 60_000;

/** Unterhaltung (getThread): höchstens so viele Message-IDs je Suchrunde bzw. Treffer je Ordner */
const THREAD_MAX_IDS = 20;
const THREAD_MAX_PER_FOLDER = 100;

export class ImapMailProvider implements MailProvider {
  private conn: ImapConnection;
  private watchers = new Set<ImapIdleWatcher>();
  private transport: Transporter | null = null;
  private folderCache: { at: number; folders: MailFolder[]; delimiter: string } | null = null;
  private rawCache = new LruCache<Buffer>(15);
  private parsedCache = new LruCache<ParsedRaw>(10);

  constructor(private ctx: AccountContext) {
    this.conn = new ImapConnection(() => imapOptions(this.cfg, this.secrets), ctx.log);
  }

  private get cfg(): ImapConfig {
    return this.ctx.account.config as ImapConfig;
  }

  private get secrets(): ImapSecrets {
    return this.ctx.account.secrets as ImapSecrets;
  }

  private get accountId(): string {
    return this.ctx.account.id;
  }

  private smtp(): Transporter {
    if (!this.transport) this.transport = smtpTransport(this.cfg, this.secrets);
    return this.transport;
  }

  /* ───────────────────────────── Ordner ───────────────────────────── */

  private async loadFolders(force = false): Promise<{ folders: MailFolder[]; delimiter: string }> {
    if (!force && this.folderCache && Date.now() - this.folderCache.at < FOLDER_TTL) return this.folderCache;
    const list = await this.conn.run(async (c) => {
      try {
        return await c.list({ statusQuery: { messages: true, unseen: true } });
      } catch {
        // Manche Server mögen STATUS für einzelne Ordner nicht – dann ohne Zähler
        return c.list();
      }
    });
    let delimiter = '/';
    const folders: MailFolder[] = list
      .filter((l) => !l.flags.has('\\NonExistent'))
      .map((l) => {
        if (l.delimiter) delimiter = l.delimiter;
        const role = detectRole(l.path, l.name, l.specialUse);
        return {
          id: l.path,
          name: l.path.toUpperCase() === 'INBOX' ? 'Posteingang' : l.name,
          path: l.path,
          parentId: l.parentPath || null,
          role,
          unread: l.status?.unseen,
          total: l.status?.messages,
          selectable: !l.flags.has('\\Noselect'),
        } satisfies MailFolder;
      });
    // Pro Rolle nur einen Ordner als Spezialordner werten
    const seen = new Set<FolderRole>();
    for (const f of [...folders].sort((a, b) => (a.path ?? '').length - (b.path ?? '').length)) {
      if (f.role === 'other') continue;
      if (seen.has(f.role)) f.role = 'other';
      else seen.add(f.role);
    }
    folders.sort((a, b) => {
      const top = (f: MailFolder) => (f.parentId ? 10 : roleOrder(f.role));
      return top(a) - top(b) || (a.path ?? '').localeCompare(b.path ?? '', 'de');
    });
    this.folderCache = { at: Date.now(), folders, delimiter };
    return this.folderCache;
  }

  async listFolders(): Promise<FolderListResult> {
    const { folders } = await this.loadFolders(true);
    return {
      mailboxes: [{ id: 'primary', name: this.ctx.account.name, address: this.cfg.email, shared: false }],
      folders: folders.map((f) => ({ ...f, mailboxId: 'primary' })),
    };
  }

  async getSpecialFolderId(role: FolderRole): Promise<string | undefined> {
    const { folders } = await this.loadFolders();
    if (role === 'inbox') return folders.find((f) => f.role === 'inbox')?.id ?? 'INBOX';
    return folders.find((f) => f.role === role)?.id;
  }

  async createFolder(name: string, parentId?: string | null): Promise<{ id: string }> {
    const { delimiter } = await this.loadFolders();
    const clean = name.replaceAll(delimiter, '-').trim();
    if (!clean) throw new BadRequestError('Ordnername fehlt');
    const path = parentId ? `${parentId}${delimiter}${clean}` : clean;
    const res = await this.conn.run((c) => c.mailboxCreate(path));
    await this.conn.run((c) => c.mailboxSubscribe(res.path)).catch(() => undefined);
    this.folderCache = null;
    return { id: res.path };
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    const { delimiter } = await this.loadFolders();
    const idx = folderId.lastIndexOf(delimiter);
    const parent = idx >= 0 ? folderId.slice(0, idx + 1) : '';
    await this.conn.run((c) => c.mailboxRename(folderId, `${parent}${name.replaceAll(delimiter, '-').trim()}`));
    this.folderCache = null;
  }

  async deleteFolder(folderId: string): Promise<void> {
    if (folderId.toUpperCase() === 'INBOX') throw new BadRequestError('Der Posteingang kann nicht gelöscht werden');
    await this.conn.run((c) => c.mailboxDelete(folderId));
    this.folderCache = null;
  }

  /* ───────────────────────────── Listen ───────────────────────────── */

  private summary(m: FetchMessageObject, folderId: string, preview?: string): MessageSummary {
    const env = m.envelope ?? {};
    const envDate = env.date ? new Date(env.date) : undefined;
    const date = envDate && !Number.isNaN(envDate.getTime()) ? envDate : m.internalDate ? new Date(m.internalDate) : new Date(0);
    const flags = m.flags ?? new Set<string>();
    const headerText = m.headers?.toString('utf8').toLowerCase() ?? '';
    const importance = /importance:\s*high|x-priority:\s*[12]/.test(headerText)
      ? 'high'
      : /importance:\s*low|x-priority:\s*[45]/.test(headerText)
        ? 'low'
        : 'normal';
    return {
      id: String(m.uid),
      accountId: this.accountId,
      folderId,
      threadId: m.threadId,
      subject: env.subject ?? '',
      from: toAddress(env.from?.[0]),
      to: toAddressList(env.to),
      cc: toAddressList(env.cc),
      date: date.toISOString(),
      preview,
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: hasAttachments(m.bodyStructure),
      smime: smimeOf(m.bodyStructure),
      importance,
      size: m.size,
      messageIdHeader: env.messageId || undefined,
      inReplyTo: env.inReplyTo || undefined,
    };
  }

  /** Lädt für eine Seite Nachrichten die Vorschautexte (best effort). */
  private async loadPreviews(c: ImapFlow, msgs: FetchMessageObject[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const groups = new Map<string, { part: TextPart; uids: number[] }>();
    for (const m of msgs) {
      const part = findTextPart(m.bodyStructure);
      if (!part) continue;
      const key = `${part.key}|${part.encoding}|${part.charset}|${part.type}`;
      const g = groups.get(key) ?? { part, uids: [] };
      g.uids.push(m.uid);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      try {
        const rows = await c.fetchAll(g.uids.join(','), { uid: true, bodyParts: [{ key: g.part.key, maxLength: 2048 }] }, { uid: true });
        for (const r of rows) {
          const buf = r.bodyParts?.get(g.part.key) ?? r.bodyParts?.get(g.part.key.toLowerCase()) ?? r.bodyParts?.values().next().value;
          if (buf) out.set(r.uid, previewFromPart(buf, g.part));
        }
      } catch (err) {
        this.ctx.log.debug({ err }, 'Vorschau konnte nicht geladen werden');
      }
    }
    return out;
  }

  private buildSearch(query: Pick<MessageListQuery, 'search' | 'unreadOnly' | 'flaggedOnly'>): SearchObject {
    const q: SearchObject = {};
    if (query.unreadOnly) q.seen = false;
    if (query.flaggedOnly) q.flagged = true;
    const s = query.search?.trim();
    if (s) q.or = [{ subject: s }, { from: s }, { to: s }, { body: s }];
    if (!Object.keys(q).length) q.all = true;
    return q;
  }

  private async fetchPage(c: ImapFlow, folderId: string, uids: number[]): Promise<MessageSummary[]> {
    if (!uids.length) return [];
    const msgs = await c.fetchAll(
      uids.join(','),
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        size: true,
        internalDate: true,
        threadId: true,
        headers: ['importance', 'x-priority'],
      },
      { uid: true },
    );
    const previews = await this.loadPreviews(c, msgs);
    return msgs.sort((a, b) => b.uid - a.uid).map((m) => this.summary(m, folderId, previews.get(m.uid)));
  }

  async listMessages(query: MessageListQuery): Promise<Paged<MessageSummary>> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const offset = Math.max(0, Number(query.cursor ?? 0) || 0);
    return this.conn.withMailbox(query.folderId, async (c) => {
      const mailbox = c.mailbox;
      if (mailbox && mailbox.exists === 0) return { items: [], nextCursor: null };
      let uids: number[];
      const search = this.buildSearch(query);
      if (search.all && mailbox) {
        // Schnellweg: alle UIDs per SEARCH ALL
        uids = ((await c.search({ all: true }, { uid: true })) || []) as number[];
      } else {
        uids = ((await c.search(search, { uid: true })) || []) as number[];
      }
      uids.sort((a, b) => b - a);
      const page = uids.slice(offset, offset + limit);
      const items = await this.fetchPage(c, query.folderId, page);
      return { items, nextCursor: offset + limit < uids.length ? String(offset + limit) : null };
    });
  }

  /**
   * Kontoweite Live-Suche: alle auswählbaren Ordner inkl. Unterordnern – wie der
   * Suchindex ohne Postausgang, Papierkorb und Spam. Die Ordner laufen über die eine
   * IMAP-Verbindung ohnehin nacheinander.
   */
  async search(query: string, opts: { cursor?: string; limit: number }): Promise<Paged<MessageSummary>> {
    const { folders: all } = await this.loadFolders();
    const skip = new Set<FolderRole>(['outbox', 'trash', 'junk']);
    const folders = all.filter((f) => f.selectable !== false && !skip.has(f.role)).map((f) => f.id);
    if (!folders.length) folders.push((await this.getSpecialFolderId('inbox')) ?? 'INBOX');
    const results = await Promise.allSettled(folders.map((folderId) => this.listMessages({ folderId, search: query, limit: opts.limit })));
    const items = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, opts.limit);
    return { items, nextCursor: null };
  }

  /**
   * Unterhaltung ordnerübergreifend: sucht im aktuellen Ordner sowie in Posteingang,
   * Gesendet, Archiv und Papierkorb nach Nachrichten, deren Message-ID, In-Reply-To
   * oder References eine der bekannten IDs enthält. Eine zweite Runde nimmt die dabei
   * neu gefundenen IDs mit (z. B. Antworten auf die eigene Antwort).
   */
  async getThread(query: ThreadQuery): Promise<MessageSummary[]> {
    const ids = new Set((query.messageIds ?? []).map((id) => id.trim()).filter((id) => /^<[^<>\s]+>$/.test(id)));
    if (!ids.size) return [];
    const { folders } = await this.loadFolders();
    const roles: FolderRole[] = ['inbox', 'sent', 'archive', 'trash'];
    const candidates = [
      ...new Set([query.folderId, ...roles.map((r) => folders.find((f) => f.role === r && f.selectable !== false)?.id).filter((f): f is string => !!f)]),
    ];
    const found = new Map<string, MessageSummary>();
    const searched = new Set<string>();
    for (let round = 0; round < 2; round++) {
      const batch = [...ids].filter((id) => !searched.has(id)).slice(0, THREAD_MAX_IDS);
      if (!batch.length) break;
      batch.forEach((id) => searched.add(id));
      const search: SearchObject = {
        or: batch.flatMap((id): SearchObject[] => [{ header: { 'message-id': id } }, { header: { 'in-reply-to': id } }, { header: { references: id } }]),
      };
      for (const folderId of candidates) {
        try {
          const items = await this.conn.withMailbox(folderId, async (c) => {
            const uids = ((await c.search(search, { uid: true })) || []) as number[];
            const fresh = uids
              .filter((u) => !found.has(`${folderId}\n${u}`))
              .sort((a, b) => b - a)
              .slice(0, THREAD_MAX_PER_FOLDER);
            return this.fetchPage(c, folderId, fresh);
          });
          for (const m of items) {
            found.set(`${folderId}\n${m.id}`, m);
            if (m.messageIdHeader) ids.add(m.messageIdHeader);
          }
        } catch {
          // Ordner nicht erreichbar/auswählbar – die übrigen trotzdem liefern
        }
      }
    }
    return [...found.values()];
  }

  /* ───────────────────────────── Einzelne Nachricht ───────────────────────────── */

  private uid(messageId: string): number {
    const n = Number(messageId);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestError('Ungültige Nachrichten-ID');
    return n;
  }

  async getRawMessage(folderId: string, messageId: string): Promise<Buffer> {
    const key = `${folderId}\u0000${messageId}`;
    const cached = this.rawCache.get(key);
    if (cached) return cached;
    const uid = this.uid(messageId);
    const raw = await this.conn.withMailbox(folderId, async (c) => {
      const msg = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return msg && msg.source ? msg.source : undefined;
    });
    if (!raw) throw new NotFoundError('Nachricht');
    if (raw.length < 25 * 1024 * 1024) this.rawCache.set(key, raw);
    return raw;
  }

  private async parsed(folderId: string, messageId: string): Promise<ParsedRaw> {
    const key = `${folderId}\u0000${messageId}`;
    const cached = this.parsedCache.get(key);
    if (cached) return cached;
    const p = await parseRawMessage(await this.getRawMessage(folderId, messageId));
    this.parsedCache.set(key, p);
    return p;
  }

  async getMessage(folderId: string, messageId: string): Promise<MessageDetail> {
    const uid = this.uid(messageId);
    const [parsed, meta] = await Promise.all([
      this.parsed(folderId, messageId),
      this.conn.withMailbox(folderId, (c) => c.fetchOne(String(uid), { uid: true, flags: true, size: true, threadId: true }, { uid: true })),
    ]);
    if (!meta) throw new NotFoundError('Nachricht');
    const flags = meta.flags ?? new Set<string>();
    return {
      ...parsed.detail,
      id: messageId,
      accountId: this.accountId,
      folderId,
      threadId: meta.threadId,
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      size: meta.size,
    };
  }

  /**
   * Suchindex: Texte vieler Nachrichten in EINEM FETCH. Pro Nachricht nur die ersten
   * 300 KB der Quelle (Text steht vorne, große Anhänge werden nicht übertragen);
   * Anhangnamen kommen aus der MIME-Struktur.
   */
  async getMessageTexts(folderId: string, messageIds: string[]): Promise<Map<string, { text: string; attachments: string[]; encrypted?: boolean }>> {
    const uids = messageIds.map((id) => this.uid(id));
    const out = new Map<string, { text: string; attachments: string[]; encrypted?: boolean }>();
    if (!uids.length) return out;
    const fetched = await this.conn.withMailbox(folderId, async (c) => {
      const list: { uid: number; source?: Buffer; structure?: FetchMessageObject['bodyStructure'] }[] = [];
      for await (const msg of c.fetch(uids.join(','), { uid: true, bodyStructure: true, source: { maxLength: 300_000 } }, { uid: true })) {
        list.push({ uid: msg.uid, source: msg.source, structure: msg.bodyStructure });
      }
      return list;
    });
    for (const m of fetched) {
      const type = (m.structure?.type ?? '').toLowerCase();
      const encrypted = type.includes('pkcs7-mime') && !(m.structure?.parameters?.['smime-type'] ?? '').includes('signed');
      let text = '';
      if (!encrypted && m.source) {
        try {
          const p = await parseRawMessage(m.source);
          text = p.detail.text ?? '';
        } catch {
          /* unvollständige/defekte Nachricht → nur Kopfdaten */
        }
      }
      out.set(String(m.uid), { text, attachments: attachmentNames(m.structure), encrypted });
    }
    return out;
  }

  async getAttachment(folderId: string, messageId: string, attachmentId: string): Promise<BinaryContent> {
    const parsed = await this.parsed(folderId, messageId);
    const att = parsed.attachments.find((a) => a.info.id === attachmentId);
    if (!att) throw new NotFoundError('Anhang');
    return { filename: att.info.filename, contentType: att.info.contentType, data: att.content };
  }

  /* ───────────────────────────── Senden ───────────────────────────── */

  private async appendToSent(raw: Buffer) {
    if (!this.cfg.appendSent) return;
    try {
      const sent = await this.getSpecialFolderId('sent');
      if (!sent) {
        this.ctx.log.warn('Kein Gesendet-Ordner gefunden – Nachricht wird nicht abgelegt');
        return;
      }
      await this.conn.run((c) => c.append(sent, raw, ['\\Seen']));
    } catch (err) {
      this.ctx.log.warn({ err }, 'Ablage im Gesendet-Ordner fehlgeschlagen');
    }
  }

  private async markAnswered(message: ResolvedOutgoingMessage) {
    const ref = message.reference;
    if (!ref || ref.type === 'forward') return;
    try {
      await this.conn.withMailbox(ref.folderId, (c) => c.messageFlagsAdd(String(this.uid(ref.messageId)), ['\\Answered'], { uid: true }));
    } catch (err) {
      this.ctx.log.debug({ err }, '\\Answered konnte nicht gesetzt werden');
    }
  }

  private async smtpSend(raw: Buffer, envelope: { from: string; to: string[] }) {
    if (!envelope.to.length) throw new BadRequestError('Keine Empfänger angegeben');
    try {
      await this.smtp().sendMail({ envelope, raw: stripHeaders(raw, ['bcc']) });
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
      this.transport?.close();
      this.transport = null;
      if (e.code === 'EAUTH' || e.responseCode === 535) throw new AppError(502, 'smtp_auth', 'SMTP-Anmeldung fehlgeschlagen – bitte Zugangsdaten prüfen');
      throw new AppError(502, 'smtp_error', `Versand fehlgeschlagen: ${e.response ?? e.message ?? String(err)}`);
    }
  }

  async send(message: ResolvedOutgoingMessage): Promise<void> {
    const raw = await buildMime(message);
    const to = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);
    await this.smtpSend(raw, { from: message.from.address, to });
    await this.appendToSent(raw);
    await this.markAnswered(message);
  }

  async sendRaw(raw: Buffer, envelope: RawSendEnvelope): Promise<void> {
    await this.smtpSend(raw, { from: envelope.from, to: envelope.to });
    await this.appendToSent(raw);
  }

  async saveDraft(
    message: ResolvedOutgoingMessage,
    existing?: { folderId: string; messageId: string },
  ): Promise<{ folderId: string; messageId: string }> {
    const drafts = await this.getSpecialFolderId('drafts');
    if (!drafts) throw new BadRequestError('Kein Entwürfe-Ordner gefunden');
    const messageId = `<${crypto.randomUUID()}@kuvert.draft>`;
    const raw = await buildMime(message, { messageId });
    const res = await this.conn.run((c) => c.append(drafts, raw, ['\\Draft', '\\Seen']));
    let uid = res ? res.uid : undefined;
    if (!uid) {
      // Server ohne UIDPLUS: über die Message-ID suchen
      const found = await this.conn.withMailbox(drafts, (c) => c.search({ header: { 'message-id': messageId } }, { uid: true }));
      uid = Array.isArray(found) && found.length ? Math.max(...found) : undefined;
    }
    if (existing?.messageId) {
      await this.delete(existing.folderId, [existing.messageId], true).catch((err) =>
        this.ctx.log.debug({ err }, 'Alter Entwurf konnte nicht gelöscht werden'),
      );
    }
    if (!uid) throw new AppError(502, 'draft_failed', 'Entwurf gespeichert, aber nicht wiedergefunden');
    return { folderId: drafts, messageId: String(uid) };
  }

  /* ───────────────────────────── Aktionen ───────────────────────────── */

  private range(ids: string[]): string {
    return ids.map((id) => this.uid(id)).join(',');
  }

  private invalidateMessages(folderId: string, ids?: string[]) {
    const pred = (k: string) => k.startsWith(`${folderId}\u0000`) && (!ids || ids.includes(k.split('\u0000')[1]!));
    this.rawCache.deleteWhere(pred);
    this.parsedCache.deleteWhere(pred);
  }

  async updateFlags(folderId: string, messageIds: string[], flags: FlagUpdate): Promise<void> {
    if (!messageIds.length) return;
    const range = this.range(messageIds);
    await this.conn.withMailbox(folderId, async (c) => {
      if (flags.seen === true) await c.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      if (flags.seen === false) await c.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      if (flags.flagged === true) await c.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
      if (flags.flagged === false) await c.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
    });
  }

  async move(folderId: string, messageIds: string[], targetFolderId: string): Promise<void> {
    if (!messageIds.length || folderId === targetFolderId) return;
    const range = this.range(messageIds);
    await this.conn.withMailbox(folderId, (c) => c.messageMove(range, targetFolderId, { uid: true }));
    this.invalidateMessages(folderId, messageIds);
  }

  async delete(folderId: string, messageIds: string[], permanent?: boolean): Promise<void> {
    if (!messageIds.length) return;
    const trash = await this.getSpecialFolderId('trash');
    const range = this.range(messageIds);
    if (permanent || !trash || trash === folderId) {
      await this.conn.withMailbox(folderId, (c) => c.messageDelete(range, { uid: true }));
    } else {
      await this.conn.withMailbox(folderId, (c) => c.messageMove(range, trash, { uid: true }));
    }
    this.invalidateMessages(folderId, messageIds);
  }

  /* ───────────────────────────── Identitäten ───────────────────────────── */

  async listIdentities(): Promise<MailIdentity[]> {
    const primary: MailIdentity = { id: 'primary', name: this.cfg.name, address: this.cfg.email };
    const aliases = parseAliasList(this.cfg.aliases).map<MailIdentity>((a, i) => ({
      id: `alias-${i}`,
      name: a.name ?? this.cfg.name,
      address: a.address,
    }));
    return [primary, ...aliases.filter((a) => a.address.toLowerCase() !== primary.address.toLowerCase())];
  }

  /* ───────────────────────────── Benachrichtigungen ───────────────────────────── */

  async pollInbox(state: string | undefined): Promise<PollResult> {
    const inbox = (await this.getSpecialFolderId('inbox')) ?? 'INBOX';
    const status = await this.conn.run((c) => c.status(inbox, { uidNext: true, uidValidity: true }));
    if (!status || !status.uidNext) return { state: state ?? '', newMessages: [] };
    const nextState = `${status.uidValidity ?? 0}:${status.uidNext}`;
    if (!state) return { state: nextState, newMessages: [] };
    const [oldValidity, oldNextStr] = state.split(':');
    const oldNext = Number(oldNextStr);
    if (oldValidity !== String(status.uidValidity ?? 0) || !Number.isFinite(oldNext) || status.uidNext <= oldNext) {
      return { state: nextState, newMessages: [] };
    }
    const newMessages = await this.conn.withMailbox(inbox, async (c) => {
      const uids = (((await c.search({ uid: `${oldNext}:*` }, { uid: true })) || []) as number[]).filter((u) => u >= oldNext);
      uids.sort((a, b) => b - a);
      const items = await this.fetchPage(c, inbox, uids.slice(0, 20));
      return items.filter((m) => !m.seen);
    });
    return { state: nextState, newMessages };
  }

  async watchInbox(onChange: () => void): Promise<() => void> {
    const inbox = (await this.getSpecialFolderId('inbox').catch(() => undefined)) ?? 'INBOX';
    const watcher = new ImapIdleWatcher(() => imapOptions(this.cfg, this.secrets), onChange, this.ctx.log, inbox);
    this.watchers.add(watcher);
    watcher.start();
    return () => {
      this.watchers.delete(watcher);
      void watcher.stop();
    };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.watchers].map((w) => w.stop()));
    this.watchers.clear();
    this.transport?.close();
    this.transport = null;
    this.rawCache.clear();
    this.parsedCache.clear();
    await this.conn.close();
  }
}
