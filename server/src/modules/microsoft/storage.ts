/**
 * Cloud-Speicher: OneDrive / OneDrive for Business (Graph /me/drive).
 */
import type { ShareLink, StorageItem } from '@kuvert/shared';
import { HttpError } from '../../core/errors.js';
import { apiFetch } from '../../core/http.js';
import type { AccountContext } from '../../core/module.js';
import type { BinaryContent, StorageProvider } from '../../core/providers.js';
import { enc, qs, type GraphClient } from './graph.js';

interface GDriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
  webUrl?: string;
  parentReference?: { id?: string; path?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

const ITEM_SELECT = 'id,name,size,folder,file,lastModifiedDateTime,webUrl,parentReference';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const UPLOAD_CHUNK = 320 * 1024 * 32; // 10 MiB, Vielfaches von 320 KiB

export class OneDriveProvider implements StorageProvider {
  constructor(
    private graph: GraphClient,
    private ctx: AccountContext,
  ) {}

  private toItem(i: GDriveItem): StorageItem {
    const path = i.parentReference?.path?.replace(/^\/drive\/root:?/, '') || '/';
    return {
      id: i.id,
      accountId: this.ctx.account.id,
      name: i.name,
      path: `${path.replace(/\/$/, '')}/${i.name}`,
      parentId: i.parentReference?.id ?? null,
      isFolder: !!i.folder,
      size: i.size,
      modified: i.lastModifiedDateTime,
      contentType: i.file?.mimeType,
      webUrl: i.webUrl,
    };
  }

  private sortItems(items: StorageItem[]): StorageItem[] {
    return items.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, 'de'));
  }

  async list(folderId?: string | null): Promise<StorageItem[]> {
    const base = folderId ? `/me/drive/items/${enc(folderId)}/children` : '/me/drive/root/children';
    const items = await this.graph.all<GDriveItem>(`${base}${qs({ $top: 200, $select: ITEM_SELECT })}`, undefined, 5000);
    return this.sortItems(items.map((i) => this.toItem(i)));
  }

  async search(query: string): Promise<StorageItem[]> {
    const q = query.replace(/'/g, "''");
    const items = await this.graph.all<GDriveItem>(`/me/drive/root/search(q='${enc(q)}')${qs({ $top: 100, $select: ITEM_SELECT })}`, undefined, 200);
    return this.sortItems(items.map((i) => this.toItem(i)));
  }

  async download(itemId: string): Promise<BinaryContent> {
    const meta = await this.graph.json<GDriveItem>(`/me/drive/items/${enc(itemId)}`);
    if (meta.folder) throw new HttpError(400, 'Ordner können nicht heruntergeladen werden');
    const contentType = meta.file?.mimeType ?? 'application/octet-stream';
    const url = meta['@microsoft.graph.downloadUrl'];
    if (url) {
      // Vorab authentifizierte URL – kein Bearer-Token mitsenden
      const res = await apiFetch(url, { noAuthError: true, timeoutMs: 300_000 });
      return { filename: meta.name, contentType, data: Buffer.from(await res.arrayBuffer()) };
    }
    const r = await this.graph.buffer(`/me/drive/items/${enc(itemId)}/content`, { timeoutMs: 300_000 });
    return { filename: meta.name, contentType, data: r.data };
  }

  async upload(folderId: string | null | undefined, filename: string, data: Buffer, contentType: string): Promise<StorageItem> {
    const parent = folderId ? `/me/drive/items/${enc(folderId)}` : '/me/drive/root';
    const target = `${parent}:/${enc(filename)}:`;
    if (data.length <= SIMPLE_UPLOAD_LIMIT) {
      const item = await this.graph.json<GDriveItem>(`${target}/content${qs({ '@microsoft.graph.conflictBehavior': 'rename' })}`, {
        method: 'PUT',
        body: data,
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        timeoutMs: 300_000,
      });
      return this.toItem(item);
    }
    const session = await this.graph.json<{ uploadUrl: string }>(`${target}/createUploadSession`, {
      method: 'POST',
      body: { item: { '@microsoft.graph.conflictBehavior': 'rename', name: filename } },
    });
    let last: GDriveItem | undefined;
    for (let start = 0; start < data.length; start += UPLOAD_CHUNK) {
      const end = Math.min(start + UPLOAD_CHUNK, data.length);
      const res = await apiFetch(session.uploadUrl, {
        method: 'PUT',
        body: data.subarray(start, end),
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
        noAuthError: true,
        timeoutMs: 300_000,
      });
      if (res.status === 200 || res.status === 201) last = (await res.json()) as GDriveItem;
      else await res.arrayBuffer().catch(() => undefined);
    }
    if (!last) throw new HttpError(502, 'Upload zu OneDrive wurde nicht abgeschlossen');
    return this.toItem(last);
  }

  async createShareLink(itemId: string, opts?: { expiresDays?: number; password?: string }): Promise<ShareLink> {
    const expirationDateTime = opts?.expiresDays ? new Date(Date.now() + opts.expiresDays * 86_400_000).toISOString() : undefined;
    const create = (scope: 'organization' | 'anonymous') =>
      this.graph.json<{ link?: { webUrl?: string }; expirationDateTime?: string }>(`/me/drive/items/${enc(itemId)}/createLink`, {
        method: 'POST',
        body: {
          type: 'view',
          scope,
          ...(expirationDateTime ? { expirationDateTime } : {}),
          ...(opts?.password && scope === 'anonymous' ? { password: opts.password } : {}),
        },
      });
    let res;
    if (opts?.password) {
      // Kennwortschutz gibt es nur für anonyme Links
      res = await create('anonymous');
    } else {
      try {
        res = await create('organization');
      } catch (err) {
        this.ctx.log.debug({ err }, 'Organisationslink nicht möglich – versuche anonymen Link');
        res = await create('anonymous');
      }
    }
    if (!res.link?.webUrl) throw new HttpError(502, 'OneDrive hat keinen Freigabelink geliefert');
    return { url: res.link.webUrl, expires: res.expirationDateTime ?? expirationDateTime ?? null };
  }
}
