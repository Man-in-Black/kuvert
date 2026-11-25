/**
 * Mail-Provider für Microsoft Graph inkl. freigegebener Postfächer.
 *
 * Ordner-IDs kodieren das Postfach: "me|<graphFolderId>" bzw. "<shared@firma.de>|<graphFolderId>".
 * Nachrichten-IDs sind unveränderliche Graph-IDs (Prefer: IdType="ImmutableId").
 */
import type {
  EmailAddress,
  EventResponse,
  FlagUpdate,
  FolderListResult,
  FolderRole,
  InviteInfo,
  MailFolder,
  MailIdentity,
  Mailbox,
  MessageDetail,
  MessageListQuery,
  MessageSummary,
  OutOfOfficeSettings,
  Paged,
  AttachmentInfo,
  SmimeKind,
  ThreadQuery,
} from '@kuvert/shared';
import { AppError, BadRequestError, NotSupportedError } from '../../core/errors.js';
import { apiFetch } from '../../core/http.js';
import { referencedCids } from '../../core/mime.js';
import type { AccountContext } from '../../core/module.js';
import type { BinaryContent, MailProvider, PollResult, RawSendEnvelope, ResolvedOutgoingMessage } from '../../core/providers.js';
import { decId, enc, encId, fromGraphDateTime, mapLimit, mbPath, qs, toGraphUtc, type GraphClient } from './graph.js';

/* ───────────────────────────── Graph-Typen (Ausschnitt) ───────────────────────────── */

interface GRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GMessage {
  '@odata.type'?: string;
  id: string;
  conversationId?: string;
  parentFolderId?: string;
  subject?: string | null;
  from?: GRecipient | null;
  sender?: GRecipient | null;
  toRecipients?: GRecipient[];
  ccRecipients?: GRecipient[];
  bccRecipients?: GRecipient[];
  replyTo?: GRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: 'notFlagged' | 'flagged' | 'complete' };
  hasAttachments?: boolean;
  importance?: 'low' | 'normal' | 'high';
  categories?: string[];
  body?: { contentType?: 'html' | 'text'; content?: string };
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  meetingMessageType?: string;
  event?: GEventLite;
  singleValueExtendedProperties?: { id: string; value: string }[];
}

interface GEventLite {
  id?: string;
  subject?: string;
  isOrganizer?: boolean;
  isCancelled?: boolean;
  responseRequested?: boolean;
  responseStatus?: { response?: 'none' | 'organizer' | 'tentativelyAccepted' | 'accepted' | 'declined' | 'notResponded' };
  iCalUId?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  organizer?: GRecipient;
}

interface GFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
}

interface GAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
  contentBytes?: string;
}

const LIST_SELECT =
  'id,conversationId,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,importance,categories';
const THREAD_SELECT = `${LIST_SELECT},internetMessageId,isDraft`;
const DETAIL_SELECT = `${LIST_SELECT},bccRecipients,replyTo,body,internetMessageId,internetMessageHeaders,sentDateTime,isDraft`;
const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount';
/** MAPI-Nachrichtenklasse (PidTagMessageClass): IPM.Note.SMIME.MultipartSigned = signiert, IPM.Note.SMIME = verschlüsselt/opak */
const MESSAGE_CLASS = 'String 0x001A';
const EXPAND_CLASS = `singleValueExtendedProperties($filter=id eq '${MESSAGE_CLASS}')`;

/** Besprechungsanfrage/-antwort/-absage (Graph-Typ eventMessage* oder MAPI-Klasse IPM.Schedule.Meeting.*) */
function isMeetingMessage(m: GMessage): boolean {
  if (m['@odata.type']?.startsWith('#microsoft.graph.eventMessage')) return true;
  const cls = m.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === MESSAGE_CLASS.toLowerCase())?.value?.toLowerCase() ?? '';
  return cls.startsWith('ipm.schedule.meeting');
}

function smimeOfClass(m: GMessage): SmimeKind | undefined {
  const cls = m.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === MESSAGE_CLASS.toLowerCase())?.value?.toLowerCase() ?? '';
  if (cls.startsWith('ipm.note.smime.multipartsigned')) return 'signed';
  if (cls.startsWith('ipm.note.smime')) return 'encrypted';
  return undefined;
}

/**
 * Ruft eine Liste mit Nachrichtenklasse ab; lehnt Graph das $expand ab (400), wird ohne
 * wiederholt – die Liste ist wichtiger als der S/MIME-Hinweis.
 */
async function withClass<T>(url: string, load: (u: string) => Promise<T>): Promise<T> {
  try {
    return await load(url);
  } catch (err) {
    const stripped = url.replace(/&(?:\$|%24)expand=[^&]*/i, '');
    if (err instanceof AppError && err.status === 400 && stripped !== url) return load(stripped);
    throw err;
  }
}

/**
 * Polling-Status: jüngste Empfangszeit (sekundengenau) und die IDs der Mails genau
 * dieser Sekunde. ids = null: älterer Status (nur Zeitstempel) – dann gelten alle Mails
 * dieser Sekunde als bereits gemeldet.
 */
