/**
 * Datenhaltung des Team-Chats: Unterhaltungen (Direkt/Gruppe), Mitglieder mit
 * Lesestand, Nachrichten (fortlaufende seq), Reaktionen und Dateianhänge.
 * Dateien liegen unter <DATA_DIR>/chat-files/<id>.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, ChatConversation, ChatMember, ChatMessage, ChatReaction, ChatSystemEvent, ChatUser } from '@kuvert/shared';
import { mentionHandle } from '@kuvert/shared';
import { config } from '../../config.js';
import { uuid } from '../../core/crypto.js';
import { getDb } from '../../core/db.js';
import { AppError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { uploads } from '../../core/uploads.js';
import { toUser, type UserRow } from '../../core/users.js';
import { kuvertCalls } from './calls.js';

const ISO_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const migrations = [
  {
    id: 'chat-001',
    sql: `
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT,
        description TEXT,
        direct_key TEXT UNIQUE,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        last_message_at TEXT NOT NULL DEFAULT (${ISO_NOW})
      );
      CREATE TABLE chat_members (
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE INDEX chat_members_user ON chat_members(user_id);
      CREATE TABLE chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        body TEXT NOT NULL DEFAULT '',
        reply_to TEXT,
        created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        edited_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX chat_messages_conv ON chat_messages(conversation_id, seq);
      CREATE TABLE chat_reactions (
        message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE TABLE chat_files (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${ISO_NOW})
      );
      CREATE INDEX chat_files_message ON chat_files(message_id);
      CREATE INDEX chat_files_conv ON chat_files(conversation_id);
    `,
  },
];

const fileDir = path.join(config.dataDir, 'chat-files');
fs.mkdirSync(fileDir, { recursive: true });

export const MAX_BODY = 10_000;
export const MAX_ATTACHMENTS = 10;
export const PAGE_SIZE = 50;

/* ───────────────────────────── Zeilentypen ───────────────────────────── */

interface ConvRow {
  id: string;
  kind: 'direct' | 'group';
  name: string | null;
  description: string | null;
  direct_key: string | null;
  created_by: string | null;
  created_at: string;
  last_message_at: string;
}

interface MemberRow {
  conversation_id: string;
  user_id: string;
  role: 'owner' | 'member';
  last_read_seq: number;
  muted: number;
  pinned: number;
  joined_at: string;
}

interface MsgRow {
  seq: number;
  id: string;
  conversation_id: string;
  user_id: string | null;
  kind: 'text' | 'system';
  body: string;
  reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

const db = () => getDb();
const now = () => new Date().toISOString();
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/* ───────────────────────────── Nachrichten aufbereiten ───────────────────────────── */

function hydrate(rows: MsgRow[]): ChatMessage[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);

  const files = new Map<string, ChatAttachment[]>();
  for (const f of db()
    // rowid = Einfügereihenfolge → Anhänge erscheinen in der Reihenfolge des Hochladens
    .prepare(`SELECT id, message_id, filename, content_type, size FROM chat_files WHERE message_id IN (${ph}) ORDER BY rowid`)
    .all(...ids) as { id: string; message_id: string; filename: string; content_type: string; size: number }[]) {
    const list = files.get(f.message_id) ?? [];
    list.push({ id: f.id, filename: f.filename, contentType: f.content_type, size: f.size });
    files.set(f.message_id, list);
  }

  const reactions = new Map<string, ChatReaction[]>();
  for (const r of db()
    .prepare(`SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${ph}) ORDER BY created_at`)
    .all(...ids) as { message_id: string; emoji: string; user_id: string }[]) {
    const list = reactions.get(r.message_id) ?? [];
    const existing = list.find((x) => x.emoji === r.emoji);
    if (existing) existing.userIds.push(r.user_id);
    else list.push({ emoji: r.emoji, userIds: [r.user_id] });
    reactions.set(r.message_id, list);
  }

  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter((x): x is string => !!x))];
  const replies = new Map<string, NonNullable<ChatMessage['replyTo']>>();
  if (replyIds.length) {
    for (const r of db()
      .prepare(
        `SELECT m.id, m.user_id, m.body, m.deleted_at,
           EXISTS(SELECT 1 FROM chat_files f WHERE f.message_id = m.id) AS has_files
         FROM chat_messages m WHERE m.id IN (${placeholders(replyIds.length)})`,
      )
      .all(...replyIds) as { id: string; user_id: string | null; body: string; deleted_at: string | null; has_files: number }[]) {
      replies.set(r.id, {
        id: r.id,
        senderId: r.user_id,
        body: r.deleted_at ? '' : r.body.slice(0, 280),
        deleted: !!r.deleted_at,
        hasAttachments: !r.deleted_at && !!r.has_files,
      });
    }
  }

  return rows.map((r) => {
    const deleted = !!r.deleted_at;
    return {
      id: r.id,
      seq: r.seq,
      conversationId: r.conversation_id,
      senderId: r.user_id,
      kind: r.kind,
      body: deleted ? '' : r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted,
      replyTo: r.reply_to ? (replies.get(r.reply_to) ?? { id: r.reply_to, senderId: null, body: '', deleted: true, hasAttachments: false }) : null,
      attachments: deleted ? [] : (files.get(r.id) ?? []),
      reactions: deleted ? [] : (reactions.get(r.id) ?? []),
    };
  });
}

