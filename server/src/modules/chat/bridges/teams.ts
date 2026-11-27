/**
 * Microsoft-Teams-Brücke (Microsoft Graph, Chats – keine Team-Kanäle).
 * Nutzt ein vorhandenes Microsoft-365-Konto des Benutzers; dafür braucht Kuvert die
 * delegierte Berechtigung Chat.ReadWrite (inkrementelle Zustimmung beim Verbinden oder
 * Administratorzustimmung über die automatisch eingerichtete App).
 *
 * Graph-Änderungsbenachrichtigungen bräuchten einen öffentlich erreichbaren Webhook –
 * deshalb wird wie bei Nextcloud Talk abgefragt: die Chatliste alle 15 s bei geöffnetem
 * Browser (sonst jede Minute), gerade geöffnete Unterhaltungen alle paar Sekunden.
 */
import type { ChatAttachment, ChatCapabilities, ChatConversation, ChatMember, ChatMessage, ChatMessagePage, ChatReaction, ChatUser } from '@kuvert/shared';
import { mentionHandle } from '@kuvert/shared';
import { AppError, AuthError, BadRequestError, HttpError, NotFoundError } from '../../../core/errors.js';
import type { AccountService } from '../../../core/accounts.js';
import { GraphClient, enc, qs } from '../../microsoft/graph.js';
import { BridgeBase, type BinaryFile, type BridgeHost, type ChatBridge, type ConnectionRecord } from './common.js';

/* ───────────────────────────── Typen der API ───────────────────────────── */

interface GIdentitySet {
  user?: { id?: string | null; displayName?: string | null } | null;
  application?: { id?: string | null; displayName?: string | null } | null;
}

interface GMember {
  id: string;
  displayName?: string | null;
  userId?: string | null;
  email?: string | null;
  roles?: string[];
}

/** Erwähnung beim Senden (Graph chatMessageMention) */
interface GMentionOut {
  id: number;
  mentionText: string;
  mentioned: { user: { id: string; displayName: string; userIdentityType: 'aadUser' } };
}

interface GPreview {
  id: string;
  createdDateTime: string;
  isDeleted?: boolean;
  messageType?: string;
  body?: { contentType?: string; content?: string } | null;
  from?: GIdentitySet | null;
  eventDetail?: Record<string, unknown> | null;
}

interface GChat {
  id: string;
  topic?: string | null;
  createdDateTime: string;
  lastUpdatedDateTime?: string | null;
  chatType: 'oneOnOne' | 'group' | 'meeting' | string;
  webUrl?: string | null;
  /** Nur Besprechungschats */
  onlineMeetingInfo?: { joinWebUrl?: string | null } | null;
  viewpoint?: { isHidden?: boolean; lastMessageReadDateTime?: string | null } | null;
  members?: GMember[];
  lastMessagePreview?: GPreview | null;
}

interface GAttachment {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  content?: string | null;
  name?: string | null;
}

interface GMention {
  id: number;
  mentionText?: string;
  mentioned?: { user?: { id?: string | null } | null; conversation?: { id?: string } | null; tag?: unknown } | null;
}

interface GReaction {
  reactionType: string;
  displayName?: string | null;
  createdDateTime?: string;
  user?: { user?: { id?: string | null } | null } | null;
}

interface GMessage {
  id: string;
  messageType: string;
  createdDateTime: string;
  lastModifiedDateTime?: string | null;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  chatId?: string | null;
  from?: GIdentitySet | null;
  body?: { contentType?: string; content?: string } | null;
  attachments?: GAttachment[];
  mentions?: GMention[];
  reactions?: GReaction[];
  eventDetail?: Record<string, unknown> | null;
}

/* ───────────────────────────── Konstanten ───────────────────────────── */

const FAST_POLL = 15_000;
const SLOW_POLL = 60_000;
const HOT_POLL = 4_000;
const HOT_MS = 5 * 60_000;
const MAX_CHATS = 100;

const CAPS: ChatCapabilities = { edit: true, delete: true, react: true, reply: true, files: false, typing: false, readReceipts: false, manage: false, calls: true };

/** Ältere Teams-Reaktionen tragen Namen statt Emojis */
const LEGACY_REACTIONS: Record<string, string> = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😡' };
const LEGACY_BY_EMOJI = new Map(Object.entries(LEGACY_REACTIONS).map(([k, v]) => [v.replace(/️/g, ''), k]));

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Zeitpunkt a liegt nach b (ISO-Strings mit unterschiedlicher Genauigkeit) */
const isAfter = (a: string, b: string) => (Date.parse(a) || 0) > (Date.parse(b) || 0);

const typeOf = (name: string) => IMAGE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * GIF-Anbieter der Teams-GIF-Auswahl. Diese Bilder liegen nicht bei Microsoft, sondern
 * werden per <img src="https://media.giphy.com/…"> eingebunden. Kuvert lädt sie über den
 * Server (kein Referrer/IP des Benutzers an den Anbieter) – nur von diesen Hosts, weil die
 * Datei-ID nicht signiert ist.
 */
const GIF_HOSTS = /^(?:[a-z0-9-]+\.)*(?:giphy\.com|tenor\.com|tenor\.googleapis\.com)$/i;
const MAX_GIF_BYTES = 25 * 1024 * 1024;

function isGifUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && GIF_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Bildtyp anhand der ersten Bytes (Graph liefert hostedContents teils als octet-stream) */
function sniffImage(data: Buffer): string | null {
  if (data.length >= 6 && data.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (data.length >= 8 && data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Lädt ein GIF von einem erlaubten Anbieter; Weiterleitungen nur zu erlaubten Hosts */
async function fetchGif(src: string): Promise<{ data: Buffer; contentType: string }> {
  let url = src;
  for (let hop = 0; hop < 4; hop++) {
    if (!isGifUrl(url)) break;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { Accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) break;
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(404, 'GIF nicht (mehr) verfügbar');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_GIF_BYTES) throw new HttpError(413, 'GIF zu groß');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_GIF_BYTES) throw new HttpError(413, 'GIF zu groß');
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const type = sniffImage(data) ?? (/^image\//.test(ct) && !ct.includes('svg') ? ct : null);
    if (!type) throw new HttpError(404, 'GIF nicht (mehr) verfügbar');
    return { data, contentType: type };
  }
  throw new NotFoundError('Datei');
}

/* ───────────────────────────── HTML ⇄ Markdown ───────────────────────────── */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1];

/** Teams-HTML → Chat-Markdown (Erwähnungen, Formatierung, Links, Emojis) */
export function teamsHtmlToMarkdown(html: string): string {
  let s = html
    .replace(/\r/g, '')
    .replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/gi, '')
    .replace(/<(emoji|img)\b[^>]*>(?:<\/emoji>)?/gi, (tag) => {
      const alt = attr(tag, 'alt');
      return /emoji/i.test(tag) && alt ? alt : '';
    })
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_, name: string) => `@${name.replace(/<[^>]+>/g, '')}`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${code.replace(/<[^>]+>/g, '')}\``)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs: string, text: string) => {
      const href = attr(` ${attrs}`, 'href');
      const label = text.replace(/<[^>]+>/g, '').trim();
      if (!href || !/^https?:/i.test(decodeEntities(href))) return label;
      const url = decodeEntities(href);
      return !label || decodeEntities(label) === url ? url : `[${label}](${url})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => (t.trim() ? `**${t}**` : t))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => (t.trim() ? `_${t}_` : t))
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => (t.trim() ? `~~${t}~~` : t))
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t: string) => {
      const inner = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      return `\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function inlineToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^\n]+?)~~/g, '<s>$1</s>')
    .replace(/(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\w_])/g, '<em>$1</em>');
}

