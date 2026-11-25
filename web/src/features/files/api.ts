/** Datenzugriff für Cloud-Speicher. Alle Query-Keys beginnen mit 'files'. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ShareLink, StorageItem, UploadInfo } from '@kuvert/shared';
import { api, apiUrl, uploadFile } from '@/lib/api';

const base = (accountId: string) => `/storage/accounts/${encodeURIComponent(accountId)}`;

export function useStorageItems(accountId: string | undefined, folderId: string, search: string) {
  return useQuery({
    queryKey: ['files', 'items', accountId ?? '', folderId, search],
    queryFn: () =>
      api<StorageItem[]>(`${base(accountId!)}/items`, {
        query: search ? { search } : { folderId: folderId || undefined },
      }),
    enabled: !!accountId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function downloadUrl(accountId: string, itemId: string): string {
  return apiUrl(`${base(accountId)}/download`, { itemId });
}

export function shareItem(accountId: string, itemId: string, opts: { expiresDays?: number; password?: string } = {}) {
  return api<ShareLink>(`${base(accountId)}/share`, { method: 'POST', body: { itemId, ...opts } });
}

/** Cloud-Datei als Mail-Anhang übernehmen → Upload */
export function attachItem(accountId: string, itemId: string) {
  return api<UploadInfo>(`${base(accountId)}/attach`, { method: 'POST', body: { itemId } });
}

export async function uploadToStorage(accountId: string, folderId: string, file: File, onProgress?: (pct: number) => void) {
  const up = await uploadFile(file, file.name, onProgress);
  return api<StorageItem>(`${base(accountId)}/upload-from-upload`, {
    method: 'POST',
    body: { uploadId: up.id, folderId: folderId || null },
  });
}

export function sortItems(items: StorageItem[]): StorageItem[] {
  return [...items].sort((a, b) => (a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : a.name.localeCompare(b.name, 'de', { numeric: true })));
}