interface MsPollState {
  t: string;
  ids: string[] | null;
}

function toSecondIso(v: string | undefined): string | null {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseMsPollState(state: string): MsPollState {
  if (state.startsWith('{')) {
    try {
      const s = JSON.parse(state) as { t?: string; ids?: unknown };
      const t = toSecondIso(s.t);
      if (t) return { t, ids: Array.isArray(s.ids) ? s.ids.filter((x): x is string => typeof x === 'string') : [] };
    } catch {
      /* unten neu beginnen */
    }
  }
  const t = toSecondIso(state);
  return t ? { t, ids: null } : { t: toSecondIso(new Date().toISOString())!, ids: [] };
}

/** items: absteigend nach receivedDateTime sortiert */
function msPollState(items: GMessage[], prev: MsPollState | null): string {
  const t = toSecondIso(items[0]?.receivedDateTime);
  if (!t || (prev && t < prev.t)) return JSON.stringify(prev ?? { t: toSecondIso(new Date().toISOString()), ids: [] });
  const ids = new Set(items.filter((m) => toSecondIso(m.receivedDateTime) === t).map((m) => m.id));
  if (prev?.ids && t === prev.t) for (const id of prev.ids) ids.add(id);
  return JSON.stringify({ t, ids: [...ids] });
}

/** Well-known-Ordnernamen von Graph → Rolle */
const WELL_KNOWN: [string, FolderRole][] = [
  ['inbox', 'inbox'],
  ['sentitems', 'sent'],
  ['drafts', 'drafts'],
  ['deleteditems', 'trash'],
  ['junkemail', 'junk'],
  ['archive', 'archive'],
  ['outbox', 'outbox'],
];
const ROLE_ORDER: Record<FolderRole, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5, outbox: 6, other: 9 };

/** Ab dieser Gesamtgröße (Base64-Overhead!) wird über Entwurf + Upload-Session gesendet */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const UPLOAD_CHUNK = 320 * 1024 * 10; // Vielfaches von 320 KiB, < 4 MB

/* ───────────────────────────── Mapping ───────────────────────────── */

function addr(r?: GRecipient | null): EmailAddress | undefined {
  const e = r?.emailAddress;
  if (!e || (!e.address && !e.name)) return undefined;
  return { name: e.name || undefined, address: e.address ?? '' };
}

function addrs(list?: GRecipient[] | null): EmailAddress[] {
  return (list ?? []).map(addr).filter((a): a is EmailAddress => !!a);
}

function recipient(a: EmailAddress): GRecipient {
  return { emailAddress: { address: a.address, name: a.name || undefined } };
}

export class GraphMailProvider implements MailProvider {
  private me: Promise<{ displayName?: string; mail?: string | null; userPrincipalName?: string }> | null = null;
  private roleCache = new Map<string, Promise<Map<FolderRole, string>>>();
  private sharedNames = new Map<string, Promise<string>>();

  constructor(
    private graph: GraphClient,
    private ctx: AccountContext,
  ) {}

  /* ───────────── interne Helfer ───────────── */

  private get accountId(): string {
    return this.ctx.account.id;
  }

