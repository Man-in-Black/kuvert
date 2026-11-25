/**
 * Gmail-Provider (Gmail REST API v1).
 * Ordner = Labels (Systemlabels + eigene Labels, verschachtelt über "/"),
 * zusätzlich der virtuelle Ordner "ALL" (Alle Nachrichten = Archiv).
 */
import addressparser from 'nodemailer/lib/addressparser';
import type {
  EmailAddress,
  FlagUpdate,
  FolderListResult,
  FolderRole,
  MailFolder,
  MailIdentity,
  MessageDetail,
  MessageListQuery,
  MessageSummary,
  OutOfOfficeSettings,
  Paged,
  ThreadQuery,
} from '@kuvert/shared';
import { BadRequestError, HttpError, NotFoundError } from '../../core/errors.js';
import { buildMime, parseRawMessage, smimeFromContentType } from '../../core/mime.js';
import type {
  BinaryContent,
  MailProvider,
  PollResult,
  RawSendEnvelope,
  ResolvedOutgoingMessage,
} from '../../core/providers.js';
import { ByteLru, decodeMimeWords, gurl, mapLimit, multipartRelated, type GoogleClient } from './client.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_BASE = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const ALL = 'ALL';
/** Ab dieser Größe wird über den Upload-Endpunkt gesendet */
const SIMPLE_LIMIT = 4 * 1024 * 1024;

interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
  labelListVisibility?: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: { mimeType?: string; headers?: GmailHeader[] };
}

/** Systemlabels, die als Ordner angezeigt werden (Reihenfolge = Anzeige) */
const SYSTEM_LABELS: { id: string; name: string; role: FolderRole }[] = [
  { id: 'INBOX', name: 'Posteingang', role: 'inbox' },
  { id: 'STARRED', name: 'Markiert', role: 'other' },
  { id: 'IMPORTANT', name: 'Wichtig', role: 'other' },
  { id: 'SENT', name: 'Gesendet', role: 'sent' },
  { id: 'DRAFT', name: 'Entwürfe', role: 'drafts' },
  { id: ALL, name: 'Alle Nachrichten', role: 'archive' },
  { id: 'SPAM', name: 'Spam', role: 'junk' },
  { id: 'TRASH', name: 'Papierkorb', role: 'trash' },
];

const ROLE_TO_LABEL: Partial<Record<FolderRole, string>> = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  junk: 'SPAM',
  archive: ALL,
};

function parseAddresses(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  try {
    return addressparser(decodeMimeWords(value), { flatten: true })
      .filter((a) => a.address)
      .map((a) => ({ name: a.name || undefined, address: a.address }));
  } catch {
    return [];
  }
}

function header(m: GmailMessage, name: string): string | undefined {
  const h = m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value;
}

/** Ordner einer Nachricht ableiten (für Suchergebnisse/Benachrichtigungen) */
const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Importance', 'X-Priority', 'Message-ID', 'In-Reply-To', 'Content-Type'];

/** Wie folderOf, aber eigene Antworten (nur SENT) als „Gesendet“ statt „Alle Nachrichten“ */
function threadFolderOf(labelIds: string[] | undefined): string {
  const l = labelIds ?? [];
  if (l.includes('SENT') && !l.includes('INBOX') && !l.includes('TRASH') && !l.includes('SPAM')) return 'SENT';
  return folderOf(l);
}

function folderOf(labelIds: string[] | undefined): string {
  const l = labelIds ?? [];
  if (l.includes('TRASH')) return 'TRASH';
  if (l.includes('SPAM')) return 'SPAM';
  if (l.includes('INBOX')) return 'INBOX';
  if (l.includes('DRAFT')) return 'DRAFT';
  return ALL;
}

export class GmailProvider implements MailProvider {
  private rawCache = new ByteLru<Buffer>(60 * 1024 * 1024, 30);

  constructor(private g: GoogleClient) {}

  /* ───────────── Ordner ───────────── */

