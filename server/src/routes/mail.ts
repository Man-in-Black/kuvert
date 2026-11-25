import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FolderRole, MessageSummary, OutgoingMessage, Paged, ThreadResult } from '@kuvert/shared';
import { BadRequestError } from '../core/errors.js';
import type { AccountRecord, ModuleContext } from '../core/module.js';
import type { MailProvider } from '../core/providers.js';
import type { MailMutation } from '../core/events.js';
import { users } from '../core/users.js';
import { buildInviteReply, buildInviteReplyMime, emlFilename, findIcs, parseRawMessage } from '../core/mime.js';
import { uploads } from '../core/uploads.js';
import { decodeCursor, encodeCursor, parse, sendFile, settleByAccount } from './util.js';

type AccParams = { Params: { accountId: string } };

const addr = z.object({ name: z.string().optional(), address: z.string().min(3) });
const outgoingSchema = z.object({
  identityId: z.string().optional(),
  from: addr,
  to: z.array(addr).default([]),
  cc: z.array(addr).optional(),
  bcc: z.array(addr).optional(),
  replyTo: z.array(addr).optional(),
  subject: z.string().default(''),
  html: z.string().optional(),
  text: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string().optional(),
        uploadId: z.string().optional(),
        contentBase64: z.string().optional(),
        inline: z.boolean().optional(),
        contentId: z.string().optional(),
      }),
    )
    .optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  reference: z.object({ folderId: z.string(), messageId: z.string(), type: z.enum(['reply', 'replyAll', 'forward']) }).optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  requestReadReceipt: z.boolean().optional(),
  smime: z.object({ sign: z.boolean().optional(), encrypt: z.boolean().optional() }).optional(),
  sendAt: z.string().nullable().optional(),
  draftId: z.string().optional(),
  draftFolderId: z.string().optional(),
});

const idsSchema = z.object({ folderId: z.string(), ids: z.array(z.string()).min(1) });

interface UnifiedState {
  [accountId: string]: { c?: string; s: number; d?: boolean };
}

