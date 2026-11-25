/**
 * WebDAV-Dateispeicher (generisch) mit Nextcloud-Erweiterungen
 * (Freigabelinks über die OCS-API, serverseitige Suche).
 * Element-ID = Pfad relativ zum Benutzer-Stammordner, z. B. "/Dokumente/Angebot.pdf".
 */
import path from 'node:path/posix';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import type { ShareLink, StorageItem } from '@kuvert/shared';
import { AppError, AuthError, BadRequestError, HttpError, NotFoundError } from '../../core/errors.js';
import { apiJson } from '../../core/http.js';
import type { AccountContext } from '../../core/module.js';
import type { BinaryContent, StorageProvider } from '../../core/providers.js';

export interface WebDavOptions {
  /** URL des Stammordners, z. B. https://cloud.example.com/remote.php/dav/files/max */
  rootUrl: string;
  username: string;
  password: string;
  /** Nur für Nextcloud: Basis-URL der Instanz (für OCS & SEARCH) und Benutzer-ID */
  nextcloud?: { serverUrl: string; userId: string };
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  eml: 'message/rfc822',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function guessMime(filename: string): string {
  return MIME[path.extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

function normPath(p: string | null | undefined): string {
  if (!p) return '/';
  const n = path.normalize(`/${p}`.replace(/\/+/g, '/'));
  if (n.includes('/../') || n.endsWith('/..')) throw new BadRequestError('Ungültiger Pfad');
  return n.length > 1 ? n.replace(/\/$/, '') : '/';
}

function mapWebDavError(err: unknown): Error {
  if (err instanceof AppError) return err;
  const status = (err as { status?: number; response?: { status?: number } })?.status ?? (err as { response?: { status?: number } })?.response?.status;
  const msg = (err as Error)?.message ?? String(err);
  if (status === 401) return new AuthError('WebDAV: Anmeldung fehlgeschlagen – Benutzername oder Passwort falsch');
  if (status === 404) return new NotFoundError('Datei oder Ordner');
  if (status === 403) return new AppError(403, 'webdav_forbidden', 'WebDAV: Zugriff verweigert');
  if (status === 507) return new AppError(507, 'webdav_quota', 'Speicherplatz erschöpft');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) return new AppError(502, 'webdav_unreachable', `WebDAV-Server nicht erreichbar: ${msg}`);
  return new AppError(502, 'webdav_error', `WebDAV-Fehler: ${msg}`);
}

export class WebDavStorage implements StorageProvider {
  private client: WebDAVClient;

  constructor(
    private ctx: AccountContext,
    private opts: WebDavOptions,
  ) {
    this.client = createClient(opts.rootUrl, { username: opts.username, password: opts.password });
  }

  private toItem(f: FileStat): StorageItem {
    const p = normPath(f.filename);
    const parent = path.dirname(p);
    return {
      id: p,
      accountId: this.ctx.account.id,
      name: f.basename || path.basename(p),
      path: p,
      parentId: p === '/' ? null : parent,
      isFolder: f.type === 'directory',
      size: f.type === 'file' ? f.size : undefined,
      modified: f.lastmod ? new Date(f.lastmod).toISOString() : undefined,
      contentType: f.type === 'file' ? f.mime || guessMime(f.basename) : undefined,
      webUrl: this.opts.nextcloud
        ? `${this.opts.nextcloud.serverUrl}/apps/files/?dir=${encodeURIComponent(f.type === 'directory' ? p : parent)}`
        : undefined,
    };
  }

  async list(folderId?: string | null): Promise<StorageItem[]> {
    const dir = normPath(folderId);
    try {
      const entries = (await this.client.getDirectoryContents(dir)) as FileStat[];
      return entries
        .map((e) => this.toItem(e))
        .filter((i) => i.id !== dir && !i.name.startsWith('.'))
        .sort((a, b) => (a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : a.name.localeCompare(b.name, 'de')));
    } catch (err) {
      throw mapWebDavError(err);
    }
  }

  async download(itemId: string): Promise<BinaryContent> {
    const p = normPath(itemId);
    try {
      const data = await this.client.getFileContents(p, { format: 'binary' });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const name = path.basename(p);
      return { filename: name, contentType: guessMime(name), data: buf };
    } catch (err) {
      throw mapWebDavError(err);
    }
  }

  async upload(folderId: string | null | undefined, filename: string, data: Buffer, contentType: string): Promise<StorageItem> {
    const dir = normPath(folderId);
    const clean = path.basename(filename.replace(/\\/g, '/')).replace(/^\.+/, '') || 'datei';
    const ext = path.extname(clean);
    const base = clean.slice(0, clean.length - ext.length);
    try {
      let target = path.join(dir, clean);
      for (let i = 1; await this.client.exists(target); i++) {
        target = path.join(dir, `${base} (${i})${ext}`);
        if (i > 50) throw new AppError(409, 'exists', 'Datei existiert bereits');
      }
      await this.client.putFileContents(target, data, {
        overwrite: false,
        contentLength: data.length,
        headers: { 'Content-Type': contentType || guessMime(clean) },
      });
      const stat = (await this.client.stat(target)) as FileStat;
      return this.toItem(stat);
    } catch (err) {
      throw mapWebDavError(err);
    }
  }

  /* ───────────── Nextcloud-spezifisch ───────────── */

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64')}`;
  }

  async search(query: string): Promise<StorageItem[]> {
    const nc = this.opts.nextcloud;
    const q = query.trim();
    if (!q) return [];
    if (!nc) {
      // Generisches WebDAV: nur im Stammordner filtern
      return (await this.list('/')).filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
    }
    const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:select>
    <d:from><d:scope><d:href>/files/${esc(nc.userId)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>${esc(like)}</d:literal></d:like></d:where>
    <d:orderby/>
    <d:limit><d:nresults>100</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
    let res: Response;
    try {
      res = await fetch(`${nc.serverUrl}/remote.php/dav/`, {
        method: 'SEARCH',
        headers: { Authorization: this.authHeader(), 'Content-Type': 'text/xml; charset=utf-8' },
        body,
      });
    } catch (err) {
      throw mapWebDavError(err);
    }
    if (res.status === 401) throw new AuthError('Nextcloud: Anmeldung fehlgeschlagen');
    if (!res.ok) throw new HttpError(res.status, `Nextcloud-Suche fehlgeschlagen (${res.status})`);
    const xml = await res.text();
    const marker = `/remote.php/dav/files/${nc.userId}`;
    const items: StorageItem[] = [];
    for (const m of xml.matchAll(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g)) {
      const block = m[1]!;
      const href = block.match(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/)?.[1];
      if (!href) continue;
      let rel: string;
      try {
        rel = decodeURIComponent(href);
      } catch {
        rel = href;
      }
      const start = rel.indexOf(marker);
      if (start < 0) continue;
      rel = rel.slice(start + marker.length) || '/';
      const isFolder = /<(?:\w+:)?collection\s*\/>/.test(block);
      const size = Number(block.match(/<(?:\w+:)?getcontentlength>(\d+)</)?.[1] ?? NaN);
      const modified = block.match(/<(?:\w+:)?getlastmodified>([^<]+)</)?.[1];
      const ct = block.match(/<(?:\w+:)?getcontenttype>([^<]+)</)?.[1];
      const p = normPath(rel);
      if (p === '/') continue;
      items.push({
        id: p,
        accountId: this.ctx.account.id,
        name: path.basename(p),
        path: p,
        parentId: path.dirname(p),
        isFolder,
        size: Number.isFinite(size) ? size : undefined,
        modified: modified ? new Date(modified).toISOString() : undefined,
        contentType: isFolder ? undefined : ct || guessMime(p),
      });
    }
    return items;
  }

  async createShareLink(itemId: string, opts?: { expiresDays?: number; password?: string }): Promise<ShareLink> {
    const nc = this.opts.nextcloud;
    if (!nc) throw new BadRequestError('Freigabelinks werden von diesem WebDAV-Speicher nicht unterstützt');
    const form = new URLSearchParams({ path: normPath(itemId), shareType: '3', permissions: '1' });
    let expires: string | null = null;
    if (opts?.expiresDays && opts.expiresDays > 0) {
      expires = new Date(Date.now() + opts.expiresDays * 86_400_000).toISOString().slice(0, 10);
      form.set('expireDate', expires);
    }
    if (opts?.password) form.set('password', opts.password);
    try {
      const json = await apiJson<{ ocs?: { data?: { url?: string; expiration?: string | null } } }>(
        `${nc.serverUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`,
        {
          method: 'POST',
          headers: {
            Authorization: this.authHeader(),
            'OCS-APIRequest': 'true',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          retries: 1,
        },
      );
      const url = json.ocs?.data?.url;
      if (!url) throw new AppError(502, 'share_failed', 'Nextcloud hat keinen Freigabelink geliefert');
      return { url, expires: json.ocs?.data?.expiration ?? expires };
    } catch (err) {
      if (err instanceof HttpError) {
        const meta = (err.body as { ocs?: { meta?: { message?: string } } })?.ocs?.meta?.message;
        throw new AppError(err.status, 'share_failed', `Freigabe fehlgeschlagen: ${meta || err.message}`);
      }
      throw err;
    }
  }
}

/** Nextcloud: Benutzer-ID, Anzeigename und E-Mail über die OCS-API ermitteln (prüft zugleich die Zugangsdaten). */
export async function nextcloudUserInfo(serverUrl: string, username: string, password: string): Promise<{ id: string; displayName?: string; email?: string }> {
  const json = await apiJson<{ ocs?: { data?: { id?: string; displayname?: string; 'display-name'?: string; email?: string | null } } }>(
    `${serverUrl}/ocs/v2.php/cloud/user?format=json`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'OCS-APIRequest': 'true',
      },
      retries: 1,
      timeoutMs: 20_000,
    },
  );
  const d = json.ocs?.data;
  if (!d?.id) throw new AppError(502, 'nextcloud_user', 'Nextcloud-Benutzer konnte nicht ermittelt werden');
  return { id: d.id, displayName: d.displayname ?? d['display-name'], email: d.email ?? undefined };
}
