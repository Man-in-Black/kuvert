/** API-Zugriffe und Query-Hooks für die Paperless-ngx-Anbindung. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  PaperlessAdminConfig,
  PaperlessDocument,
  PaperlessMeta,
  PaperlessSearchQuery,
  PaperlessSearchResult,
  PaperlessStats,
  PaperlessTaskStatus,
  PaperlessUserConfig,
} from '@kuvert/shared';
import { api, apiUrl, errorMessage } from '@/lib/api';

export const pk = {
  all: ['paperless'] as const,
  config: ['paperless', 'config'] as const,
  adminConfig: ['paperless', 'admin-config'] as const,
  status: ['paperless', 'status'] as const,
  meta: ['paperless', 'meta'] as const,
  search: (q: PaperlessSearchQuery) => ['paperless', 'search', q] as const,
};

export function usePaperlessConfig() {
  return useQuery({ queryKey: pk.config, queryFn: () => api<PaperlessUserConfig>('/paperless/me/config'), staleTime: 60_000 });
}

export function usePaperlessAdminConfig() {
  return useQuery({ queryKey: pk.adminConfig, queryFn: () => api<PaperlessAdminConfig>('/paperless/admin/config') });
}

export function usePaperlessStatus(enabled: boolean) {
  return useQuery({ queryKey: pk.status, queryFn: () => api<PaperlessStats>('/paperless/me/status'), enabled, retry: false, staleTime: 60_000 });
}

export function usePaperlessMeta(enabled: boolean) {
  return useQuery({ queryKey: pk.meta, queryFn: () => api<PaperlessMeta>('/paperless/meta'), enabled, retry: false, staleTime: 5 * 60_000 });
}

export function usePaperlessSearch(q: PaperlessSearchQuery, enabled: boolean) {
  return useQuery({
    queryKey: pk.search(q),
    queryFn: () => api<PaperlessSearchResult>('/paperless/documents', { query: q as Record<string, string | number | undefined> }),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export const thumbUrl = (id: number) => apiUrl(`/paperless/documents/${id}/thumb`);
export const previewUrl = (id: number) => apiUrl(`/paperless/documents/${id}/preview`);
export const documentLink = (baseUrl: string, id: number) => `${baseUrl}/documents/${id}/details`;

/** Dateiname, unter dem das Dokument angehängt wird (Platzhalter bis zur Antwort des Servers) */
export function attachName(doc: PaperlessDocument, original: boolean) {
  if (original && doc.originalFileName) return doc.originalFileName;
  return doc.archivedFileName || doc.originalFileName || `${doc.title}.pdf`;
}

/**
 * Verarbeitung einer Übergabe an Paperless verfolgen (läuft asynchron in Paperless):
 * Fortschritt als Toast, am Ende Erfolg mit „Öffnen“ oder die Fehlermeldung (z. B. Duplikat).
 */
export async function trackPaperlessTask(taskId: string, name: string, baseUrl: string | null) {
  const id = toast.loading(`„${name}“ wird an Paperless übergeben …`);
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    let t: PaperlessTaskStatus;
    try {
      t = await api<PaperlessTaskStatus>(`/paperless/tasks/${encodeURIComponent(taskId)}`);
    } catch (err) {
      toast.error(`Status unbekannt: ${errorMessage(err)}`, { id });
      return;
    }
    if (t.status === 'success') {
      toast.success(`„${name}“ in Paperless abgelegt`, {
        id,
        action:
          baseUrl && t.documentId
            ? { label: 'Öffnen', onClick: () => window.open(documentLink(baseUrl, t.documentId!), '_blank', 'noopener') }
            : undefined,
      });
      return;
    }
    if (t.status === 'failure') {
      toast.error(`Paperless hat „${name}“ nicht übernommen${t.message ? `: ${t.message}` : ''}`, { id, duration: 10_000 });
      return;
    }
  }
  toast.message(`Paperless verarbeitet „${name}“ noch – das Dokument erscheint dort, sobald es fertig ist.`, { id });
}