export async function mailRoutes(app: FastifyInstance, ctx: ModuleContext) {
  const { accounts } = ctx;
  const mail = (userId: string, accountId: string): MailProvider => accounts.require(userId, accountId, 'mail');
  const mutated = (m: MailMutation) => ctx.bus.internal.emit('mail.mutated', m);

  /* ───────────── Ordner & Listen ───────────── */

  app.get<AccParams>('/api/mail/accounts/:accountId/folders', async (req) => mail(req.user.id, req.params.accountId).listFolders());

  app.post<AccParams>('/api/mail/accounts/:accountId/folders', async (req) => {
    const body = parse(z.object({ name: z.string().min(1), parentId: z.string().nullable().optional() }), req.body);
    const m = mail(req.user.id, req.params.accountId);
    if (!m.createFolder) throw new BadRequestError('Ordner anlegen wird nicht unterstützt');
    return m.createFolder(body.name, body.parentId);
  });

  app.patch<AccParams>('/api/mail/accounts/:accountId/folders', async (req) => {
    const body = parse(z.object({ folderId: z.string(), name: z.string().min(1) }), req.body);
    const m = mail(req.user.id, req.params.accountId);
    if (!m.renameFolder) throw new BadRequestError('Umbenennen wird nicht unterstützt');
    await m.renameFolder(body.folderId, body.name);
    return { ok: true };
  });

  app.delete<AccParams & { Querystring: { folderId: string } }>('/api/mail/accounts/:accountId/folders', async (req) => {
    const m = mail(req.user.id, req.params.accountId);
    if (!m.deleteFolder) throw new BadRequestError('Löschen wird nicht unterstützt');
    await m.deleteFolder(req.query.folderId);
    return { ok: true };
  });

  app.get<AccParams & { Querystring: { folderId: string; cursor?: string; limit?: string; search?: string; unreadOnly?: string; flaggedOnly?: string } }>(
    '/api/mail/accounts/:accountId/messages',
    async (req) => {
      const q = req.query;
      if (!q.folderId) throw new BadRequestError('folderId fehlt');
      const idx = ctx.hooks.searchIndex;
      const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
      const hookCtx = { userId: req.user.id, accountId: req.params.accountId, folderId: q.folderId };
      if (q.search && idx && (!q.cursor || q.cursor.startsWith('idx:')) && (await idx.readyAccounts(req.user.id)).has(req.params.accountId)) {
        const offset = q.cursor ? Number(q.cursor.slice(4)) || 0 : 0;
        const filters = [q.unreadOnly === 'true' ? 'is:unread' : '', q.flaggedOnly === 'true' ? 'is:flagged' : ''].filter(Boolean).join(' ');
        const res = await idx.search(req.user.id, { q: `${q.search} ${filters}`.trim(), accountIds: [req.params.accountId], folderId: q.folderId, limit, offset });
        return { items: await ctx.hooks.runMessageList(hookCtx, res.items), nextCursor: offset + limit < res.total ? `idx:${offset + limit}` : null };
      }
      const page = await mail(req.user.id, req.params.accountId).listMessages({
        folderId: q.folderId,
        cursor: q.cursor || undefined,
        limit,
        search: (q.search && idx ? idx.plainText(q.search) : q.search) || undefined,
        unreadOnly: q.unreadOnly === 'true',
        flaggedOnly: q.flaggedOnly === 'true',
      });
      return { ...page, items: await ctx.hooks.runMessageList(hookCtx, page.items) };
    },
  );

  /**
   * Gemeinsamer Posteingang (bzw. gemeinsamer Ordner einer Rolle) über alle Konten.
   * K-Wege-Merge nach Datum; der Cursor speichert die Position je Quelle (Konto bzw. freigegebenes Postfach).
   */
  app.get<{ Querystring: { role?: FolderRole; cursor?: string; limit?: string; unreadOnly?: string; flaggedOnly?: string } }>(
    '/api/mail/unified',
    async (req) => {
      const role = (req.query.role ?? 'inbox') as FolderRole;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);
      const state = decodeCursor<UnifiedState>(req.query.cursor) ?? {};
      // Quellen: Hauptpostfach je Konto (abwählbar) plus ausgewählte freigegebene Postfächer.
      // Der Cursor-Schlüssel ist die Konto-ID bzw. "Konto-ID|Postfach".
      const sources = accounts.withCapability(req.user.id, 'mail').flatMap((a) => {
        const list: { id: string; name: string; account: AccountRecord; mailbox?: string }[] = [];
        if (a.settings.includeInUnifiedInbox !== false) list.push({ id: a.id, name: a.name, account: a });
        const shared = new Set((a.settings.sharedMailboxes ?? []).map((x) => String(x).trim().toLowerCase()));
        for (const raw of a.settings.unifiedSharedMailboxes ?? []) {
          const mb = String(raw).trim().toLowerCase();
          if (shared.has(mb)) list.push({ id: `${a.id}|${mb}`, name: `${a.name} – ${mb}`, account: a, mailbox: mb });
        }
        return list;
      });
      const accountOf = new Map(sources.map((s) => [s.id, s.account.id]));

      type PageData = { cursor?: string; items: MessageSummary[]; next?: string | null };
      const settled = await settleByAccount(sources, async (src) => {
        const { account: a, mailbox } = src;
        const st = state[src.id] ?? { s: 0 };
        if (st.d) return { pages: [] as PageData[], skip: 0 };
        const m = accounts.providersFor(a).mail!;
        const folderId = mailbox ? await m.getMailboxFolderId?.(mailbox, role) : await m.getSpecialFolderId(role);
        if (!folderId) return { pages: [] as PageData[], skip: 0 };
        const pages: PageData[] = [];
        let cur = st.c;
        let collected = 0;
        for (let i = 0; i < 5; i++) {
          const page = await m.listMessages({
            folderId,
            cursor: cur,
            limit,
            unreadOnly: req.query.unreadOnly === 'true',
            flaggedOnly: req.query.flaggedOnly === 'true',
          });
          pages.push({ cursor: cur, items: page.items, next: page.nextCursor });
          collected += page.items.length - (i === 0 ? st.s : 0);
          if (collected >= limit || !page.nextCursor) break;
          cur = page.nextCursor;
        }
        return { pages, skip: st.s };
      });

      const { results } = settled;
      // Fehler der Client-Anzeige wegen mit der echten Konto-ID melden
      const errors = settled.errors.map((e) => ({ ...e, accountId: accountOf.get(e.accountId) ?? e.accountId, source: e.accountId }));

      // Sequenzen je Quelle (nach Überspringen bereits gelieferter Einträge)
      const seqs = results.map((r) => ({
        accountId: r.accountId,
        items: r.value.pages.flatMap((p) => p.items).slice(r.value.skip),
        pages: r.value.pages,
        skip: r.value.skip,
      }));
      const ptr = seqs.map(() => 0);
      const items: MessageSummary[] = [];
      while (items.length < limit) {
        let best = -1;
        for (let i = 0; i < seqs.length; i++) {
          const head = seqs[i]!.items[ptr[i]!];
          if (!head) continue;
          if (best < 0 || head.date > seqs[best]!.items[ptr[best]!]!.date) best = i;
        }
        if (best < 0) break;
        items.push(seqs[best]!.items[ptr[best]!]!);
        ptr[best]!++;
      }

      const next: UnifiedState = { ...state };
      seqs.forEach((s, i) => {
        let pos = s.skip + ptr[i]!;
        for (let p = 0; p < s.pages.length; p++) {
          const page = s.pages[p]!;
          if (pos < page.items.length) {
            next[s.accountId] = { c: page.cursor, s: pos };
            return;
          }
          pos -= page.items.length;
        }
        const last = s.pages[s.pages.length - 1];
        next[s.accountId] = last?.next ? { c: last.next, s: 0 } : { s: 0, d: true };
      });
      for (const e of errors) next[e.source] = { ...(state[e.source] ?? { s: 0 }) };

      const hasMore = Object.values(next).some((v) => !v.d);
      return { items: await ctx.hooks.runMessageList({ userId: req.user.id }, items), nextCursor: hasMore && items.length > 0 ? encodeCursor(next) : null, errors } satisfies Paged<MessageSummary> & {
        errors: unknown[];
      };
    },
  );

  /**
   * Kontoübergreifende Suche: Konten mit fertigem Suchindex werden über den Index
   * durchsucht (Millisekunden, Suchbefehle, Hervorhebung), alle anderen live beim Anbieter.
   */
  app.get<{ Querystring: { q: string; accountId?: string; limit?: string; offset?: string } }>('/api/mail/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { items: [], errors: [], total: 0, indexed: false, liveAccounts: [], processingTimeMs: 0 };
    const started = Date.now();
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const accs = accounts.withCapability(req.user.id, 'mail').filter((a) => !req.query.accountId || a.id === req.query.accountId);
    const idx = ctx.hooks.searchIndex;
    const ready = idx ? await idx.readyAccounts(req.user.id) : new Set<string>();
    const indexedIds = accs.filter((a) => ready.has(a.id)).map((a) => a.id);
    const live = accs.filter((a) => !ready.has(a.id));

    const indexedPromise = idx && indexedIds.length ? idx.search(req.user.id, { q, accountIds: indexedIds, limit, offset }) : null;
    const liveText = idx ? idx.plainText(q) : q;
    const { results, errors } =
      live.length && liveText && offset === 0
        ? await settleByAccount(live, async (a) => {
            const m = accounts.providersFor(a as AccountRecord).mail!;
            if (m.search) return (await m.search(liveText, { limit })).items;
            const inbox = await m.getSpecialFolderId('inbox');
            return inbox ? (await m.listMessages({ folderId: inbox, search: liveText, limit })).items : [];
          })
        : { results: [] as { accountId: string; value: MessageSummary[] }[], errors: [] as { accountId: string; account: string; message: string }[] };
    const indexed = indexedPromise ? await indexedPromise.catch(() => null) : null;

    const items = [...(indexed?.items ?? []), ...results.flatMap((r) => r.value)].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
    const total = (indexed?.total ?? 0) + results.reduce((n, r) => n + r.value.length, 0);
    return {
      items: await ctx.hooks.runMessageList({ userId: req.user.id }, items),
      errors,
      total,
      indexed: !!indexed,
      liveAccounts: live.map((a) => a.id),
      processingTimeMs: indexed && !live.length ? indexed.processingTimeMs : Date.now() - started,
      nextCursor: indexed && offset + limit < indexed.total ? String(offset + limit) : null,
    };
  });

  /**
   * Unterhaltung ordnerübergreifend (Gesendet, Archiv, Papierkorb …). Ohne Unterstützung
   * des Anbieters: leere Liste, der Client zeigt dann nur die Nachrichten der Liste.
   */
  app.post<AccParams>('/api/mail/accounts/:accountId/thread', async (req): Promise<ThreadResult> => {
    const body = parse(
      z.object({
        folderId: z.string(),
        messageId: z.string(),
        threadId: z.string().optional(),
        messageIds: z.array(z.string().max(998)).max(50).optional(),
      }),
      req.body,
    );
    const m = mail(req.user.id, req.params.accountId);
    if (!m.getThread) return { items: [], supported: false };
    const items = await m.getThread(body);
    return { items: await ctx.hooks.runMessageList({ userId: req.user.id, accountId: req.params.accountId }, items), supported: true };
  });

  /* ───────────── Einzelne Nachricht ───────────── */

  app.get<AccParams & { Querystring: { folderId: string; id: string } }>('/api/mail/accounts/:accountId/message', async (req) => {
    const { folderId, id } = req.query;
    if (!folderId || !id) throw new BadRequestError('folderId und id erforderlich');
    const m = mail(req.user.id, req.params.accountId);
    const msg = await m.getMessage(folderId, id);
    return ctx.hooks.runMessageView({ userId: req.user.id, accountId: req.params.accountId, folderId, mail: m }, msg);
  });

  app.get<AccParams & { Querystring: { folderId: string; id: string; attachmentId: string; inline?: string } }>(
    '/api/mail/accounts/:accountId/attachment',
    async (req, reply) => {
      const { folderId, id, attachmentId } = req.query;
      const m = mail(req.user.id, req.params.accountId);
      // Module (z. B. S/MIME) können eigene Anhang-IDs auflösen (entschlüsselte Inhalte)
      let file = undefined as Awaited<ReturnType<MailProvider['getAttachment']>> | undefined;
      for (const resolver of ctx.hooks.attachmentResolvers) {
        file = await resolver({ userId: req.user.id, accountId: req.params.accountId, folderId, mail: m }, id, attachmentId);
        if (file) break;
      }
      file ??= await m.getAttachment(folderId, id, attachmentId);
      return sendFile(reply, file, req.query.inline === '1');
    },
  );

  app.get<AccParams & { Querystring: { folderId: string; id: string } }>('/api/mail/accounts/:accountId/raw', async (req, reply) => {
    const raw = await mail(req.user.id, req.params.accountId).getRawMessage(req.query.folderId, req.query.id);
    return sendFile(reply, { filename: await emlFilename(raw), contentType: 'message/rfc822', data: raw });
  });

  /** Anhang einer Mail als Upload übernehmen (z. B. für Weiterleitungen) */
  app.post<AccParams>('/api/mail/accounts/:accountId/attachment-to-upload', async (req) => {
    const body = parse(z.object({ folderId: z.string(), id: z.string(), attachmentId: z.string() }), req.body);
    const file = await mail(req.user.id, req.params.accountId).getAttachment(body.folderId, body.id, body.attachmentId);
    return uploads.save(req.user.id, file.filename, file.contentType, file.data);
  });

  /* ───────────── Aktionen ───────────── */

  app.post<AccParams>('/api/mail/accounts/:accountId/flags', async (req) => {
    const body = parse(idsSchema.extend({ seen: z.boolean().optional(), flagged: z.boolean().optional() }), req.body);
    await mail(req.user.id, req.params.accountId).updateFlags(body.folderId, body.ids, { seen: body.seen, flagged: body.flagged });
    mutated({ userId: req.user.id, accountId: req.params.accountId, folderId: body.folderId, ids: body.ids, action: 'flags', flags: { seen: body.seen, flagged: body.flagged } });
    return { ok: true };
  });

  app.post<AccParams>('/api/mail/accounts/:accountId/move', async (req) => {
    const body = parse(idsSchema.extend({ targetFolderId: z.string() }), req.body);
    await mail(req.user.id, req.params.accountId).move(body.folderId, body.ids, body.targetFolderId);
    mutated({ userId: req.user.id, accountId: req.params.accountId, folderId: body.folderId, ids: body.ids, action: 'move', targetFolderId: body.targetFolderId });
    return { ok: true };
  });

  /** Verschieben in einen Ordner mit Rolle (archive, junk, inbox …) */
  app.post<AccParams>('/api/mail/accounts/:accountId/move-to-role', async (req) => {
    const body = parse(idsSchema.extend({ role: z.enum(['inbox', 'archive', 'junk', 'trash']) }), req.body);
    const m = mail(req.user.id, req.params.accountId);
    const target = await m.getSpecialFolderId(body.role);
    if (!target) throw new BadRequestError(`Kein Ordner für "${body.role}" gefunden`);
    await m.move(body.folderId, body.ids, target);
    mutated({ userId: req.user.id, accountId: req.params.accountId, folderId: body.folderId, ids: body.ids, action: 'move', targetFolderId: target });
    return { ok: true, targetFolderId: target };
  });

  app.post<AccParams>('/api/mail/accounts/:accountId/delete', async (req) => {
    const body = parse(idsSchema.extend({ permanent: z.boolean().optional() }), req.body);
    await mail(req.user.id, req.params.accountId).delete(body.folderId, body.ids, body.permanent);
    mutated({ userId: req.user.id, accountId: req.params.accountId, folderId: body.folderId, ids: body.ids, action: 'delete' });
    return { ok: true };
  });

  /* ───────────── Einladungen ───────────── */

  /** Einladung aus der Mail heraus beantworten (zusagen, mit Vorbehalt, absagen) */
  app.post<AccParams>('/api/mail/accounts/:accountId/invite/respond', async (req) => {
    const body = parse(
      z.object({ folderId: z.string(), id: z.string(), response: z.enum(['accept', 'tentative', 'decline']), comment: z.string().max(2000).optional() }),
      req.body,
    );
    const { accountId } = req.params;
    const m = mail(req.user.id, accountId);
    if (m.respondToInvite) {
      await m.respondToInvite(body.folderId, body.id, body.response, body.comment);
    } else {
      // Generisch (IMAP, Gmail …): iTIP-Antwort (METHOD:REPLY) an den Organisator schicken
      const parsed = await parseRawMessage(await m.getRawMessage(body.folderId, body.id));
      const ics = findIcs(parsed.attachments);
      if (!ics) throw new BadRequestError('Die Nachricht enthält keine Einladung');
      const identities = await m.listIdentities().catch(() => []);
      const primary = identities.find((i) => !i.shared) ?? identities[0];
      if (!primary) throw new BadRequestError('Keine Absenderadresse für dieses Konto gefunden');
      let reply: ReturnType<typeof buildInviteReply>;
      try {
        reply = buildInviteReply(ics.content.toString('utf8'), identities.map((i) => i.address), primary.address, body.response, body.comment);
      } catch (err) {
        throw new BadRequestError(`Einladung kann nicht beantwortet werden: ${(err as Error).message}`);
      }
      const identity = identities.find((i) => i.address.toLowerCase() === reply.attendee) ?? primary;
      const prefix = { accept: 'Zugesagt', tentative: 'Mit Vorbehalt angenommen', decline: 'Abgesagt' }[body.response];
      const from = { name: identity.name, address: identity.address };
      const text = `${from.name || from.address} hat ${{ accept: 'zugesagt', tentative: 'mit Vorbehalt zugesagt', decline: 'abgesagt' }[body.response]}: ${reply.summary}${body.comment?.trim() ? `\n\n${body.comment.trim()}` : ''}`;
      const raw = await buildInviteReplyMime({
        from,
        to: reply.organizer,
        subject: `${prefix}: ${reply.summary || parsed.detail.subject}`,
        text,
        ics: reply.ics,
        inReplyTo: parsed.detail.messageIdHeader,
        references: parsed.detail.messageIdHeader ? [...(parsed.detail.references ?? []), parsed.detail.messageIdHeader] : undefined,
      });
      await m.sendRaw(raw, { from: identity.address, to: [reply.organizer.address], identity });
    }
    ctx.bus.publish(req.user.id, { type: 'calendar.changed', accountId });
    ctx.bus.publish(req.user.id, { type: 'mail.changed', accountId });
    return { ok: true };
  });

  /* ───────────── Senden & Entwürfe ───────────── */

  app.get<AccParams>('/api/mail/accounts/:accountId/identities', async (req) => mail(req.user.id, req.params.accountId).listIdentities());

  app.post<AccParams>('/api/mail/accounts/:accountId/send', async (req) => {
    const body = parse(z.object({ message: outgoingSchema, undo: z.boolean().optional() }), req.body);
    const settings = users.getSettings(req.user.id);
    const undo = body.undo === false ? 0 : settings.undoSendSeconds;
    return ctx.mail.submit(req.user.id, req.params.accountId, body.message as OutgoingMessage, undo);
  });

  app.post<AccParams>('/api/mail/accounts/:accountId/drafts', async (req) => {
    const body = parse(
      z.object({ message: outgoingSchema.extend({ from: addr.optional() }), existing: z.object({ folderId: z.string(), messageId: z.string() }).optional() }),
      req.body,
    );
    const m = mail(req.user.id, req.params.accountId);
    if (!m.saveDraft) throw new BadRequestError('Entwürfe werden für dieses Konto nicht unterstützt');
    const identities = await m.listIdentities().catch(() => []);
    const msg = body.message as OutgoingMessage;
    const resolved = await ctx.mail.resolve(req.user.id, { ...msg, to: msg.to?.length ? msg.to : [{ address: 'entwurf@invalid' }] }, identities);
    if (!msg.to?.length) resolved.to = [];
    return m.saveDraft(resolved, body.existing);
  });

  app.get('/api/mail/scheduled', async (req) => ctx.mail.listScheduled(req.user.id));

  app.post<{ Params: { id: string } }>('/api/mail/scheduled/:id/cancel', async (req) => ({ message: ctx.mail.cancel(req.user.id, req.params.id) }));

  app.post<{ Params: { id: string } }>('/api/mail/scheduled/:id/retry', async (req) => {
    ctx.mail.retry(req.user.id, req.params.id);
    return { ok: true };
  });

  /* ───────────── Abwesenheit ───────────── */

  app.get<AccParams>('/api/mail/accounts/:accountId/out-of-office', async (req) => {
    const m = mail(req.user.id, req.params.accountId);
    if (!m.getOutOfOffice) throw new BadRequestError('Abwesenheitsnotiz wird nicht unterstützt');
    return m.getOutOfOffice();
  });

  app.put<AccParams>('/api/mail/accounts/:accountId/out-of-office', async (req) => {
    const body = parse(
      z.object({
        enabled: z.boolean(),
        internalReply: z.string().optional(),
        externalReply: z.string().optional(),
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
      }),
      req.body,
    );
    const m = mail(req.user.id, req.params.accountId);
    if (!m.setOutOfOffice) throw new BadRequestError('Abwesenheitsnotiz wird nicht unterstützt');
    await m.setOutOfOffice(body);
    return { ok: true };
  });
}