  private sharedMailboxes(): string[] {
    const list = this.ctx.account.settings.sharedMailboxes;
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter((s) => s.includes('@')))];
  }

  private getMe() {
    if (!this.me) {
      this.me = this.graph.json('/me?$select=displayName,mail,userPrincipalName');
      this.me.catch(() => (this.me = null));
    }
    return this.me;
  }

  private sharedName(address: string): Promise<string> {
    let p = this.sharedNames.get(address);
    if (!p) {
      p = this.graph
        .json<{ displayName?: string }>(`/users/${enc(address)}?$select=displayName,mail`)
        .then((u) => u.displayName || address)
        .catch(() => address);
      this.sharedNames.set(address, p);
    }
    return p;
  }

  /** Rollen (inbox, sent …) → Graph-Ordner-ID je Postfach (gecacht) */
  private roles(mb: string): Promise<Map<FolderRole, string>> {
    let p = this.roleCache.get(mb);
    if (!p) {
      p = (async () => {
        const res = await this.graph.batch(
          WELL_KNOWN.map(([wk]) => ({ id: wk, method: 'GET' as const, url: `${mbPath(mb)}/mailFolders/${wk}?$select=id` })),
        );
        const map = new Map<FolderRole, string>();
        for (const r of res) {
          const role = WELL_KNOWN.find(([wk]) => wk === r.id)?.[1];
          if (role && r.status < 300 && r.body?.id) map.set(role, r.body.id as string);
        }
        if (!map.size) {
          const failed = res.find((r) => r.status >= 400);
          throw new AppError(
            failed?.status === 403 || failed?.status === 404 ? 403 : 502,
            'mailbox_access',
            `Kein Zugriff auf Postfach ${mb === 'me' ? '' : mb}: ${failed?.body?.error?.message ?? 'unbekannter Fehler'}`.trim(),
          );
        }
        return map;
      })();
      p.catch(() => this.roleCache.delete(mb));
      this.roleCache.set(mb, p);
    }
    return p;
  }

  private async roleOf(mb: string, graphFolderId: string): Promise<FolderRole> {
    const roles = await this.roles(mb).catch(() => new Map<FolderRole, string>());
    for (const [role, id] of roles) if (id === graphFolderId) return role;
    return 'other';
  }

  private summary(m: GMessage, folderId?: string, mb = 'me'): MessageSummary {
    return {
      id: m.id,
      accountId: this.accountId,
      folderId: folderId ?? encId(mb, m.parentFolderId ?? ''),
      threadId: m.conversationId,
      subject: m.subject ?? '',
      from: addr(m.from) ?? addr(m.sender),
      to: addrs(m.toRecipients),
      cc: addrs(m.ccRecipients),
      date: m.receivedDateTime ?? m.sentDateTime ?? new Date(0).toISOString(),
      preview: m.bodyPreview ?? '',
      seen: m.isRead ?? true,
      flagged: m.flag?.flagStatus === 'flagged',
      hasAttachments: !!m.hasAttachments,
      smime: smimeOfClass(m),
      importance: m.importance,
      categories: m.categories?.length ? m.categories : undefined,
    };
  }

  private buildMessage(msg: ResolvedOutgoingMessage, opts: { attachments: boolean; from?: EmailAddress }) {
    return {
      subject: msg.subject ?? '',
      body: { contentType: msg.html ? 'HTML' : 'Text', content: msg.html ?? msg.text ?? '' },
      toRecipients: msg.to.map(recipient),
      ccRecipients: msg.cc.map(recipient),
      bccRecipients: msg.bcc.map(recipient),
      replyTo: msg.replyTo.map(recipient),
      importance: msg.importance ?? 'normal',
      isReadReceiptRequested: !!msg.requestReadReceipt,
      ...(opts.from ? { from: recipient(opts.from) } : {}),
      ...(opts.attachments
        ? {
            attachments: msg.attachments.map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.filename,
              contentType: a.contentType,
              contentBytes: a.data.toString('base64'),
              isInline: !!a.inline,
              contentId: a.contentId,
            })),
          }
        : {}),
    };
  }

  /** Postfach, aus dem gesendet wird, und ggf. abweichender Absender */
  private sendContext(msg: ResolvedOutgoingMessage, draftMailbox?: string): { mb: string; from?: EmailAddress } {
    const identityMb = msg.identity?.mailboxId || 'me';
    const mb = draftMailbox ?? identityMb;
    const fromNeeded = msg.identity && (msg.identity.mailboxId || 'me') !== mb;
    const sharedSender = identityMb !== 'me';
    return { mb, from: fromNeeded || sharedSender ? { address: msg.from.address, name: msg.from.name } : undefined };
  }

  /** Anhänge zu einer Nachricht (Entwurf) hinzufügen – kleine direkt, große per Upload-Session */
  private async addAttachments(mb: string, messageId: string, attachments: ResolvedOutgoingMessage['attachments']) {
    const base = `${mbPath(mb)}/messages/${enc(messageId)}/attachments`;
    for (const a of attachments) {
      if (a.data.length < INLINE_ATTACHMENT_LIMIT) {
        await this.graph.json(base, {
          method: 'POST',
          body: {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.contentType,
            contentBytes: a.data.toString('base64'),
            isInline: !!a.inline,
            contentId: a.contentId,
          },
        });
        continue;
      }
      const session = await this.graph.json<{ uploadUrl: string }>(`${base}/createUploadSession`, {
        method: 'POST',
        body: {
          AttachmentItem: {
            attachmentType: 'file',
            name: a.filename,
            size: a.data.length,
            contentType: a.contentType,
            isInline: !!a.inline,
            contentId: a.contentId,
          },
        },
      });
      for (let start = 0; start < a.data.length; start += UPLOAD_CHUNK) {
        const end = Math.min(start + UPLOAD_CHUNK, a.data.length);
        await apiFetch(session.uploadUrl, {
          method: 'PUT',
          body: a.data.subarray(start, end),
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${a.data.length}` },
          noAuthError: true,
        });
      }
    }
  }

  private async deleteAllAttachments(mb: string, messageId: string, keepNames?: Set<string>): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      const existing = await this.graph.all<GAttachment>(`${mbPath(mb)}/messages/${enc(messageId)}/attachments?$select=id,name`);
      const toDelete = existing.filter((a) => !keepNames || !keepNames.has(a.name ?? ''));
      try {
        if (toDelete.length) {
          // Nacheinander: parallele Löschungen an derselben Nachricht scheitern am ChangeKey
          await this.graph.batchOrThrow(
            toDelete.map((a) => ({ method: 'DELETE' as const, url: `${mbPath(mb)}/messages/${enc(messageId)}/attachments/${enc(a.id)}` })),
            { sequential: true },
          );
        }
        return existing.filter((a) => !toDelete.includes(a)).map((a) => a.name ?? '');
      } catch (err) {
        // Exchange bearbeitet frisch erzeugte Antwort-Entwürfe noch im Hintergrund → kurz warten, neu einlesen
        if (!(err instanceof AppError && err.status === 409) || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  /** Erstellt einen Entwurf (Antwort/Weiterleitung über createReply…, sonst neu) ohne Anhänge. */
  private async createDraft(msg: ResolvedOutgoingMessage): Promise<{ mb: string; id: string; parentFolderId?: string }> {
    if (msg.reference) {
      const ref = decId(msg.reference.folderId);
      const action = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[msg.reference.type];
      const draft = await this.graph.json<GMessage>(`${mbPath(ref.mb)}/messages/${enc(msg.reference.messageId)}/${action}`, {
        method: 'POST',
        body: {},
      });
      // Vom Client gelieferte Anhänge sind maßgeblich → automatisch übernommene entfernen
      await this.deleteAllAttachments(ref.mb, draft.id);
      const { from } = this.sendContext(msg, ref.mb);
      await this.graph.json(`${mbPath(ref.mb)}/messages/${enc(draft.id)}`, {
        method: 'PATCH',
        body: this.buildMessage(msg, { attachments: false, from }),
      });
      return { mb: ref.mb, id: draft.id, parentFolderId: draft.parentFolderId };
    }
    const { mb, from } = this.sendContext(msg);
    const draft = await this.graph.json<GMessage>(`${mbPath(mb)}/messages`, {
      method: 'POST',
      body: this.buildMessage(msg, { attachments: false, from }),
    });
    return { mb, id: draft.id, parentFolderId: draft.parentFolderId };
  }

  /* ───────────── Ordner ───────────── */

  async listFolders(): Promise<FolderListResult> {
    const me = await this.getMe();
    const myAddress = me.mail || me.userPrincipalName || this.ctx.account.email;
    const shared = this.sharedMailboxes();
    const mailboxes: Mailbox[] = [
      { id: 'me', name: me.displayName || myAddress, address: myAddress, shared: false },
      ...(await Promise.all(shared.map(async (a) => ({ id: a, name: await this.sharedName(a), address: a, shared: true })))),
    ];

    const perMailbox = await Promise.all(
      mailboxes.map(async (box) => {
        try {
          return await this.foldersOf(box.id);
        } catch (err) {
          if (box.id === 'me') throw err;
          this.ctx.log.warn({ err, mailbox: box.id }, 'Freigegebenes Postfach nicht erreichbar');
          return null;
        }
      }),
    );
    return {
      mailboxes: mailboxes.filter((_, i) => perMailbox[i] !== null),
      folders: perMailbox.flatMap((f) => f ?? []),
    };
  }

  private async foldersOf(mb: string): Promise<MailFolder[]> {
    const roles = await this.roles(mb);
    const roleById = new Map([...roles].map(([role, id]) => [id, role]));
    const top = await this.graph.all<GFolder>(`${mbPath(mb)}/mailFolders?$top=250&$select=${FOLDER_SELECT}`);
    const all: { f: GFolder; path: string; parent: string | null }[] = top.map((f) => ({ f, path: f.displayName, parent: null }));

    let level = all.filter((x) => (x.f.childFolderCount ?? 0) > 0);
    for (let depth = 0; depth < 8 && level.length; depth++) {
      const children = await mapLimit(level, 6, async (p) => {
        const kids = await this.graph.all<GFolder>(`${mbPath(mb)}/mailFolders/${enc(p.f.id)}/childFolders?$top=250&$select=${FOLDER_SELECT}`);
        return kids.map((k) => ({ f: k, path: `${p.path}/${k.displayName}`, parent: p.f.id }));
      });
      const flat = children.flat();
      all.push(...flat);
      level = flat.filter((x) => (x.f.childFolderCount ?? 0) > 0);
    }

    return all
      .map<MailFolder>(({ f, path, parent }) => ({
        id: encId(mb, f.id),
        name: f.displayName,
        path,
        parentId: parent ? encId(mb, parent) : null,
        role: roleById.get(f.id) ?? 'other',
        unread: f.unreadItemCount ?? 0,
        total: f.totalItemCount ?? 0,
        mailboxId: mb,
        selectable: true,
      }))
      .sort((a, b) => {
        const ra = a.parentId ? 9 : ROLE_ORDER[a.role];
        const rb = b.parentId ? 9 : ROLE_ORDER[b.role];
        return ra - rb || (a.path ?? a.name).localeCompare(b.path ?? b.name, 'de');
      });
  }

  async getSpecialFolderId(role: FolderRole): Promise<string | undefined> {
    return this.getMailboxFolderId('me', role);
  }

  async getMailboxFolderId(mailboxId: string, role: FolderRole): Promise<string | undefined> {
    const mb = mailboxId === 'me' ? 'me' : mailboxId.trim().toLowerCase();
    if (mb !== 'me' && !this.sharedMailboxes().includes(mb)) return undefined;
    const id = (await this.roles(mb)).get(role);
    return id ? encId(mb, id) : undefined;
  }

  async createFolder(name: string, parentId?: string | null): Promise<{ id: string }> {
    if (parentId) {
      const p = decId(parentId);
      const f = await this.graph.json<GFolder>(`${mbPath(p.mb)}/mailFolders/${enc(p.id)}/childFolders`, {
        method: 'POST',
        body: { displayName: name },
      });
      return { id: encId(p.mb, f.id) };
    }
    const f = await this.graph.json<GFolder>('/me/mailFolders', { method: 'POST', body: { displayName: name } });
    return { id: encId('me', f.id) };
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    const f = decId(folderId);
    await this.graph.json(`${mbPath(f.mb)}/mailFolders/${enc(f.id)}`, { method: 'PATCH', body: { displayName: name } });
  }

  async deleteFolder(folderId: string): Promise<void> {
    const f = decId(folderId);
    await this.graph.raw(`${mbPath(f.mb)}/mailFolders/${enc(f.id)}`, { method: 'DELETE' });
  }

  /* ───────────── Listen & Suche ───────────── */

  async listMessages(q: MessageListQuery): Promise<Paged<MessageSummary>> {
    const f = decId(q.folderId);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    let url: string;
    if (q.cursor) {
      url = q.cursor;
    } else if (q.search) {
      url = `${mbPath(f.mb)}/mailFolders/${enc(f.id)}/messages${qs({
        $search: `"${q.search.replace(/"/g, '')}"`,
        $top: limit,
        $select: LIST_SELECT,
      })}`;
    } else {
      // Bei $filter + $orderby muss die Sortiereigenschaft zuerst im Filter stehen
      const filters = ['receivedDateTime ge 1900-01-01T00:00:00Z'];
      if (q.unreadOnly) filters.push('isRead eq false');
      if (q.flaggedOnly) filters.push("flag/flagStatus eq 'flagged'");
      url = `${mbPath(f.mb)}/mailFolders/${enc(f.id)}/messages${qs({
        $select: LIST_SELECT,
        $expand: EXPAND_CLASS,
        $orderby: 'receivedDateTime desc',
        $top: limit,
        $filter: filters.length > 1 ? filters.join(' and ') : undefined,
      })}`;
    }
    const page = await withClass(url, (u) => this.graph.page<GMessage>(u));
    let items = page.items.map((m) => this.summary(m, q.folderId, f.mb));
    if (q.search) {
      if (q.unreadOnly) items = items.filter((m) => !m.seen);
      if (q.flaggedOnly) items = items.filter((m) => m.flagged);
    }
    return { items, nextCursor: page.next ?? null };
  }

  async search(query: string, opts: { cursor?: string; limit: number }): Promise<Paged<MessageSummary>> {
    const url =
      opts.cursor ??
      `/me/messages${qs({ $search: `"${query.replace(/"/g, '')}"`, $top: Math.min(opts.limit, 250), $select: LIST_SELECT })}`;
    const page = await this.graph.page<GMessage>(url);
    return { items: page.items.map((m) => this.summary(m, undefined, 'me')), nextCursor: page.next ?? null };
  }

  /** Alle Nachrichten der Unterhaltung im Postfach (alle Ordner, ohne Entwürfe) */
  async getThread(query: ThreadQuery): Promise<MessageSummary[]> {
    const { mb } = decId(query.folderId);
    let conversationId = query.threadId;
    if (!conversationId) {
      const m = await this.graph.json<GMessage>(`${mbPath(mb)}/messages/${enc(query.messageId)}?$select=id,conversationId`);
      conversationId = m.conversationId;
    }
    if (!conversationId) return [];
    // Kein $orderby: Graph lehnt conversationId-Filter mit Sortierung oft als „InefficientFilter“ ab
    const items = await withClass(
      `${mbPath(mb)}/messages${qs({ $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $select: THREAD_SELECT, $expand: EXPAND_CLASS, $top: 100 })}`,
      (u) => this.graph.all<GMessage>(u, undefined, 250),
    );
    return items
      .filter((m) => !m.isDraft)
      .map((m) => ({ ...this.summary(m, undefined, mb), messageIdHeader: m.internetMessageId }));
  }

  /* ───────────── Einzelne Nachricht ───────────── */

  async getMessage(folderId: string, messageId: string): Promise<MessageDetail> {
    const { mb } = decId(folderId);
    const base = `${mbPath(mb)}/messages/${enc(messageId)}`;
    const [m, attList] = await Promise.all([
      this.graph.json<GMessage>(`${base}?$select=${DETAIL_SELECT}&$expand=${EXPAND_CLASS}`, { prefer: ['outlook.body-content-type="html"'] }),
      this.graph.all<GAttachment>(`${base}/attachments?$select=id,name,contentType,size,isInline`, undefined, 250),
    ]);

    const html = m.body?.contentType === 'html' ? m.body.content : undefined;
    const text = m.body?.contentType === 'text' ? m.body.content : undefined;

    // Content-IDs nur laden, wenn das HTML cid:-Referenzen enthält (spart Datenvolumen).
    // Nicht auf isInline verlassen: Exchange meldet für eingebettete Bilder oft isInline=false
    // (z. B. bei Mails, die per Graph oder aus anderen Programmen verschickt wurden).
    const cidMap = new Map<string, string>();
    const referenced = html ? referencedCids(html) : new Set<string>();
    if (referenced.size) {
      const isFile = (a: GAttachment) => !a['@odata.type'] || a['@odata.type'] === '#microsoft.graph.fileAttachment';
      const likely = (a: GAttachment) => (a.isInline ? 2 : 0) + (a.contentType?.toLowerCase().startsWith('image/') ? 1 : 0);
      const candidates = attList
        .filter(isFile)
        .sort((a, b) => likely(b) - likely(a))
        .slice(0, 40);
      await mapLimit(candidates, 5, async (a) => {
        const url = `${base}/attachments/${enc(a.id)}`;
        let full: GAttachment | undefined;
        try {
          full = await this.graph.json<GAttachment>(`${url}?$select=id,contentId`);
        } catch {
          // Manche Postfächer lehnen $select=contentId ab – dann die vollständige Anlage laden (nur kleine Bilder)
          if (likely(a) > 0 && (a.size ?? 0) < 5 * 1024 * 1024) full = await this.graph.json<GAttachment>(url).catch(() => undefined);
        }
        if (full?.contentId) cidMap.set(a.id, full.contentId.replace(/^<|>$/g, ''));
      });
    }

    const attachments: AttachmentInfo[] = attList.map((a) => {
      const isItem = a['@odata.type'] === '#microsoft.graph.itemAttachment';
      const contentId = cidMap.get(a.id);
      return {
        id: a.id,
        filename: isItem ? `${a.name || 'Nachricht'}.eml` : a.name || 'Anhang',
        contentType: isItem ? 'message/rfc822' : a.contentType || 'application/octet-stream',
        size: a.size ?? 0,
        inline: !!a.isInline || (!!contentId && referenced.has(contentId.toLowerCase())),
        contentId,
      };
    });

    const headers: Record<string, string> = {};
    for (const h of m.internetMessageHeaders ?? []) {
      const k = h.name.toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}, ${h.value}` : h.value;
    }

    const references = headers['references']?.split(/\s+/).filter(Boolean);
    let invite: InviteInfo | undefined;
    if (isMeetingMessage(m)) {
      invite = await this.loadInvite(base).catch(() => undefined);
    }

    return {
      ...this.summary(m, folderId, mb),
      bcc: addrs(m.bccRecipients),
      replyTo: addrs(m.replyTo),
      html,
      text,
      attachments,
      hasAttachments: attachments.some((a) => !a.inline),
      messageIdHeader: m.internetMessageId,
      inReplyTo: headers['in-reply-to'],
      references,
      headers,
      listUnsubscribe: headers['list-unsubscribe'],
      invite,
    };
  }

  private async loadInvite(base: string): Promise<InviteInfo | undefined> {
    // Kein $select: meetingMessageType gibt es nur am abgeleiteten Typ eventMessage –
    // ein $select darauf lehnt Graph am Basistyp message ab.
    const em = await this.graph.json<GMessage>(`${base}?$expand=microsoft.graph.eventMessage/event`, {
      prefer: ['outlook.timezone="UTC"', 'outlook.body-content-type="text"'],
    });
    const ev = em.event;
    if (!ev) return undefined;
    const type = em.meetingMessageType ?? '';
    const method =
      type === 'meetingCancelled'
        ? 'CANCEL'
        : type.startsWith('meeting') && type !== 'meetingRequest'
          ? 'REPLY'
          : 'REQUEST';
    const r = ev.responseStatus?.response;
    const myResponse: InviteInfo['myResponse'] =
      ev.isOrganizer || r === 'organizer'
        ? 'organizer'
        : r === 'accepted'
          ? 'accepted'
          : r === 'tentativelyAccepted'
            ? 'tentative'
            : r === 'declined'
              ? 'declined'
              : 'none';
    return {
      method,
      uid: ev.iCalUId,
      summary: ev.subject,
      start: ev.isAllDay ? ev.start?.dateTime?.slice(0, 10) : fromGraphDateTime(ev.start),
      end: ev.isAllDay ? ev.end?.dateTime?.slice(0, 10) : fromGraphDateTime(ev.end),
      location: ev.location?.displayName || undefined,
      organizer: addr(ev.organizer),
      myResponse,
      canRespond: method === 'REQUEST' && !!ev.id && myResponse !== 'organizer' && !ev.isCancelled,
    };
  }

  async respondToInvite(folderId: string, messageId: string, response: EventResponse, comment?: string): Promise<void> {
    const { mb } = decId(folderId);
    const em = await this.graph.json<GMessage>(`${mbPath(mb)}/messages/${enc(messageId)}?$expand=microsoft.graph.eventMessage/event`, {
      prefer: ['outlook.body-content-type="text"'],
    });
    const eventId = em.event?.id;
    if (!eventId) throw new BadRequestError('Zu dieser Einladung gibt es keinen Termin im Kalender (evtl. bereits gelöscht)');
    const action = { accept: 'accept', tentative: 'tentativelyAccept', decline: 'decline' }[response];
    await this.graph.raw(`${mbPath(mb)}/events/${enc(eventId)}/${action}`, {
      method: 'POST',
      body: { comment: comment ?? '', sendResponse: em.event?.responseRequested !== false },
    });
  }

  async getRawMessage(folderId: string, messageId: string): Promise<Buffer> {
    const { mb } = decId(folderId);
    const r = await this.graph.buffer(`${mbPath(mb)}/messages/${enc(messageId)}/$value`);
    return r.data;
  }

  async getAttachment(folderId: string, messageId: string, attachmentId: string): Promise<BinaryContent> {
    const { mb } = decId(folderId);
    const base = `${mbPath(mb)}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`;
    const full = await this.graph.json<GAttachment>(base);
    const type = full['@odata.type'];
    if (type === '#microsoft.graph.referenceAttachment') throw new NotSupportedError('Verknüpfte Cloud-Anhänge (Referenzanhänge)');
    if (type === '#microsoft.graph.itemAttachment' || full.contentBytes === undefined) {
      // Eingebettete Outlook-Elemente (Mails, Termine) als MIME exportieren
      const r = await this.graph.buffer(`${base}/$value`);
      return { filename: `${full.name || 'Nachricht'}.eml`, contentType: 'message/rfc822', data: r.data };
    }
    return {
      filename: full.name || 'Anhang',
      contentType: full.contentType || 'application/octet-stream',
      data: Buffer.from(full.contentBytes ?? '', 'base64'),
    };
  }

  /* ───────────── Senden & Entwürfe ───────────── */

  async send(msg: ResolvedOutgoingMessage): Promise<void> {
    const attachmentBytes = msg.attachments.reduce((s, a) => s + a.data.length, 0);
    if (!msg.reference && attachmentBytes * 1.37 < INLINE_ATTACHMENT_LIMIT) {
      const { mb, from } = this.sendContext(msg);
      await this.graph.raw(`${mbPath(mb)}/sendMail`, {
        method: 'POST',
        body: { message: this.buildMessage(msg, { attachments: true, from }), saveToSentItems: true },
      });
      return;
    }
    // Antworten/Weiterleitungen (Threading) und große Anhänge: Entwurf → Anhänge → Senden
    const draft = await this.createDraft(msg);
    try {
      await this.addAttachments(draft.mb, draft.id, msg.attachments);
      await this.graph.raw(`${mbPath(draft.mb)}/messages/${enc(draft.id)}/send`, { method: 'POST' });
    } catch (err) {
      await this.graph.raw(`${mbPath(draft.mb)}/messages/${enc(draft.id)}`, { method: 'DELETE' }).catch(() => undefined);
      throw err;
    }
  }

  async sendRaw(raw: Buffer, envelope: RawSendEnvelope): Promise<void> {
    const mb = envelope.identity?.mailboxId || 'me';
    if (raw.length * 1.37 > 4 * 1024 * 1024) {
      throw new BadRequestError('MIME-Nachricht zu groß für den Versand über Microsoft Graph (max. ca. 3 MB)');
    }
    await this.graph.raw(`${mbPath(mb)}/sendMail`, {
      method: 'POST',
      body: raw.toString('base64'),
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  async saveDraft(msg: ResolvedOutgoingMessage, existing?: { folderId: string; messageId: string }): Promise<{ folderId: string; messageId: string }> {
    if (existing) {
      const { mb } = decId(existing.folderId);
      const { from } = this.sendContext(msg, mb);
      await this.graph.json(`${mbPath(mb)}/messages/${enc(existing.messageId)}`, {
        method: 'PATCH',
        body: this.buildMessage(msg, { attachments: false, from }),
      });
      // Anhänge abgleichen (über den Dateinamen)
      const wanted = new Set(msg.attachments.map((a) => a.filename));
      const kept = new Set(await this.deleteAllAttachments(mb, existing.messageId, wanted));
      await this.addAttachments(
        mb,
        existing.messageId,
        msg.attachments.filter((a) => !kept.has(a.filename)),
      );
      return existing;
    }
    const draft = await this.createDraft(msg);
    await this.addAttachments(draft.mb, draft.id, msg.attachments);
    let parent = draft.parentFolderId;
    if (!parent) parent = (await this.roles(draft.mb)).get('drafts');
    return { folderId: encId(draft.mb, parent ?? 'drafts'), messageId: draft.id };
  }

  /* ───────────── Aktionen ───────────── */

  async updateFlags(folderId: string, messageIds: string[], flags: FlagUpdate): Promise<void> {
    const { mb } = decId(folderId);
    const body: Record<string, unknown> = {};
    if (flags.seen !== undefined) body.isRead = flags.seen;
    if (flags.flagged !== undefined) body.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' };
    if (!Object.keys(body).length) return;
    await this.graph.batchOrThrow(messageIds.map((id) => ({ method: 'PATCH' as const, url: `${mbPath(mb)}/messages/${enc(id)}`, body })));
  }

  async move(folderId: string, messageIds: string[], targetFolderId: string): Promise<void> {
    const src = decId(folderId);
    const dst = decId(targetFolderId);
    if (src.mb !== dst.mb) throw new AppError(400, 'cross_mailbox', 'Verschieben zwischen verschiedenen Postfächern wird nicht unterstützt');
    await this.graph.batchOrThrow(
      messageIds.map((id) => ({
        method: 'POST' as const,
        url: `${mbPath(src.mb)}/messages/${enc(id)}/move`,
        body: { destinationId: dst.id },
      })),
    );
  }

  async delete(folderId: string, messageIds: string[], permanent?: boolean): Promise<void> {
    const f = decId(folderId);
    const trash = (await this.roles(f.mb).catch(() => new Map<FolderRole, string>())).get('trash');
    if (permanent || (trash && trash === f.id)) {
      await this.graph.batchOrThrow(messageIds.map((id) => ({ method: 'DELETE' as const, url: `${mbPath(f.mb)}/messages/${enc(id)}` })));
      return;
    }
    await this.graph.batchOrThrow(
      messageIds.map((id) => ({
        method: 'POST' as const,
        url: `${mbPath(f.mb)}/messages/${enc(id)}/move`,
        body: { destinationId: 'deleteditems' },
      })),
    );
  }

  /* ───────────── Identitäten ───────────── */

  async listIdentities(): Promise<MailIdentity[]> {
    const me = await this.getMe();
    const address = me.mail || me.userPrincipalName || this.ctx.account.email;
    const out: MailIdentity[] = [{ id: 'me', name: me.displayName || undefined, address, mailboxId: 'me', shared: false }];
    for (const a of this.sharedMailboxes()) {
      out.push({ id: `shared:${a}`, name: await this.sharedName(a), address: a, mailboxId: a, shared: true });
    }
    return out;
  }

  /* ───────────── Benachrichtigungen (Polling) ───────────── */

  async pollInbox(state: string | undefined): Promise<PollResult> {
    const inbox = (await this.roles('me')).get('inbox');
    if (!inbox) return { state: state ?? new Date().toISOString(), newMessages: [] };
    const base = `/me/mailFolders/${enc(inbox)}/messages`;
    const folderId = encId('me', inbox);
    if (!state) {
      const first = await this.graph.page<GMessage>(`${base}${qs({ $select: 'id,receivedDateTime', $orderby: 'receivedDateTime desc', $top: 5 })}`);
      return { state: msPollState(first.items, null), newMessages: [] };
    }
    // Graph liefert receivedDateTime nur sekundengenau, vergleicht im Filter aber genauer.
    // Mit „gt <letzte Zeit>" käme die neueste Mail daher bei jedem Abruf erneut –
    // deshalb „ge" und die bereits gemeldeten IDs dieser Sekunde im Status mitführen.
    const prev = parseMsPollState(state);
    const page = await this.graph.page<GMessage>(
      `${base}${qs({ $select: LIST_SELECT, $filter: `receivedDateTime ge ${prev.t}`, $orderby: 'receivedDateTime desc', $top: 50 })}`,
    );
    const known = new Set(prev.ids ?? page.items.filter((m) => toSecondIso(m.receivedDateTime) === prev.t).map((m) => m.id));
    const newMessages = page.items
      .filter((m) => !known.has(m.id))
      .map((m) => this.summary(m, folderId, 'me'))
      .filter((m) => !m.seen);
    return { state: msPollState(page.items, prev), newMessages };
  }

  /* ───────────── Abwesenheitsnotiz ───────────── */

  async getOutOfOffice(): Promise<OutOfOfficeSettings> {
    const s = await this.graph.json<{
      status?: 'disabled' | 'alwaysEnabled' | 'scheduled';
      internalReplyMessage?: string;
      externalReplyMessage?: string;
      scheduledStartDateTime?: { dateTime?: string; timeZone?: string };
      scheduledEndDateTime?: { dateTime?: string; timeZone?: string };
    }>('/me/mailboxSettings/automaticRepliesSetting');
    const scheduled = s.status === 'scheduled';
    return {
      enabled: !!s.status && s.status !== 'disabled',
      internalReply: s.internalReplyMessage ?? '',
      externalReply: s.externalReplyMessage ?? '',
      start: scheduled ? fromGraphDateTime(s.scheduledStartDateTime) || null : null,
      end: scheduled ? fromGraphDateTime(s.scheduledEndDateTime) || null : null,
    };
  }

  async setOutOfOffice(settings: OutOfOfficeSettings): Promise<void> {
    const scheduled = !!(settings.enabled && settings.start && settings.end);
    await this.graph.json('/me/mailboxSettings', {
      method: 'PATCH',
      body: {
        automaticRepliesSetting: {
          status: settings.enabled ? (scheduled ? 'scheduled' : 'alwaysEnabled') : 'disabled',
          externalAudience: 'all',
          internalReplyMessage: settings.internalReply ?? '',
          externalReplyMessage: settings.externalReply ?? settings.internalReply ?? '',
          ...(scheduled
            ? { scheduledStartDateTime: toGraphUtc(settings.start!), scheduledEndDateTime: toGraphUtc(settings.end!) }
            : {}),
        },
      },
    });
  }

  async dispose(): Promise<void> {
    this.roleCache.clear();
    this.sharedNames.clear();
    this.me = null;
  }
}