/** Chat-Markdown → einfaches HTML für Teams */
export function markdownToTeamsHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre>${escapeHtml(part.replace(/^\n/, '').replace(/\n$/, ''))}</pre>`);
      return;
    }
    const lines = part.split('\n');
    const html: string[] = [];
    let quote: string[] = [];
    const flush = () => {
      if (quote.length) html.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = [];
    };
    for (const line of lines) {
      const q = /^>\s?(.*)$/.exec(line);
      if (q) {
        quote.push(inlineToHtml(q[1]!));
        continue;
      }
      flush();
      html.push(inlineToHtml(line));
    }
    flush();
    out.push(html.join('<br>').replace(/(<br>)?(<blockquote>)/g, '$2').replace(/(<\/blockquote>)<br>/g, '$1'));
  });
  return out.join('');
}

/* ───────────────────────────── Einrichtung ───────────────────────────── */

/** Fehlende Berechtigung für Teams-Chats → Client bietet die Zustimmung an */
export class TeamsConsentError extends AppError {
  constructor(accountId: string) {
    super(
      403,
      'teams_consent',
      'Kuvert darf noch nicht auf deine Teams-Chats zugreifen. Bitte bei Microsoft anmelden und die Berechtigung „Chats lesen und schreiben“ erteilen.',
      { accountId },
    );
    this.name = 'TeamsConsentError';
  }
}

/** Graph-Zugang über ein Microsoft-Konto des Benutzers (liefert immer den aktuellen Kontostand) */
export function teamsGraph(accounts: AccountService, accountId: string): GraphClient {
  const acc = accounts.findById(accountId);
  if (!acc) throw new BadRequestError('Das Microsoft-Konto dieser Teams-Verbindung wurde entfernt');
  if (acc.type !== 'microsoft') throw new BadRequestError('Das gewählte Konto ist kein Microsoft-365-Konto');
  if (!acc.enabled) throw new BadRequestError(`Das Microsoft-Konto „${acc.name}“ ist deaktiviert`);
  return new GraphClient(accounts.contextFor(acc.id));
}

export async function setupTeams(accounts: AccountService, userId: string, accountId: string) {
  const acc = accounts.get(userId, accountId);
  if (acc.type !== 'microsoft') throw new BadRequestError('Bitte ein Microsoft-365-Konto wählen');
  const graph = teamsGraph(accounts, acc.id);
  const me = await graph.json<{ id: string; displayName?: string; mail?: string | null; userPrincipalName?: string }>(
    `/me${qs({ $select: 'id,displayName,mail,userPrincipalName' })}`,
  );
  try {
    await graph.json(`/me/chats${qs({ $top: 1 })}`, { retries: 1 });
  } catch (err) {
    if (err instanceof AppError && (err.status === 403 || err.status === 401)) throw new TeamsConsentError(acc.id);
    if (err instanceof AppError && err.status === 400 && !acc.config.tenantId) {
      throw new BadRequestError('Teams-Chats gibt es nur für Geschäfts- und Schulkonten (Microsoft 365), nicht für private Microsoft-Konten');
    }
    throw err;
  }
  // Ab jetzt die Chat-Berechtigung beim Token-Refresh mit anfragen
  const features = Array.isArray(acc.config.oauthFeatures) ? (acc.config.oauthFeatures as unknown[]).map(String) : [];
  if (!features.includes('chat')) accounts.contextFor(acc.id).setConfig({ oauthFeatures: [...features, 'chat'] });
  return {
    baseUrl: 'https://teams.microsoft.com',
    username: me.mail || me.userPrincipalName || acc.email,
    displayName: me.displayName || acc.name,
    remoteUserId: me.id,
    secrets: {},
    config: { accountId: acc.id, tenantId: acc.config.tenantId ?? null },
  };
}

/* ───────────────────────────── Brücke ───────────────────────────── */

interface ChatState {
  /** Zeitpunkt der neuesten bekannten Nachricht (ms) */
  lastCreated: number;
  /** Neueste bekannte Änderung (ISO, für $filter) */
  lastModified: string;
  previewId: string | null;
  unread: number;
}

export class TeamsBridge extends BridgeBase implements ChatBridge {
  capabilities = CAPS;
  private chats = new Map<string, GChat>();
  private state = new Map<string, ChatState>();
  private hot = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private cache = new Map<string, GMessage>();
  private timer: NodeJS.Timeout | null = null;
  private hotTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private initialized = false;
  private polling = false;

  constructor(
    conn: ConnectionRecord,
    host: BridgeHost,
    private graphFactory: () => GraphClient,
  ) {
    super(conn, host);
  }

  private graphClient: GraphClient | null = null;

  private get graph(): GraphClient {
    this.graphClient ??= this.graphFactory();
    return this.graphClient;
  }

  private call<T>(fn: (g: GraphClient) => Promise<T>): Promise<T> {
    return fn(this.graph);
  }

  /** Verständlicher Status für die Verbindungsübersicht */
  private statusText(err: unknown): string {
    if (err instanceof AuthError) return 'Anmeldung bei Microsoft abgelaufen – bitte das Microsoft-Konto unter Einstellungen → Konten neu verbinden';
    if (err instanceof AppError && err.status === 403) return 'Berechtigung für Teams-Chats fehlt – bitte die Teams-Verbindung entfernen und neu einrichten';
    return (err as Error).message;
  }

  private get tenantId(): string | null {
    return typeof this.conn.config.tenantId === 'string' ? this.conn.config.tenantId : null;
  }

  /* ─────────── Abbildung ─────────── */

  private seqOf(m: { id: string; createdDateTime: string }): number {
    const n = Number(m.id);
    return Number.isFinite(n) && n > 1e11 ? n : Date.parse(m.createdDateTime) || 0;
  }

  private senderOf(from: GIdentitySet | null | undefined): { id: string | null; name: string | null } {
    if (from?.user?.id) return { id: this.uid(from.user.id), name: from.user.displayName ?? null };
    if (from?.application?.id) return { id: this.uid(`app/${from.application.id}`), name: from.application.displayName ?? 'App' };
    return { id: null, name: null };
  }

  private systemText(m: { eventDetail?: Record<string, unknown> | null }): string {
    const d = m.eventDetail ?? {};
    const type = String(d['@odata.type'] ?? '').replace('#microsoft.graph.', '');
    const names = (list: unknown) =>
      (Array.isArray(list) ? list : [])
        .map((x) => (x as { displayName?: string })?.displayName)
        .filter(Boolean)
        .join(', ');
    switch (type) {
      case 'membersAddedEventMessageDetail':
        return `${names(d.members) || 'Personen'} hinzugefügt`;
      case 'membersDeletedEventMessageDetail':
        return `${names(d.members) || 'Personen'} entfernt`;
      case 'membersJoinedEventMessageDetail':
        return `${names(d.members) || 'Personen'} beigetreten`;
      case 'membersLeftEventMessageDetail':
        return `${names(d.members) || 'Personen'} hat den Chat verlassen`;
      case 'chatRenamedEventMessageDetail':
        return `Chat umbenannt in „${String(d.chatDisplayName ?? '')}“`;
      case 'callStartedEventMessageDetail':
        return 'Anruf gestartet';
      case 'callEndedEventMessageDetail':
        return 'Anruf beendet';
      case 'callRecordingEventMessageDetail':
        return 'Aufzeichnung verfügbar';
      case 'callTranscriptEventMessageDetail':
        return 'Transkript verfügbar';
      case 'meetingPolicyUpdatedEventMessageDetail':
        return 'Besprechungsrichtlinie geändert';
      case 'messagePinnedEventMessageDetail':
        return 'Nachricht angeheftet';
      case 'messageUnpinnedEventMessageDetail':
        return 'Nachricht nicht mehr angeheftet';
      case 'teamsAppInstalledEventMessageDetail':
        return 'App hinzugefügt';
      case 'teamsAppRemovedEventMessageDetail':
        return 'App entfernt';
      default:
        return 'Ereignis in Teams';
    }
  }

  private reactions(list: GReaction[] | undefined): ChatReaction[] {
    const by = new Map<string, string[]>();
    for (const r of list ?? []) {
      const emoji = LEGACY_REACTIONS[r.reactionType] ?? r.reactionType;
      const uid = this.uid(r.user?.user?.id);
      const arr = by.get(emoji) ?? [];
      if (uid && !arr.includes(uid)) arr.push(uid);
      by.set(emoji, arr);
    }
    return [...by.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
  }

  private toMessage(m: GMessage, chatId: string): ChatMessage | null {
    if (m.messageType !== 'message' && m.messageType !== 'systemEventMessage') return null;
    this.remember(chatId, m);
    const system = m.messageType === 'systemEventMessage';
    const deleted = !!m.deletedDateTime;
    const html = m.body?.content ?? '';
    const isHtml = (m.body?.contentType ?? 'html') === 'html';
    const sender = this.senderOf(m.from);
    const attachments: ChatAttachment[] = [];
    let replyTo: ChatMessage['replyTo'] = null;
    let extra = '';
    if (!deleted && !system) {
      // Eingebettete Bilder (hostedContents) und GIFs aus der Teams-GIF-Auswahl (Giphy)
      for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
        const src = decodeEntities(attr(tag, 'src') ?? '');
        if (/^https:\/\/graph\.microsoft\.com\/[^\s]*hostedContents\//i.test(src)) {
          const n = attachments.length + 1;
          attachments.push({ id: this.fileId(JSON.stringify({ k: 'h', u: src, n: `Bild ${n}.png`, m: 'image/png' })), filename: `Bild ${n}.png`, contentType: 'image/png', size: 0 });
        } else if (isGifUrl(src)) {
          const alt = decodeEntities(attr(tag, 'alt') ?? '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 80);
          const name = `${alt || 'GIF'}.gif`;
          attachments.push({ id: this.fileId(JSON.stringify({ k: 'g', u: src, n: name, m: 'image/gif' })), filename: name, contentType: 'image/gif', size: 0 });
        }
      }
      for (const a of m.attachments ?? []) {
        const ct = a.contentType ?? '';
        if (ct === 'messageReference' && a.content) {
          try {
            const ref = JSON.parse(a.content) as { messageId?: string; messagePreview?: string; messageSender?: GIdentitySet };
            if (ref.messageId) {
              replyTo = {
                id: this.msgId(chatId, ref.messageId),
                senderId: this.senderOf(ref.messageSender).id,
                body: (ref.messagePreview ?? '').slice(0, 280),
                deleted: false,
                hasAttachments: false,
              };
            }
          } catch {
            /* ignorieren */
          }
        } else if (ct === 'reference' && a.contentUrl) {
          const name = a.name || 'Datei';
          attachments.push({ id: this.fileId(JSON.stringify({ k: 'r', u: a.contentUrl, n: name, m: typeOf(name) })), filename: name, contentType: typeOf(name), size: 0 });
        } else if (ct.startsWith('application/vnd.microsoft.card')) {
          extra = '_[Karte – in Teams öffnen]_';
        } else if (ct.startsWith('image/') && a.contentUrl) {
          const name = a.name || 'Bild';
          attachments.push({ id: this.fileId(JSON.stringify({ k: 'r', u: a.contentUrl, n: name, m: ct })), filename: name, contentType: ct, size: 0 });
        }
      }
    }
    const text = deleted ? '' : isHtml ? teamsHtmlToMarkdown(html) : html.trim();
    const mention = (m.mentions ?? []).some((x) => x.mentioned?.user?.id === this.conn.remoteUserId || !!x.mentioned?.conversation || !!x.mentioned?.tag);
    return {
      id: this.msgId(chatId, m.id),
      seq: this.seqOf(m),
      conversationId: this.convId(chatId),
      senderId: system ? null : sender.id,
      kind: system ? 'system' : 'text',
      body: system ? JSON.stringify({ action: 'text', actorId: sender.id ?? '', text: this.systemText(m) }) : [text, extra].filter(Boolean).join('\n'),
      createdAt: m.createdDateTime,
      editedAt: m.lastEditedDateTime ?? null,
      deleted,
      replyTo,
      attachments: deleted ? [] : attachments,
      reactions: deleted ? [] : this.reactions(m.reactions),
      senderName: sender.name,
      mention: (!system && mention) || undefined,
    };
  }

  private previewMessage(p: GPreview, chatId: string): ChatMessage {
    const system = p.messageType === 'systemEventMessage';
    const sender = this.senderOf(p.from);
    const html = p.body?.content ?? '';
    const text = (p.body?.contentType ?? 'html') === 'html' ? teamsHtmlToMarkdown(html) : html.trim();
    return {
      id: this.msgId(chatId, p.id),
      seq: this.seqOf(p),
      conversationId: this.convId(chatId),
      senderId: system ? null : sender.id,
      kind: system ? 'system' : 'text',
      body: system ? JSON.stringify({ action: 'text', actorId: sender.id ?? '', text: this.systemText(p) }) : text || (/<img\b/i.test(html) ? '🖼️ Bild' : /<attachment\b/i.test(html) ? '📎 Anhang' : ''),
      createdAt: p.createdDateTime,
      deleted: !!p.isDeleted,
      attachments: [],
      reactions: [],
      senderName: sender.name,
    };
  }

  private remember(chatId: string, m: GMessage) {
    const key = `${chatId}/${m.id}`;
    this.cache.delete(key);
    this.cache.set(key, m);
    if (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value!);
  }

  private others(c: GChat): GMember[] {
    return (c.members ?? []).filter((m) => m.userId && m.userId !== this.conn.remoteUserId);
  }

  private chatName(c: GChat): string {
    if (c.topic) return c.topic;
    const others = this.others(c);
    if (c.chatType === 'oneOnOne') return others[0]?.displayName || 'Teams-Chat';
    const names = others.map((m) => (m.displayName ?? '').split(' ')[0]).filter(Boolean);
    if (!names.length) return c.chatType === 'meeting' ? 'Besprechung' : 'Gruppenchat';
    return names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4}` : names.join(', ');
  }

  /**
   * Anruf starten: Besprechungschats treten der Besprechung bei, sonst ruft der Teams-Deep-Link
   * die anderen Mitglieder an (öffnet die Teams-App bzw. Teams im Browser). Ohne E-Mail-Adressen
   * bleibt nur der Chat selbst.
   */
  private callUrl(c: GChat, others: GMember[]): string | null {
    if (c.chatType === 'meeting') return c.onlineMeetingInfo?.joinWebUrl || c.webUrl || null;
    const emails = others.map((m) => m.email?.trim()).filter((e): e is string => !!e && e.includes('@'));
    if (!emails.length || emails.length !== others.length) return c.webUrl ?? null;
    return `https://teams.microsoft.com/l/call/0/0?users=${emails.slice(0, 20).map(encodeURIComponent).join(',')}`;
  }

  private lastRead(c: GChat): number {
    return Date.parse(c.viewpoint?.lastMessageReadDateTime ?? '') || 0;
  }

  /** Ungelesen laut Teams (ohne Zähler: 1, wenn die letzte fremde Nachricht nach dem Lesestand liegt) */
  private unreadGuess(c: GChat): number {
    const p = c.lastMessagePreview;
    if (!p || p.isDeleted || p.messageType === 'systemEventMessage') return 0;
    if (p.from?.user?.id === this.conn.remoteUserId) return 0;
    return Date.parse(p.createdDateTime) > this.lastRead(c) ? 1 : 0;
  }

  private toConversation(c: GChat): ChatConversation {
    const direct = c.chatType === 'oneOnOne';
    const others = this.others(c);
    const me = (c.members ?? []).find((m) => m.userId === this.conn.remoteUserId);
    const members: ChatMember[] = [
      { userId: this.me, role: me?.roles?.includes('owner') ? 'owner' : 'member', lastReadSeq: this.lastRead(c), joinedAt: c.createdDateTime },
      ...others.slice(0, 50).map((m) => ({ userId: this.uid(m.userId)!, role: 'member' as const, lastReadSeq: 0, joinedAt: c.createdDateTime })),
    ];
    const participants: ChatUser[] = others.slice(0, 50).map((m) => ({
      id: this.uid(m.userId)!,
      name: m.displayName || m.email || 'Unbekannt',
      email: m.email ?? '',
      avatarUrl: this.avatarUrl(m.userId!),
      online: false,
    }));
    const st = this.state.get(c.id);
    return {
      id: this.convId(c.id),
      kind: direct ? 'direct' : 'group',
      name: this.chatName(c),
      description: null,
      createdAt: c.createdDateTime,
      lastMessageAt: c.lastMessagePreview?.createdDateTime ?? c.lastUpdatedDateTime ?? c.createdDateTime,
      members,
      lastMessage: c.lastMessagePreview ? this.previewMessage(c.lastMessagePreview, c.id) : null,
      unread: st ? st.unread : this.unreadGuess(c),
      muted: false,
      pinned: false,
      myRole: members[0]!.role,
      source: this.source(c.chatType === 'meeting' ? 'Besprechung' : null, c.webUrl ?? null, this.callUrl(c, others)),
      capabilities: CAPS,
      memberCount: (c.members ?? []).length || null,
      participants,
    };
  }

  /* ─────────── Unterhaltungen ─────────── */

  private visible(c: GChat): boolean {
    if (c.viewpoint?.isHidden) return false;
    // Besprechungschats ohne Nachrichten weglassen (Teams zeigt sie ebenfalls nicht)
    return c.chatType !== 'meeting' || !!c.lastMessagePreview;
  }

  private async fetchChats(): Promise<GChat[]> {
    return this.call(async (g) => {
      const base = { $top: 50, $orderby: 'lastMessagePreview/createdDateTime desc' };
      let list: GChat[];
      try {
        list = await g.all<GChat>(`/me/chats${qs({ ...base, $expand: 'members,lastMessagePreview' })}`, undefined, MAX_CHATS);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 400) throw err;
        // Fallback, falls Graph die kombinierte Erweiterung ablehnt: Mitglieder einzeln nachladen
        list = await g.all<GChat>(`/me/chats${qs({ ...base, $expand: 'lastMessagePreview' })}`, undefined, MAX_CHATS);
        const res = await g.batch(list.map((c) => ({ id: c.id, method: 'GET' as const, url: `/chats/${enc(c.id)}/members` })));
        const byId = new Map(res.map((r) => [r.id, r]));
        for (const c of list) c.members = byId.get(c.id)?.status === 200 ? ((byId.get(c.id)!.body?.value ?? []) as GMember[]) : [];
      }
      return list.filter((c) => this.visible(c));
    });
  }

  async listConversations(): Promise<ChatConversation[]> {
    const list = await this.fetchChats();
    for (const c of list) this.chats.set(c.id, c);
    return list.map((c) => this.toConversation(c));
  }

  async getConversation(chatId: string): Promise<ChatConversation> {
    const c = await this.call((g) => g.json<GChat>(`/chats/${enc(chatId)}${qs({ $expand: 'members,lastMessagePreview' })}`)).catch((err) => {
      if (err instanceof AppError && err.status === 404) throw new NotFoundError('Unterhaltung');
      throw err;
    });
    this.chats.set(c.id, c);
    if (!this.state.has(c.id)) this.initState(c);
    return this.toConversation(c);
  }

  async members(chatId: string): Promise<ChatUser[]> {
    const list = await this.call((g) => g.all<GMember>(`/chats/${enc(chatId)}/members`, undefined, 500));
    return list
      .filter((m) => m.userId)
      .map((m) => ({
        id: this.uid(m.userId)!,
        name: m.displayName || m.email || 'Unbekannt',
        email: m.email ?? '',
        avatarUrl: this.avatarUrl(m.userId!),
        online: false,
        mention: mentionHandle(m.email),
      }));
  }

  /* ─────────── Nachrichten ─────────── */

  async messages(chatId: string, opts: { beforeId?: string; limit: number }): Promise<ChatMessagePage> {
    const top = Math.min(Math.max(opts.limit, 1), 50);
    let before: string | undefined;
    if (opts.beforeId) {
      const cached = this.cache.get(`${chatId}/${opts.beforeId}`);
      const n = Number(opts.beforeId);
      before = cached?.createdDateTime ?? (Number.isFinite(n) && n > 1e11 ? new Date(n).toISOString() : undefined);
    }
    const page = await this.call((g) =>
      g.page<GMessage>(
        `/chats/${enc(chatId)}/messages${qs({ $top: top, $orderby: 'createdDateTime desc', $filter: before ? `createdDateTime lt ${before}` : undefined })}`,
      ),
    );
    const raw = page.items.sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
    if (!opts.beforeId) {
      const st = this.state.get(chatId);
      const newest = raw[raw.length - 1];
      const fallback = st?.lastModified ?? newest?.createdDateTime ?? this.chats.get(chatId)?.createdDateTime ?? '2000-01-01T00:00:00Z';
      const maxMod = raw.reduce((acc, m) => (m.lastModifiedDateTime && isAfter(m.lastModifiedDateTime, acc) ? m.lastModifiedDateTime : acc), fallback);
      this.state.set(chatId, {
        lastCreated: Math.max(st?.lastCreated ?? 0, newest ? Date.parse(newest.createdDateTime) : 0),
        lastModified: maxMod,
        previewId: st?.previewId ?? newest?.id ?? null,
        unread: st?.unread ?? 0,
      });
    }
    this.markHot(chatId);
    return { items: raw.map((m) => this.toMessage(m, chatId)).filter((m): m is ChatMessage => !!m), hasMore: !!page.next || raw.length >= top };
  }

  private async getMessage(chatId: string, id: string, fresh = false): Promise<GMessage> {
    const cached = !fresh && this.cache.get(`${chatId}/${id}`);
    if (cached) return cached;
    return this.call((g) => g.json<GMessage>(`/chats/${enc(chatId)}/messages/${enc(id)}`)).catch((err) => {
      if (err instanceof AppError && err.status === 404) throw new NotFoundError('Nachricht');
      throw err;
    });
  }

  private reply(m: GMessage): { attachment: GAttachment; tag: string } {
    const refId = String(m.id);
    const preview = (m.deletedDateTime ? '' : teamsHtmlToMarkdown(m.body?.content ?? '')).slice(0, 200);
    return {
      attachment: {
        id: refId,
        contentType: 'messageReference',
        content: JSON.stringify({
          messageId: refId,
          messagePreview: preview,
          messageSender: { user: { id: m.from?.user?.id ?? null, displayName: m.from?.user?.displayName ?? null, userIdentityType: 'aadUser' } },
        }),
      },
      tag: `<attachment id="${escapeHtml(refId)}"></attachment>`,
    };
  }

  async send(chatId: string, input: { body: string; replyTo?: string | null; files: BinaryFile[] }): Promise<ChatMessage> {
    if (input.files.length) throw new BadRequestError('Dateien können in Teams-Chats aus Kuvert noch nicht gesendet werden');
    this.markHot(chatId);
    const { html, mentions } = await this.withMentions(chatId, markdownToTeamsHtml(input.body));
    const extra = mentions.length ? { mentions } : {};
    let sent: GMessage;
    const ref = input.replyTo ? await this.getMessage(chatId, input.replyTo).then((m) => this.reply(m)).catch(() => null) : null;
    try {
      sent = await this.call((g) =>
        g.json<GMessage>(`/chats/${enc(chatId)}/messages`, {
          method: 'POST',
          retries: 1,
          body: { body: { contentType: 'html', content: `${ref?.tag ?? ''}${html}` }, ...extra, ...(ref ? { attachments: [ref.attachment] } : {}) },
        }),
      );
    } catch (err) {
      if (!ref || !(err instanceof AppError) || err.status !== 400) throw err;
      // Zitat abgelehnt → ohne Bezug senden
      sent = await this.call((g) =>
        g.json<GMessage>(`/chats/${enc(chatId)}/messages`, { method: 'POST', retries: 1, body: { body: { contentType: 'html', content: html }, ...extra } }),
      );
    }
    const st = this.state.get(chatId);
    if (st) {
      st.lastCreated = Math.max(st.lastCreated, Date.parse(sent.createdDateTime) || 0);
      st.unread = 0;
    }
    const msg = this.toMessage(sent, chatId);
    if (!msg) throw new AppError(502, 'teams_send', 'Unerwartete Antwort von Microsoft Teams');
    return msg;
  }

  /** @kürzel (E-Mail-Name) von Chat-Mitgliedern in echte Teams-Erwähnungen umwandeln – nicht in Code und Tags */
  private async withMentions(chatId: string, html: string): Promise<{ html: string; mentions: GMentionOut[] }> {
    if (!html.includes('@')) return { html, mentions: [] };
    const list = await this.call((g) => g.all<GMember>(`/chats/${enc(chatId)}/members`, undefined, 500)).catch(() => [] as GMember[]);
    const byHandle = new Map<string, GMember>();
    for (const m of list) {
      const h = mentionHandle(m.email);
      if (h && m.userId && !byHandle.has(h)) byHandle.set(h, m);
    }
    if (!byHandle.size) return { html, mentions: [] };
    const mentions: GMentionOut[] = [];
    const out = html
      .split(/(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<[^>]+>)/)
      .map((part, i) =>
        i % 2
          ? part
          : part.replace(/(^|[^\w@./])@([\w+-]+(?:\.[\w+-]+)*)/g, (all, pre: string, handle: string) => {
              const m = byHandle.get(handle.toLowerCase());
              if (!m) return all;
              const name = m.displayName || m.email || handle;
              const id = mentions.length;
              mentions.push({ id, mentionText: name, mentioned: { user: { id: m.userId!, displayName: name, userIdentityType: 'aadUser' } } });
              return `${pre}<at id="${id}">${escapeHtml(name)}</at>`;
            }),
      )
      .join('');
    return { html: out, mentions };
  }

  async edit(chatId: string, messageId: string, body: string): Promise<ChatMessage> {
    const cur = await this.getMessage(chatId, messageId);
    // Zitat beim Bearbeiten erhalten
    const keep = (cur.body?.content ?? '').match(/<attachment\b[^>]*><\/attachment>/gi)?.join('') ?? '';
    await this.call((g) =>
      g.raw(`/chats/${enc(chatId)}/messages/${enc(messageId)}`, {
        method: 'PATCH',
        retries: 1,
        body: { body: { contentType: 'html', content: `${keep}${markdownToTeamsHtml(body)}` }, ...(keep ? { attachments: cur.attachments ?? [] } : {}) },
      }),
    );
    return this.toMessage(await this.getMessage(chatId, messageId, true), chatId)!;
  }

  async delete(chatId: string, messageId: string): Promise<ChatMessage> {
    await this.call((g) => g.raw(`/me/chats/${enc(chatId)}/messages/${enc(messageId)}/softDelete`, { method: 'POST', retries: 1 }));
    const m = await this.getMessage(chatId, messageId, true).catch(() => null);
    const base = m ?? this.cache.get(`${chatId}/${messageId}`);
    if (!base) throw new NotFoundError('Nachricht');
    return this.toMessage({ ...base, deletedDateTime: base.deletedDateTime ?? new Date().toISOString() }, chatId)!;
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<ChatMessage> {
    const cur = await this.getMessage(chatId, messageId, true);
    const plain = emoji.replace(/️/g, '');
    const legacy = LEGACY_BY_EMOJI.get(plain);
    const mine = (cur.reactions ?? []).find(
      (r) => r.user?.user?.id === this.conn.remoteUserId && (r.reactionType === emoji || r.reactionType.replace(/️/g, '') === plain || r.reactionType === legacy),
    );
    const action = mine ? 'unsetReaction' : 'setReaction';
    await this.call((g) =>
      g.raw(`/chats/${enc(chatId)}/messages/${enc(messageId)}/${action}`, { method: 'POST', retries: 1, body: { reactionType: mine?.reactionType ?? emoji } }),
    );
    return this.toMessage(await this.getMessage(chatId, messageId, true), chatId)!;
  }

  async markRead(chatId: string): Promise<void> {
    await this.call((g) =>
      g.raw(`/chats/${enc(chatId)}/markChatReadForUser`, {
        method: 'POST',
        retries: 1,
        body: { user: { id: this.conn.remoteUserId, ...(this.tenantId ? { tenantId: this.tenantId } : {}) } },
      }),
    );
    const st = this.state.get(chatId);
    if (st) st.unread = 0;
    const c = this.chats.get(chatId);
    if (c) c.viewpoint = { ...(c.viewpoint ?? {}), lastMessageReadDateTime: new Date().toISOString() };
  }

  async typing(): Promise<void> {
    /* Graph bietet keine Tippen-Anzeige */
  }

  async search(q: string): Promise<ChatMessage[]> {
    const res = await this.call((g) =>
      g.json<{ value?: { hitsContainers?: { hits?: { summary?: string; resource?: GMessage & { chatId?: string } }[] }[] }[] }>('/search/query', {
        method: 'POST',
        retries: 1,
        body: { requests: [{ entityTypes: ['chatMessage'], query: { queryString: q }, from: 0, size: 25 }] },
      }),
    ).catch(() => null);
    const hits = res?.value?.[0]?.hitsContainers?.flatMap((h) => h.hits ?? []) ?? [];
    const out: ChatMessage[] = [];
    for (const h of hits) {
      const r = h.resource;
      if (!r?.id || !r.chatId) continue;
      const sender = this.senderOf(r.from);
      out.push({
        id: this.msgId(r.chatId, r.id),
        seq: this.seqOf(r),
        conversationId: this.convId(r.chatId),
        senderId: sender.id,
        senderName: sender.name,
        kind: 'text',
        body: teamsHtmlToMarkdown((h.summary ?? r.body?.content ?? '').replace(/<\/?c0>/g, '')),
        createdAt: r.createdDateTime,
        deleted: false,
        attachments: [],
        reactions: [],
      });
    }
    return out;
  }

  async file(ref: string): Promise<BinaryFile> {
    let f: { k: 'h' | 'r' | 'g'; u: string; n: string; m: string };
    try {
      f = JSON.parse(ref);
    } catch {
      throw new NotFoundError('Datei');
    }
    if (f.k === 'g') {
      // Ohne Graph-Token, nur von den erlaubten GIF-Anbietern
      const { data, contentType } = await fetchGif(f.u);
      return { filename: f.n, contentType, data };
    }
    if (f.k === 'h') {
      // Nur Graph-Adressen abrufen (das Token darf nirgendwo anders hin)
      if (!/^https:\/\/graph\.microsoft\.com\/(v1\.0|beta)\//i.test(f.u)) throw new NotFoundError('Datei');
      const { data, contentType } = await this.call((g) => g.buffer(f.u));
      const ct = contentType.split(';')[0]!.trim().toLowerCase();
      // Eingefügte GIFs kommen ebenfalls als hostedContents – echten Typ erkennen, damit sie animiert bleiben
      return { filename: f.n, contentType: sniffImage(data) ?? (/^image\//.test(ct) ? ct : f.m), data };
    }
    const shareId = `u!${Buffer.from(f.u, 'utf8').toString('base64url')}`;
    const { data, contentType } = await this.call((g) => g.buffer(`/shares/${shareId}/driveItem/content`, { timeoutMs: 120_000 })).catch((err) => {
      if (err instanceof AppError && (err.status === 404 || err.status === 403)) throw new HttpError(404, 'Datei nicht (mehr) zugänglich – bitte in Teams öffnen');
      throw err;
    });
    return { filename: f.n, contentType: f.m !== 'application/octet-stream' ? f.m : contentType.split(';')[0] || f.m, data };
  }

  async avatar(remoteUserId: string): Promise<BinaryFile> {
    if (remoteUserId.startsWith('app/')) throw new NotFoundError('Avatar');
    const res = await this.graph.buffer(`/users/${enc(remoteUserId)}/photos/64x64/$value`, { retries: 0 }).catch(() => null);
    if (!res) throw new NotFoundError('Avatar');
    return { filename: 'avatar', contentType: res.contentType || 'image/jpeg', data: res.data };
  }

  async searchUsers(q: string): Promise<ChatUser[]> {
    const s = q.replace(/'/g, "''");
    const filter = ['displayName', 'givenName', 'surname', 'mail', 'userPrincipalName'].map((p) => `startswith(${p},'${s}')`).join(' or ');
    const list = await this.call((g) =>
      g.page<{ id: string; displayName?: string; mail?: string | null; userPrincipalName?: string; jobTitle?: string | null; department?: string | null }>(
        `/users${qs({ $filter: filter, $top: 20, $select: 'id,displayName,mail,userPrincipalName,jobTitle,department' })}`,
      ),
    );
    return list.items
      .filter((u) => u.id !== this.conn.remoteUserId)
      .map((u) => ({
        id: this.uid(u.id)!,
        name: u.displayName || u.mail || u.userPrincipalName || u.id,
        email: u.mail || u.userPrincipalName || '',
        avatarUrl: this.avatarUrl(u.id),
        online: false,
        jobTitle: u.jobTitle ?? undefined,
        department: u.department ?? undefined,
      }));
  }

  private member(userId: string) {
    return {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${userId.replace(/'/g, "''")}')`,
    };
  }

  async openDirect(remoteUserId: string): Promise<ChatConversation> {
    const c = await this.call((g) =>
      g.json<GChat>('/chats', { method: 'POST', retries: 1, body: { chatType: 'oneOnOne', members: [this.member(this.conn.remoteUserId), this.member(remoteUserId)] } }),
    );
    return this.getConversation(c.id);
  }

  async createGroup(name: string, remoteUserIds: string[]): Promise<ChatConversation> {
    if (!remoteUserIds.length) throw new BadRequestError('Für einen Teams-Gruppenchat bitte mindestens zwei weitere Personen wählen');
    const ids = [...new Set(remoteUserIds.filter((id) => id !== this.conn.remoteUserId))];
    const c = await this.call((g) =>
      g.json<GChat>('/chats', {
        method: 'POST',
        retries: 1,
        body: { chatType: ids.length === 1 ? 'oneOnOne' : 'group', ...(ids.length > 1 ? { topic: name } : {}), members: [this.conn.remoteUserId, ...ids].map((id) => this.member(id)) },
      }),
    );
    return this.getConversation(c.id);
  }

  /* ─────────── Abfrage ─────────── */

  start() {
    this.stopped = false;
    this.host.setStatus('connecting');
    this.graphClient = null;
    this.schedule(0);
    this.hotTimer = setInterval(() => void this.pollHot(), HOT_POLL);
    this.hotTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hotTimer) clearInterval(this.hotTimer);
    this.timer = null;
    this.hotTimer = null;
    this.hot.clear();
  }

  presence(online: boolean) {
    if (online && !this.stopped) this.schedule(500);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pollChats(), ms);
    this.timer.unref();
  }

  private markHot(chatId: string) {
    this.hot.set(chatId, Date.now());
  }

  private initState(c: GChat) {
    const p = c.lastMessagePreview;
    this.state.set(c.id, {
      lastCreated: p ? Date.parse(p.createdDateTime) || 0 : 0,
      lastModified: p?.createdDateTime ?? c.lastUpdatedDateTime ?? c.createdDateTime,
      previewId: p?.id ?? null,
      unread: this.unreadGuess(c),
    });
  }

  private async pollHot() {
    if (this.stopped || !this.host.online()) return;
    const now = Date.now();
    for (const [chatId, t] of this.hot) {
      if (now - t > HOT_MS) {
        this.hot.delete(chatId);
        continue;
      }
      if (this.state.has(chatId)) void this.pollChat(chatId).catch(() => undefined);
    }
  }

  /** Neue und geänderte Nachrichten einer Unterhaltung seit dem letzten Abruf */
  private pollChat(chatId: string): Promise<void> {
    const running = this.inflight.get(chatId);
    if (running) return running;
    const p = (async () => {
      const st = this.state.get(chatId);
      if (!st) return;
      const list = await this.call((g) =>
        g.all<GMessage>(
          `/chats/${enc(chatId)}/messages${qs({ $top: 50, $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${st.lastModified}` })}`,
          { retries: 1 },
          100,
        ),
      );
      this.process(chatId, list);
    })().finally(() => this.inflight.delete(chatId));
    this.inflight.set(chatId, p);
    return p;
  }

  private process(chatId: string, list: GMessage[]) {
    const st = this.state.get(chatId);
    if (!st) return;
    const chat = this.chats.get(chatId);
    const modOf = (m: GMessage) => m.lastModifiedDateTime ?? m.createdDateTime;
    for (const m of list.sort((a, b) => Date.parse(modOf(a)) - Date.parse(modOf(b)))) {
      if (isAfter(modOf(m), st.lastModified)) st.lastModified = modOf(m);
      const created = Date.parse(m.createdDateTime) || 0;
      const msg = this.toMessage(m, chatId);
      if (!msg) continue;
      if (created > st.lastCreated) {
        st.lastCreated = created;
        st.previewId = m.id;
        this.host.publish({ type: 'chat.message', conversationId: msg.conversationId, message: msg });
        const own = m.from?.user?.id === this.conn.remoteUserId;
        if (msg.kind === 'text' && !own && !msg.deleted) {
          st.unread++;
          this.host.incoming(msg, {
            kind: chat?.chatType === 'oneOnOne' ? 'direct' : 'group',
            title: chat ? this.chatName(chat) : 'Microsoft Teams',
            sender: msg.senderName || 'Jemand',
          });
        } else if (own) st.unread = 0;
      } else {
        this.host.publish({ type: 'chat.message.updated', conversationId: msg.conversationId, message: msg });
      }
    }
  }

  private async pollChats() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const list = await this.fetchChats();
      const seen = new Set<string>();
      for (const c of list) {
        seen.add(c.id);
        this.chats.set(c.id, c);
        const st = this.state.get(c.id);
        if (!st) {
          this.initState(c);
          if (this.initialized) {
            this.host.publish({ type: 'chat.conversation', conversationId: this.convId(c.id) });
            // Neuer Chat mit fremder Nachricht → wie eine neue Nachricht melden
            const p = c.lastMessagePreview;
            if (p && this.unreadGuess(c)) {
              const msg = this.previewMessage(p, c.id);
              this.host.incoming(msg, { kind: c.chatType === 'oneOnOne' ? 'direct' : 'group', title: this.chatName(c), sender: msg.senderName || 'Jemand' });
            }
          }
          continue;
        }
        const p = c.lastMessagePreview;
        if (p && p.id !== st.previewId) {
          if ((Date.parse(p.createdDateTime) || 0) > st.lastCreated) {
            await this.pollChat(c.id).catch((err) => this.host.log.debug({ err, chat: c.id }, 'Teams: Nachrichten nicht abrufbar'));
          }
          st.previewId = p.id;
        }
        // Auf einem anderen Gerät (oder in Teams) gelesen
        if (st.unread && p && this.lastRead(c) >= (Date.parse(p.createdDateTime) || 0)) {
          st.unread = 0;
          this.host.publish({ type: 'chat.read', conversationId: this.convId(c.id), userId: this.me, seq: this.seqOf(p) });
        }
      }
      if (this.initialized) {
        for (const id of [...this.state.keys()]) {
          if (seen.has(id)) continue;
          this.state.delete(id);
          this.chats.delete(id);
          this.host.publish({ type: 'chat.conversation', conversationId: this.convId(id), removed: true });
        }
      }
      this.initialized = true;
      this.host.setStatus('ok');
    } catch (err) {
      this.host.setStatus('error', this.statusText(err));
    } finally {
      this.polling = false;
      this.schedule(this.host.online() ? FAST_POLL : SLOW_POLL);
    }
  }
}