  async listFolders(): Promise<FolderListResult> {
    const { labels = [] } = await this.g.json<{ labels?: GmailLabel[] }>(`${BASE}/labels`);
    const visibleSystem = SYSTEM_LABELS.filter((s) => s.id === ALL || labels.some((l) => l.id === s.id));
    const userLabels = labels.filter((l) => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name, 'de'));

    // Zähler je Label (labels.list liefert keine Zahlen)
    const countIds = [...visibleSystem.filter((s) => s.id !== ALL).map((s) => s.id), ...userLabels.map((l) => l.id)];
    const counts = new Map<string, GmailLabel>();
    await mapLimit(countIds, 10, async (id) => {
      try {
        counts.set(id, await this.g.json<GmailLabel>(`${BASE}/labels/${encodeURIComponent(id)}`));
      } catch {
        /* Zähler optional */
      }
    });

    const folders: MailFolder[] = visibleSystem.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.name,
      parentId: null,
      role: s.role,
      unread: s.id === 'SENT' || s.id === 'DRAFT' ? undefined : counts.get(s.id)?.messagesUnread,
      total: counts.get(s.id)?.messagesTotal,
      mailboxId: 'primary',
      selectable: true,
    }));

    const byName = new Map(userLabels.map((l) => [l.name, l]));
    for (const l of userLabels) {
      const segments = l.name.split('/');
      const parentName = segments.slice(0, -1).join('/');
      folders.push({
        id: l.id,
        name: segments[segments.length - 1] || l.name,
        path: l.name,
        parentId: parentName ? (byName.get(parentName)?.id ?? null) : null,
        role: 'other',
        unread: counts.get(l.id)?.messagesUnread,
        total: counts.get(l.id)?.messagesTotal,
        mailboxId: 'primary',
        selectable: true,
      });
    }

    return {
      mailboxes: [{ id: 'primary', name: this.g.ctx.account.name, address: this.g.email, shared: false }],
      folders,
    };
  }

  async getSpecialFolderId(role: FolderRole): Promise<string | undefined> {
    return ROLE_TO_LABEL[role];
  }

  async createFolder(name: string, parentId?: string | null): Promise<{ id: string }> {
    let fullName = name.trim();
    if (parentId && !SYSTEM_LABELS.some((s) => s.id === parentId)) {
      const parent = await this.g.json<GmailLabel>(`${BASE}/labels/${encodeURIComponent(parentId)}`);
      fullName = `${parent.name}/${fullName}`;
    }
    const created = await this.g.json<GmailLabel>(`${BASE}/labels`, {
      method: 'POST',
      body: { name: fullName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return { id: created.id };
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    if (SYSTEM_LABELS.some((s) => s.id === folderId)) throw new BadRequestError('Systemordner können nicht umbenannt werden');
    const { labels = [] } = await this.g.json<{ labels?: GmailLabel[] }>(`${BASE}/labels`);
    const label = labels.find((l) => l.id === folderId);
    if (!label) throw new NotFoundError('Label');
    const segments = label.name.split('/');
    segments[segments.length - 1] = name.trim();
    const newName = segments.join('/');
    await this.g.json(`${BASE}/labels/${encodeURIComponent(folderId)}`, { method: 'PATCH', body: { name: newName } });
    // Unterlabels mitziehen (Gmail verschachtelt nur über den Namen)
    for (const child of labels.filter((l) => l.type === 'user' && l.name.startsWith(`${label.name}/`))) {
      await this.g.json(`${BASE}/labels/${encodeURIComponent(child.id)}`, {
        method: 'PATCH',
        body: { name: newName + child.name.slice(label.name.length) },
      });
    }
  }

  async deleteFolder(folderId: string): Promise<void> {
    if (SYSTEM_LABELS.some((s) => s.id === folderId)) throw new BadRequestError('Systemordner können nicht gelöscht werden');
    await this.g.fetch(`${BASE}/labels/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
  }

  /* ───────────── Listen ───────────── */

  private async fetchSummaries(ids: string[], folderId?: string): Promise<MessageSummary[]> {
    const metas = await mapLimit(ids, 10, async (id) => {
      try {
        return await this.g.json<GmailMessage>(
          gurl(`${BASE}/messages/${encodeURIComponent(id)}`, {
            format: 'metadata',
            metadataHeaders: META_HEADERS,
          }),
        );
      } catch {
        return null; // z. B. zwischenzeitlich gelöscht
      }
    });
    return metas.filter((m): m is GmailMessage => !!m).map((m) => this.toSummary(m, folderId));
  }

  private toSummary(m: GmailMessage, folderId?: string): MessageSummary {
    const labels = m.labelIds ?? [];
    const dateMs = Number(m.internalDate);
    const date = Number.isFinite(dateMs) && dateMs > 0 ? new Date(dateMs) : new Date(header(m, 'Date') ?? Date.now());
    const imp = (header(m, 'Importance') ?? '').toLowerCase();
    const xp = (header(m, 'X-Priority') ?? '').trim();
    const mime = (m.payload?.mimeType ?? '').toLowerCase();
    return {
      id: m.id,
      accountId: this.g.accountId,
      folderId: folderId ?? folderOf(labels),
      threadId: m.threadId,
      subject: decodeMimeWords(header(m, 'Subject')) || '',
      from: parseAddresses(header(m, 'From'))[0],
      to: parseAddresses(header(m, 'To')),
      cc: parseAddresses(header(m, 'Cc')),
      date: date.toISOString(),
      preview: decodeHtmlEntities(m.snippet ?? ''),
      seen: !labels.includes('UNREAD'),
      flagged: labels.includes('STARRED'),
      hasAttachments: mime === 'multipart/mixed',
      smime: smimeFromContentType(header(m, 'Content-Type') ?? mime),
      importance: imp === 'high' || xp.startsWith('1') || xp.startsWith('2') ? 'high' : imp === 'low' || xp.startsWith('5') ? 'low' : 'normal',
      categories: labels.filter((l) => l.startsWith('Label_')),
      size: m.sizeEstimate,
      messageIdHeader: header(m, 'Message-ID')?.trim() || undefined,
      inReplyTo: header(m, 'In-Reply-To')?.trim().split(/\s+/)[0] || undefined,
    };
  }

  /** Alle Nachrichten des Gmail-Threads (inkl. Gesendet/Papierkorb, ohne Entwürfe) */
  async getThread(query: ThreadQuery): Promise<MessageSummary[]> {
    const threadId = query.threadId ?? (await this.threadIdOf(query.messageId));
    if (!threadId) return [];
    const t = await this.g.json<{ messages?: GmailMessage[] }>(
      gurl(`${BASE}/threads/${encodeURIComponent(threadId)}`, { format: 'metadata', metadataHeaders: META_HEADERS }),
    );
    return (t.messages ?? []).filter((m) => !(m.labelIds ?? []).includes('DRAFT')).map((m) => this.toSummary(m, threadFolderOf(m.labelIds)));
  }

  private async listIds(p: { labelId?: string; q?: string; pageToken?: string; limit: number }) {
    const includeSpamTrash = p.labelId === 'TRASH' || p.labelId === 'SPAM';
    return this.g.json<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
      gurl(`${BASE}/messages`, {
        maxResults: p.limit,
        pageToken: p.pageToken,
        labelIds: p.labelId ? [p.labelId] : undefined,
        q: p.q,
        includeSpamTrash: includeSpamTrash || undefined,
      }),
    );
  }

  async listMessages(query: MessageListQuery): Promise<Paged<MessageSummary>> {
    const q = [query.search, query.unreadOnly ? 'is:unread' : '', query.flaggedOnly ? 'is:starred' : ''].filter(Boolean).join(' ');
    const res = await this.listIds({
      labelId: query.folderId === ALL ? undefined : query.folderId,
      q: q || undefined,
      pageToken: query.cursor,
      limit: Math.min(query.limit ?? 50, 500),
    });
    const items = await this.fetchSummaries((res.messages ?? []).map((m) => m.id), query.folderId);
    return { items, nextCursor: res.nextPageToken ?? null };
  }

  async search(query: string, opts: { cursor?: string; limit: number }): Promise<Paged<MessageSummary>> {
    const res = await this.listIds({ q: query, pageToken: opts.cursor, limit: Math.min(opts.limit, 500) });
    const items = await this.fetchSummaries((res.messages ?? []).map((m) => m.id));
    return { items, nextCursor: res.nextPageToken ?? null };
  }

  /* ───────────── Einzelne Nachricht ───────────── */

  private async fetchRaw(messageId: string): Promise<GmailMessage & { buffer: Buffer }> {
    const m = await this.g.json<GmailMessage>(gurl(`${BASE}/messages/${encodeURIComponent(messageId)}`, { format: 'raw' }));
    const buffer = Buffer.from(m.raw ?? '', 'base64url');
    this.rawCache.set(messageId, buffer);
    return { ...m, buffer };
  }

  async getMessage(folderId: string, messageId: string): Promise<MessageDetail> {
    const m = await this.fetchRaw(messageId);
    const parsed = await parseRawMessage(m.buffer);
    const labels = m.labelIds ?? [];
    const dateMs = Number(m.internalDate);
    return {
      ...parsed.detail,
      id: m.id,
      accountId: this.g.accountId,
      folderId,
      threadId: m.threadId,
      date: parsed.detail.headers?.date ? parsed.detail.date : Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : parsed.detail.date,
      seen: !labels.includes('UNREAD'),
      flagged: labels.includes('STARRED'),
      size: m.sizeEstimate,
    };
  }

  async getRawMessage(_folderId: string, messageId: string): Promise<Buffer> {
    return this.rawCache.get(messageId) ?? (await this.fetchRaw(messageId)).buffer;
  }

  async getAttachment(folderId: string, messageId: string, attachmentId: string): Promise<BinaryContent> {
    const raw = await this.getRawMessage(folderId, messageId);
    const parsed = await parseRawMessage(raw);
    const att = parsed.attachments.find((a) => a.info.id === attachmentId);
    if (!att) throw new NotFoundError('Anhang');
    return { filename: att.info.filename, contentType: att.info.contentType, data: att.content };
  }

  /* ───────────── Senden & Entwürfe ───────────── */

  private async threadIdOf(messageId: string): Promise<string | undefined> {
    try {
      const m = await this.g.json<GmailMessage>(gurl(`${BASE}/messages/${encodeURIComponent(messageId)}`, { format: 'minimal' }));
      return m.threadId;
    } catch {
      return undefined;
    }
  }

  /** Sendet bzw. speichert eine Rohnachricht – große Nachrichten über den Upload-Endpunkt. */
  private async postRaw(path: 'messages/send' | 'drafts', raw: Buffer, extra: { threadId?: string }, method: 'POST' | 'PUT' = 'POST', draftId?: string) {
    const target = draftId ? `drafts/${encodeURIComponent(draftId)}` : path;
    const wrap = (message: Record<string, unknown>) => (path === 'drafts' ? { id: draftId, message } : message);
    if (raw.length < SIMPLE_LIMIT) {
      return this.g.json<any>(`${BASE}/${target}`, { method, body: wrap({ raw: raw.toString('base64url'), ...extra }) });
    }
    const mp = multipartRelated(wrap({ ...extra }), raw, 'message/rfc822');
    return this.g.json<any>(gurl(`${UPLOAD_BASE}/${target}`, { uploadType: 'multipart' }), {
      method,
      body: mp.body,
      headers: { 'Content-Type': mp.contentType },
      timeoutMs: 300_000,
    });
  }

  async send(message: ResolvedOutgoingMessage): Promise<void> {
    const raw = await buildMime(message);
    const threadId = message.reference ? await this.threadIdOf(message.reference.messageId) : undefined;
    await this.postRaw('messages/send', raw, { threadId });
  }

  async sendRaw(raw: Buffer, _envelope: RawSendEnvelope): Promise<void> {
    await this.postRaw('messages/send', raw, {});
  }

  async saveDraft(message: ResolvedOutgoingMessage, existing?: { folderId: string; messageId: string }) {
    const raw = await buildMime(message);
    const threadId = message.reference ? await this.threadIdOf(message.reference.messageId) : undefined;
    const draftId = existing ? await this.findDraftId(existing.messageId) : undefined;
    const res = draftId
      ? await this.postRaw('drafts', raw, { threadId }, 'PUT', draftId)
      : await this.postRaw('drafts', raw, { threadId });
    if (existing && !draftId) {
      // Alter Entwurf nicht mehr auffindbar → Nachricht entfernen, um Duplikate zu vermeiden
      await this.g.fetch(`${BASE}/messages/${encodeURIComponent(existing.messageId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    const msgId = (res as { message?: { id?: string } })?.message?.id;
    if (!msgId) throw new HttpError(502, 'Gmail hat keine Entwurfs-ID geliefert');
    return { folderId: 'DRAFT', messageId: msgId };
  }

  private async findDraftId(messageId: string): Promise<string | undefined> {
    let pageToken: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await this.g.json<{ drafts?: { id: string; message: { id: string } }[]; nextPageToken?: string }>(
        gurl(`${BASE}/drafts`, { maxResults: 500, pageToken, fields: 'drafts(id,message/id),nextPageToken' }),
      );
      const hit = res.drafts?.find((d) => d.message?.id === messageId);
      if (hit) return hit.id;
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return undefined;
  }

  /* ───────────── Aktionen ───────────── */

  private async batchModify(ids: string[], add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    for (let i = 0; i < ids.length; i += 1000) {
      await this.g.fetch(`${BASE}/messages/batchModify`, {
        method: 'POST',
        body: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove },
      });
    }
  }

  async updateFlags(_folderId: string, messageIds: string[], flags: FlagUpdate): Promise<void> {
    const add: string[] = [];
    const remove: string[] = [];
    if (flags.seen === true) remove.push('UNREAD');
    if (flags.seen === false) add.push('UNREAD');
    if (flags.flagged === true) add.push('STARRED');
    if (flags.flagged === false) remove.push('STARRED');
    await this.batchModify(messageIds, add, remove);
  }

  private async eachMessage(ids: string[], action: 'trash' | 'untrash') {
    await mapLimit(ids, 10, (id) => this.g.fetch(`${BASE}/messages/${encodeURIComponent(id)}/${action}`, { method: 'POST' }));
  }

  async move(folderId: string, messageIds: string[], targetFolderId: string): Promise<void> {
    if (folderId === targetFolderId || !messageIds.length) return;
    if (targetFolderId === 'TRASH') {
      await this.eachMessage(messageIds, 'trash');
      return;
    }
    if (folderId === 'TRASH') await this.eachMessage(messageIds, 'untrash');
    // Ansichten wie "Markiert"/"Wichtig"/"Alle" sind keine echten Ablageorte → Label dort nicht entfernen
    const keepSource = [ALL, 'STARRED', 'IMPORTANT', 'TRASH'].includes(folderId);
    const add = targetFolderId === ALL ? [] : [targetFolderId];
    const remove = keepSource ? [] : [folderId];
    if (targetFolderId === 'SPAM' && !remove.includes('INBOX')) remove.push('INBOX');
    await this.batchModify(messageIds, add, remove);
  }

  async delete(folderId: string, messageIds: string[], permanent?: boolean): Promise<void> {
    if (!messageIds.length) return;
    if (permanent || folderId === 'TRASH') {
      for (let i = 0; i < messageIds.length; i += 1000) {
        await this.g.fetch(`${BASE}/messages/batchDelete`, { method: 'POST', body: { ids: messageIds.slice(i, i + 1000) } });
      }
      for (const id of messageIds) this.rawCache.delete(id);
      return;
    }
    await this.eachMessage(messageIds, 'trash');
  }

  /* ───────────── Identitäten ───────────── */

  async listIdentities(): Promise<MailIdentity[]> {
    try {
      const { sendAs = [] } = await this.g.json<{
        sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; isDefault?: boolean; verificationStatus?: string }[];
      }>(`${BASE}/settings/sendAs`);
      const list = sendAs
        .filter((s) => s.isPrimary || !s.verificationStatus || s.verificationStatus === 'accepted')
        .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || Number(!!b.isPrimary) - Number(!!a.isPrimary))
        .map<MailIdentity>((s) => ({
          id: s.sendAsEmail,
          address: s.sendAsEmail,
          name: s.displayName || (s.isPrimary ? this.g.ctx.account.name : undefined),
        }));
      if (list.length) return list;
    } catch {
      /* Fallback unten */
    }
    return [{ id: this.g.email, address: this.g.email, name: this.g.ctx.account.name }];
  }

  /* ───────────── Benachrichtigungen ───────────── */

  private async currentHistoryId(): Promise<string> {
    const p = await this.g.json<{ historyId: string }>(`${BASE}/profile`);
    return String(p.historyId);
  }

  async pollInbox(state: string | undefined): Promise<PollResult> {
    if (!state) return { state: await this.currentHistoryId(), newMessages: [] };
    type HistoryRes = {
      history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
      historyId?: string;
      nextPageToken?: string;
    };
    const added = new Map<string, string[]>();
    let newState = state;
    let pageToken: string | undefined;
    try {
      for (let i = 0; i < 10; i++) {
        const res = await this.g.json<HistoryRes>(
          gurl(`${BASE}/history`, { startHistoryId: state, labelId: 'INBOX', historyTypes: 'messageAdded', pageToken, maxResults: 500 }),
        );
        for (const h of res.history ?? []) for (const a of h.messagesAdded ?? []) added.set(a.message.id, a.message.labelIds ?? []);
        if (res.historyId) newState = String(res.historyId);
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
    } catch (err) {
      // Verlauf abgelaufen (404) → neu beginnen, ohne Benachrichtigungen
      if (err instanceof HttpError && err.status === 404) return { state: await this.currentHistoryId(), newMessages: [] };
      throw err;
    }
    const ids = [...added.entries()]
      .filter(([, labels]) => labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT'))
      .map(([id]) => id)
      .slice(-20);
    const newMessages = ids.length ? (await this.fetchSummaries(ids, 'INBOX')).filter((m) => !m.seen) : [];
    return { state: newState, newMessages };
  }

  /* ───────────── Abwesenheit ───────────── */

  async getOutOfOffice(): Promise<OutOfOfficeSettings> {
    const v = await this.g.json<{
      enableAutoReply?: boolean;
      responseBodyHtml?: string;
      responseBodyPlainText?: string;
      startTime?: string;
      endTime?: string;
    }>(`${BASE}/settings/vacation`);
    const body = v.responseBodyHtml || v.responseBodyPlainText || '';
    return {
      enabled: !!v.enableAutoReply,
      internalReply: body,
      externalReply: body,
      start: v.startTime ? new Date(Number(v.startTime)).toISOString() : null,
      end: v.endTime ? new Date(Number(v.endTime)).toISOString() : null,
    };
  }

  async setOutOfOffice(s: OutOfOfficeSettings): Promise<void> {
    const current = await this.g
      .json<{ responseSubject?: string; restrictToContacts?: boolean; restrictToDomain?: boolean }>(`${BASE}/settings/vacation`)
      .catch(() => ({}) as { responseSubject?: string; restrictToContacts?: boolean; restrictToDomain?: boolean });
    const body = s.internalReply || s.externalReply || '';
    await this.g.json(`${BASE}/settings/vacation`, {
      method: 'PUT',
      body: {
        enableAutoReply: s.enabled,
        responseSubject: current.responseSubject || (body ? '' : 'Abwesenheitsnotiz'),
        responseBodyHtml: body,
        restrictToContacts: current.restrictToContacts ?? false,
        restrictToDomain: current.restrictToDomain ?? false,
        startTime: s.start ? String(new Date(s.start).getTime()) : undefined,
        endTime: s.end ? String(new Date(s.end).getTime()) : undefined,
      },
    });
  }
}

/** Gmail-Snippets enthalten HTML-Entities */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
