/**
 * Google Drive (Drive API v3) als Cloud-Speicher für Anhänge und Freigabelinks.
 */
import type { ShareLink, StorageItem } from '@kuvert/shared';
import { HttpError } from '../../core/errors.js';
import type { BinaryContent, StorageProvider } from '../../core/providers.js';
import { gurl, multipartRelated, type GoogleClient } from './client.js';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;

/** Export-Formate für native Google-Dokumente */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: 'pptx',
  },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
};

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class GoogleDriveProvider implements StorageProvider {
  constructor(private g: GoogleClient) {}

  private toItem(f: GFile): StorageItem {
    return {
      id: f.id,
      accountId: this.g.accountId,
      name: f.name,
      parentId: f.parents?.[0] ?? null,
      isFolder: f.mimeType === FOLDER_MIME,
      size: f.size ? Number(f.size) : undefined,
      modified: f.modifiedTime,
      contentType: f.mimeType,
      webUrl: f.webViewLink,
    };
  }

  private async query(query: string, orderBy = 'folder,name'): Promise<StorageItem[]> {
    const files = await this.g.paged<GFile, { files?: GFile[]; nextPageToken?: string }>(
      (pageToken) =>
        gurl(`${BASE}/files`, {
          q: query,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          orderBy,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      (r) => r.files,
      10,
    );
    return files.map((f) => this.toItem(f));
  }

  list(folderId?: string | null): Promise<StorageItem[]> {
    return this.query(`'${q(folderId || 'root')}' in parents and trashed = false`);
  }

  search(query: string): Promise<StorageItem[]> {
    return this.query(`name contains '${q(query)}' and trashed = false`, 'folder,modifiedTime desc');
  }

  async download(itemId: string): Promise<BinaryContent> {
    const meta = await this.g.json<GFile>(gurl(`${BASE}/files/${encodeURIComponent(itemId)}`, { fields: 'id,name,mimeType', supportsAllDrives: true }));
    if (meta.mimeType === FOLDER_MIME) throw new HttpError(400, 'Ordner können nicht heruntergeladen werden');
    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      const exp = EXPORTS[meta.mimeType] ?? { mime: 'application/pdf', ext: 'pdf' };
      const { data } = await this.g.buffer(gurl(`${BASE}/files/${encodeURIComponent(itemId)}/export`, { mimeType: exp.mime }), { timeoutMs: 300_000 });
      const filename = meta.name.toLowerCase().endsWith(`.${exp.ext}`) ? meta.name : `${meta.name}.${exp.ext}`;
      return { filename, contentType: exp.mime, data };
    }
    const { data, contentType } = await this.g.buffer(
      gurl(`${BASE}/files/${encodeURIComponent(itemId)}`, { alt: 'media', supportsAllDrives: true }),
      { timeoutMs: 600_000 },
    );
    return { filename: meta.name, contentType: meta.mimeType || contentType, data };
  }

  async upload(folderId: string | null | undefined, filename: string, data: Buffer, contentType: string): Promise<StorageItem> {
    const metadata = { name: filename, parents: [folderId || 'root'] };
    const type = contentType || 'application/octet-stream';
    if (data.length <= SIMPLE_UPLOAD_LIMIT) {
      const mp = multipartRelated(metadata, data, type);
      const f = await this.g.json<GFile>(gurl(UPLOAD, { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: true }), {
        method: 'POST',
        body: mp.body,
        headers: { 'Content-Type': mp.contentType },
        timeoutMs: 300_000,
      });
      return this.toItem(f);
    }
    // Resumable Upload für große Dateien
    const init = await this.g.fetch(gurl(UPLOAD, { uploadType: 'resumable', fields: FILE_FIELDS, supportsAllDrives: true }), {
      method: 'POST',
      body: metadata,
      headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(data.length) },
    });
    const location = init.headers.get('location');
    if (!location) throw new HttpError(502, 'Google Drive lieferte keine Upload-Adresse');
    const f = await this.g.json<GFile>(location, {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': type },
      timeoutMs: 900_000,
      retries: 1,
    });
    return this.toItem(f);
  }

  async createShareLink(itemId: string): Promise<ShareLink> {
    // Ablaufdatum/Passwort werden von Google für "Jeder mit dem Link" nicht unterstützt
    await this.g.json(gurl(`${BASE}/files/${encodeURIComponent(itemId)}/permissions`, { supportsAllDrives: true }), {
      method: 'POST',
      body: { role: 'reader', type: 'anyone', allowFileDiscovery: false },
    });
    const f = await this.g.json<GFile>(gurl(`${BASE}/files/${encodeURIComponent(itemId)}`, { fields: 'webViewLink', supportsAllDrives: true }));
    if (!f.webViewLink) throw new HttpError(502, 'Kein Freigabelink erhalten');
    return { url: f.webViewLink, expires: null };
  }
}