function messageRow(id: string): MsgRow | undefined {
  return db().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as MsgRow | undefined;
}

/* ───────────────────────────── Dateien ───────────────────────────── */

function removeFiles(where: string, ...params: unknown[]) {
  const rows = db().prepare(`SELECT id FROM chat_files WHERE ${where}`).all(...params) as { id: string }[];
  for (const r of rows) fs.rmSync(path.join(fileDir, r.id), { force: true });
  db().prepare(`DELETE FROM chat_files WHERE ${where}`).run(...params);
}

/* ───────────────────────────── Store ───────────────────────────── */

export const chatStore = {
  /* ─────────── Benutzerverzeichnis ─────────── */

  directory(online: Set<string>): ChatUser[] {
    const rows = db().prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as UserRow[];
    return rows.map((r) => {
      const u = toUser(r);
      const profile = JSON.parse(r.profile_json || '{}') as { jobTitle?: string; department?: string };
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        online: online.has(u.id),
        jobTitle: profile.jobTitle || undefined,
        department: profile.department || undefined,
        disabled: !!r.disabled || undefined,
        mention: mentionHandle(u.email),
      };
    });
  },

  /** Aktive (nicht gesperrte) Benutzer-IDs aus einer Liste */
  activeUserIds(ids: string[]): string[] {
    if (!ids.length) return [];
    const rows = db()
      .prepare(`SELECT id FROM users WHERE disabled = 0 AND id IN (${placeholders(ids.length)})`)
      .all(...ids) as { id: string }[];
    return rows.map((r) => r.id);
  },

  /* ─────────── Mitgliedschaft ─────────── */

  member(conversationId: string, userId: string): MemberRow | undefined {
    return db().prepare('SELECT * FROM chat_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId) as MemberRow | undefined;
  },

  /** Wirft 404, wenn der Benutzer kein Mitglied ist (Existenz wird nicht verraten) */
  requireMember(conversationId: string, userId: string): MemberRow {
    const m = this.member(conversationId, userId);
    if (!m) throw new NotFoundError('Unterhaltung');
    return m;
  },

  memberIds(conversationId: string): string[] {
    return (db().prepare('SELECT user_id FROM chat_members WHERE conversation_id = ?').all(conversationId) as { user_id: string }[]).map((r) => r.user_id);
  },

  conversationRow(id: string): ConvRow {
    const r = db().prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ConvRow | undefined;
    if (!r) throw new NotFoundError('Unterhaltung');
    return r;
  },

  /* ─────────── Unterhaltungen ─────────── */

  list(userId: string, onlyId?: string): ChatConversation[] {
    const rows = db()
      .prepare(
        `SELECT c.*, m.role, m.last_read_seq, m.muted, m.pinned,
           (SELECT MAX(x.seq) FROM chat_messages x WHERE x.conversation_id = c.id) AS last_seq,
           (SELECT COUNT(*) FROM chat_messages x
              WHERE x.conversation_id = c.id AND x.seq > m.last_read_seq AND x.kind = 'text'
                AND x.deleted_at IS NULL AND x.user_id IS NOT m.user_id) AS unread
         FROM chat_conversations c
         JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = ?
         ${onlyId ? 'WHERE c.id = ?' : ''}
         ORDER BY c.last_message_at DESC`,
      )
      .all(...(onlyId ? [userId, onlyId] : [userId])) as (ConvRow & {
      role: 'owner' | 'member';
      last_read_seq: number;
      muted: number;
      pinned: number;
      last_seq: number | null;
      unread: number;
    })[];
    // Leere Direktnachrichten nur beim Ersteller anzeigen (sonst erscheint jede angeklickte Person beim Gegenüber)
    const visible = rows.filter((r) => onlyId || r.kind !== 'direct' || r.last_seq !== null || r.created_by === userId);
    if (!visible.length) return [];

    const ids = visible.map((r) => r.id);
    const members = new Map<string, ChatMember[]>();
    for (const m of db()
      .prepare(`SELECT * FROM chat_members WHERE conversation_id IN (${placeholders(ids.length)}) ORDER BY joined_at`)
      .all(...ids) as MemberRow[]) {
      const list = members.get(m.conversation_id) ?? [];
      list.push({ userId: m.user_id, role: m.role, lastReadSeq: m.last_read_seq, joinedAt: m.joined_at });
      members.set(m.conversation_id, list);
    }

    const lastSeqs = visible.map((r) => r.last_seq).filter((x): x is number => x !== null);
    const last = new Map<string, ChatMessage>();
    if (lastSeqs.length) {
      const msgRows = db()
        .prepare(`SELECT * FROM chat_messages WHERE seq IN (${placeholders(lastSeqs.length)})`)
        .all(...lastSeqs) as MsgRow[];
      for (const m of hydrate(msgRows)) last.set(m.conversationId, m);
    }

    return visible.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at,
      members: members.get(r.id) ?? [],
      lastMessage: last.get(r.id) ?? null,
      unread: r.unread,
      muted: !!r.muted,
      pinned: !!r.pinned,
      myRole: r.role,
      call: kuvertCalls.get(r.id) ?? null,
    }));
  },

  get(conversationId: string, userId: string): ChatConversation {
    this.requireMember(conversationId, userId);
    const c = this.list(userId, conversationId)[0];
    if (!c) throw new NotFoundError('Unterhaltung');
    return c;
  },

  /** Direktnachricht holen oder anlegen. created = neu angelegt */
  openDirect(userId: string, otherId: string): { id: string; created: boolean } {
    if (userId === otherId) throw new BadRequestError('Wähle eine andere Person aus');
    if (!this.activeUserIds([otherId]).length) throw new NotFoundError('Benutzer');
    const key = [userId, otherId].sort().join(':');
    const existing = db().prepare('SELECT id FROM chat_conversations WHERE direct_key = ?').get(key) as { id: string } | undefined;
    if (existing) {
      // Falls ein Mitglied (z. B. nach Löschen/Neuanlage) fehlt, wieder aufnehmen
      for (const id of [userId, otherId]) {
        db().prepare('INSERT OR IGNORE INTO chat_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(existing.id, id, 'member');
      }
      return { id: existing.id, created: false };
    }
    const id = uuid();
    db().transaction(() => {
      db().prepare('INSERT INTO chat_conversations (id, kind, direct_key, created_by) VALUES (?, ?, ?, ?)').run(id, 'direct', key, userId);
      const ins = db().prepare('INSERT INTO chat_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
      ins.run(id, userId, 'member');
      ins.run(id, otherId, 'member');
    })();
    return { id, created: true };
  },

  createGroup(userId: string, input: { name: string; description?: string | null; memberIds: string[] }): string {
    const name = input.name.trim();
    if (!name) throw new BadRequestError('Bitte einen Gruppennamen angeben');
    const others = this.activeUserIds([...new Set(input.memberIds)].filter((id) => id !== userId));
    const id = uuid();
    db().transaction(() => {
      db()
        .prepare('INSERT INTO chat_conversations (id, kind, name, description, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'group', name, input.description?.trim() || null, userId);
      const ins = db().prepare('INSERT INTO chat_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
      ins.run(id, userId, 'owner');
      for (const o of others) ins.run(id, o, 'member');
      this.addSystemMessage(id, { action: 'created', actorId: userId, name });
      if (others.length) this.addSystemMessage(id, { action: 'added', actorId: userId, userIds: others });
    })();
    return id;
  },

  update(conversationId: string, userId: string, patch: { name?: string; description?: string | null }): ChatMessage | null {
    this.requireMember(conversationId, userId);
    const c = this.conversationRow(conversationId);
    if (c.kind !== 'group') throw new BadRequestError('Direktnachrichten haben keinen Namen');
    let sys: ChatMessage | null = null;
    db().transaction(() => {
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new BadRequestError('Bitte einen Gruppennamen angeben');
        if (name !== c.name) {
          db().prepare('UPDATE chat_conversations SET name = ? WHERE id = ?').run(name, conversationId);
          sys = this.addSystemMessage(conversationId, { action: 'renamed', actorId: userId, name });
        }
      }
      if (patch.description !== undefined) {
        db().prepare('UPDATE chat_conversations SET description = ? WHERE id = ?').run(patch.description?.trim() || null, conversationId);
      }
    })();
    return sys;
  },

  setPrefs(conversationId: string, userId: string, prefs: { muted?: boolean; pinned?: boolean }) {
    const m = this.requireMember(conversationId, userId);
    db()
      .prepare('UPDATE chat_members SET muted = ?, pinned = ? WHERE conversation_id = ? AND user_id = ?')
      .run(prefs.muted === undefined ? m.muted : prefs.muted ? 1 : 0, prefs.pinned === undefined ? m.pinned : prefs.pinned ? 1 : 0, conversationId, userId);
  },

  addMembers(conversationId: string, actorId: string, userIds: string[]): { added: string[]; message: ChatMessage | null } {
    this.requireMember(conversationId, actorId);
    const c = this.conversationRow(conversationId);
    if (c.kind !== 'group') throw new BadRequestError('Mitglieder lassen sich nur zu Gruppen hinzufügen');
    const current = new Set(this.memberIds(conversationId));
    const added = this.activeUserIds([...new Set(userIds)].filter((id) => !current.has(id)));
    if (!added.length) return { added, message: null };
    let message: ChatMessage | null = null;
    db().transaction(() => {
      // Neue Mitglieder sehen den Verlauf, starten aber ohne ungelesene Nachrichten
      const maxSeq = this.maxSeq(conversationId);
      const ins = db().prepare('INSERT INTO chat_members (conversation_id, user_id, role, last_read_seq) VALUES (?, ?, ?, ?)');
      for (const id of added) ins.run(conversationId, id, 'member', maxSeq);
      message = this.addSystemMessage(conversationId, { action: 'added', actorId, userIds: added });
    })();
    return { added, message };
  },

  /**
   * Mitglied entfernen bzw. Gruppe verlassen (actor === target).
   * Ergebnis: deleted = Gruppe ohne Mitglieder wurde gelöscht.
   */
  removeMember(conversationId: string, actorId: string, targetId: string): { deleted: boolean; message: ChatMessage | null } {
    const actor = this.requireMember(conversationId, actorId);
    const c = this.conversationRow(conversationId);
    if (c.kind !== 'group') throw new BadRequestError('Direktnachrichten können nicht verlassen werden');
    const leaving = actorId === targetId;
    if (!leaving && actor.role !== 'owner') throw new AppError(403, 'forbidden', 'Nur Gruppen-Admins können Mitglieder entfernen');
    if (!this.member(conversationId, targetId)) throw new NotFoundError('Mitglied');

    let deleted = false;
    let message: ChatMessage | null = null;
    db().transaction(() => {
      db().prepare('DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ?').run(conversationId, targetId);
      const rest = db().prepare('SELECT * FROM chat_members WHERE conversation_id = ? ORDER BY joined_at').all(conversationId) as MemberRow[];
      if (!rest.length) {
        this.deleteConversation(conversationId);
        deleted = true;
        return;
      }
      // Ohne Admin bleibt keine Gruppe zurück: dienstältestes Mitglied übernimmt
      if (!rest.some((m) => m.role === 'owner')) {
        db().prepare(`UPDATE chat_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?`).run(conversationId, rest[0]!.user_id);
      }
      message = this.addSystemMessage(conversationId, leaving ? { action: 'left', actorId } : { action: 'removed', actorId, userIds: [targetId] });
    })();
    return { deleted, message };
  },

  setRole(conversationId: string, actorId: string, targetId: string, role: 'owner' | 'member') {
    const actor = this.requireMember(conversationId, actorId);
    if (actor.role !== 'owner') throw new AppError(403, 'forbidden', 'Nur Gruppen-Admins können Rollen ändern');
    if (!this.member(conversationId, targetId)) throw new NotFoundError('Mitglied');
    if (role === 'member') {
      const owners = (db().prepare(`SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = ? AND role = 'owner'`).get(conversationId) as { n: number }).n;
      const target = this.member(conversationId, targetId)!;
      if (target.role === 'owner' && owners <= 1) throw new BadRequestError('Eine Gruppe braucht mindestens einen Admin');
    }
    db().prepare('UPDATE chat_members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(role, conversationId, targetId);
  },

  deleteConversation(conversationId: string) {
    removeFiles('conversation_id = ?', conversationId);
    db().prepare('DELETE FROM chat_conversations WHERE id = ?').run(conversationId);
  },

  /** Gruppen ohne Mitglieder (z. B. nach dem Löschen von Benutzern) entfernen */
  cleanupOrphans(): number {
    const rows = db()
      .prepare('SELECT id FROM chat_conversations c WHERE NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = c.id)')
      .all() as { id: string }[];
    for (const r of rows) this.deleteConversation(r.id);
    return rows.length;
  },

  /* ─────────── Nachrichten ─────────── */

  maxSeq(conversationId: string): number {
    return (db().prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM chat_messages WHERE conversation_id = ?').get(conversationId) as { s: number }).s;
  },

  messages(conversationId: string, opts: { before?: number; limit?: number }): { items: ChatMessage[]; hasMore: boolean } {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 200);
    const rows = db()
      .prepare(
        `SELECT * FROM chat_messages WHERE conversation_id = ? ${opts.before ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...(opts.before ? [conversationId, opts.before, limit + 1] : [conversationId, limit + 1])) as MsgRow[];
    const hasMore = rows.length > limit;
    return { items: hydrate(rows.slice(0, limit).reverse()), hasMore };
  },

  message(id: string): ChatMessage {
    const r = messageRow(id);
    if (!r) throw new NotFoundError('Nachricht');
    return hydrate([r])[0]!;
  },

  addSystemMessage(conversationId: string, event: ChatSystemEvent): ChatMessage {
    const id = uuid();
    const ts = now();
    db()
      .prepare(`INSERT INTO chat_messages (id, conversation_id, user_id, kind, body, created_at) VALUES (?, ?, NULL, 'system', ?, ?)`)
      .run(id, conversationId, JSON.stringify(event), ts);
    db().prepare('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);
    return this.message(id);
  },

  /** Systemnachricht nachträglich ändern (z. B. Anruf-Karte bei Anrufende) */
  updateSystemMessage(id: string, event: ChatSystemEvent): ChatMessage {
    db().prepare(`UPDATE chat_messages SET body = ? WHERE id = ? AND kind = 'system'`).run(JSON.stringify(event), id);
    return this.message(id);
  },

  send(conversationId: string, userId: string, input: { body: string; replyToId?: string | null; uploadIds?: string[] }): ChatMessage {
    this.requireMember(conversationId, userId);
    const body = input.body.replace(/\s+$/, '').replace(/^\s*\n/, '');
    const uploadIds = [...new Set(input.uploadIds ?? [])];
    if (!body.trim() && !uploadIds.length) throw new BadRequestError('Leere Nachricht');
    if (body.length > MAX_BODY) throw new BadRequestError(`Nachricht zu lang (max. ${MAX_BODY} Zeichen)`);
    if (uploadIds.length > MAX_ATTACHMENTS) throw new BadRequestError(`Höchstens ${MAX_ATTACHMENTS} Dateien pro Nachricht`);
    let replyTo: string | null = null;
    if (input.replyToId) {
      const target = messageRow(input.replyToId);
      if (!target || target.conversation_id !== conversationId) throw new BadRequestError('Bezugsnachricht nicht gefunden');
      replyTo = target.id;
    }
    // Uploads vorab lesen (wirft 404 bei fremden/abgelaufenen IDs, bevor etwas gespeichert wird)
    const files = uploadIds.map((id) => ({ uploadId: id, ...uploads.get(userId, id) }));

    const id = uuid();
    const ts = now();
    const written: string[] = [];
    try {
      db().transaction(() => {
        const res = db()
          .prepare(`INSERT INTO chat_messages (id, conversation_id, user_id, kind, body, reply_to, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?)`)
          .run(id, conversationId, userId, body, replyTo, ts);
        const seq = Number(res.lastInsertRowid);
        for (const f of files) {
          const fileId = uuid();
          fs.writeFileSync(path.join(fileDir, fileId), f.data);
          written.push(fileId);
          db()
            .prepare('INSERT INTO chat_files (id, conversation_id, message_id, user_id, filename, content_type, size) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(fileId, conversationId, id, userId, f.filename, f.contentType, f.data.length);
        }
        db().prepare('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);
        // Eigene Nachricht gilt als gelesen
        db().prepare('UPDATE chat_members SET last_read_seq = MAX(last_read_seq, ?) WHERE conversation_id = ? AND user_id = ?').run(seq, conversationId, userId);
      })();
    } catch (err) {
      for (const f of written) fs.rmSync(path.join(fileDir, f), { force: true });
      throw err;
    }
    for (const f of files) uploads.delete(userId, f.uploadId);
    return this.message(id);
  },

  /** Prüft, ob der Benutzer die Nachricht ändern/löschen darf */
  editable(messageId: string, userId: string, mode: 'edit' | 'delete'): MsgRow {
    const r = messageRow(messageId);
    if (!r) throw new NotFoundError('Nachricht');
    const member = this.requireMember(r.conversation_id, userId);
    if (r.kind !== 'text' || r.deleted_at) throw new BadRequestError('Diese Nachricht kann nicht geändert werden');
    const own = r.user_id === userId;
    // Gruppen-Admins dürfen fremde Nachrichten löschen (Moderation), aber nicht bearbeiten
    if (!own && !(mode === 'delete' && member.role === 'owner')) throw new AppError(403, 'forbidden', 'Nur eigene Nachrichten können geändert werden');
    return r;
  },

  edit(messageId: string, userId: string, body: string): ChatMessage {
    const r = this.editable(messageId, userId, 'edit');
    const text = body.replace(/\s+$/, '');
    if (text.length > MAX_BODY) throw new BadRequestError(`Nachricht zu lang (max. ${MAX_BODY} Zeichen)`);
    const hasFiles = !!db().prepare('SELECT 1 FROM chat_files WHERE message_id = ?').get(r.id);
    if (!text.trim() && !hasFiles) throw new BadRequestError('Leere Nachricht – zum Entfernen bitte löschen');
    if (text !== r.body) db().prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?').run(text, now(), r.id);
    return this.message(r.id);
  },

  delete(messageId: string, userId: string): ChatMessage {
    const r = this.editable(messageId, userId, 'delete');
    db().transaction(() => {
      removeFiles('message_id = ?', r.id);
      db().prepare('DELETE FROM chat_reactions WHERE message_id = ?').run(r.id);
      db().prepare(`UPDATE chat_messages SET body = '', deleted_at = ? WHERE id = ?`).run(now(), r.id);
    })();
    return this.message(r.id);
  },

  toggleReaction(messageId: string, userId: string, emoji: string): ChatMessage {
    const r = messageRow(messageId);
    if (!r) throw new NotFoundError('Nachricht');
    this.requireMember(r.conversation_id, userId);
    if (r.deleted_at || r.kind !== 'text') throw new BadRequestError('Auf diese Nachricht kann nicht reagiert werden');
    const exists = db().prepare('SELECT 1 FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(r.id, userId, emoji);
    if (exists) db().prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(r.id, userId, emoji);
    else {
      const count = (db().prepare('SELECT COUNT(DISTINCT emoji) AS n FROM chat_reactions WHERE message_id = ?').get(r.id) as { n: number }).n;
      if (count >= 20) throw new BadRequestError('Zu viele verschiedene Reaktionen');
      db().prepare('INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(r.id, userId, emoji);
    }
    return this.message(r.id);
  },

  /** Lesestand setzen (nur vorwärts). Liefert den neuen Stand oder null, wenn unverändert. */
  markRead(conversationId: string, userId: string, seq?: number): number | null {
    const m = this.requireMember(conversationId, userId);
    const max = this.maxSeq(conversationId);
    const target = Math.min(seq ?? max, max);
    if (target <= m.last_read_seq) return null;
    db().prepare('UPDATE chat_members SET last_read_seq = ? WHERE conversation_id = ? AND user_id = ?').run(target, conversationId, userId);
    return target;
  },

  search(userId: string, q: string, limit = 40): ChatMessage[] {
    const term = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db()
      .prepare(
        `SELECT x.* FROM chat_messages x
         JOIN chat_members m ON m.conversation_id = x.conversation_id AND m.user_id = ?
         WHERE x.kind = 'text' AND x.deleted_at IS NULL AND x.body LIKE ? ESCAPE '\\'
         ORDER BY x.seq DESC LIMIT ?`,
      )
      .all(userId, term, limit) as MsgRow[];
    return hydrate(rows);
  },

  /* ─────────── Dateien ─────────── */

  file(fileId: string, userId: string): { filename: string; contentType: string; data: Buffer } {
    const f = db().prepare('SELECT * FROM chat_files WHERE id = ?').get(fileId) as
      | { id: string; conversation_id: string; filename: string; content_type: string }
      | undefined;
    if (!f || !this.member(f.conversation_id, userId)) throw new NotFoundError('Datei');
    const file = path.join(fileDir, f.id);
    if (!fs.existsSync(file)) throw new NotFoundError('Datei');
    return { filename: f.filename, contentType: f.content_type, data: fs.readFileSync(file) };
  },
};
