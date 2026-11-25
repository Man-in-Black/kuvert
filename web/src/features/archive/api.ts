/** API-Zugriffe und Query-Hooks für das Mail-Archiv (Mail-Archiver). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ArchiverAccount,
  ArchiverAdminConfig,
  ArchiverEmailDetail,
  ArchiverFolder,
  ArchiverSearchQuery,
  ArchiverSearchResult,
  ArchiverStats,
  ArchiverUserConfig,
} from '@kuvert/shared';
import { api, apiUrl } from '@/lib/api';

export const ak = {
  all: ['archive'] as const,
  config: ['archive', 'config'] as const,
  adminConfig: ['archive', 'admin-config'] as const,
  status: ['archive', 'status'] as const,
  accounts: ['archive', 'accounts'] as const,
  folders: (id: number) => ['archive', 'folders', id] as const,
  search: (q: ArchiverSearchQuery) => ['archive', 'search', q] as const,
  email: (id: number) => ['archive', 'email', id] as const,
};

export function useArchiverConfig() {
  return useQuery({ queryKey: ak.config, queryFn: () => api<ArchiverUserConfig>('/mailarchiver/me/config'), staleTime: 60_000 });
}

export function useArchiverAdminConfig() {
  return useQuery({ queryKey: ak.adminConfig, queryFn: () => api<ArchiverAdminConfig>('/mailarchiver/admin/config') });
}

export function useArchiverStatus(enabled: boolean) {
  return useQuery({ queryKey: ak.status, queryFn: () => api<ArchiverStats>('/mailarchiver/me/status'), enabled, retry: false, staleTime: 60_000 });
}

export function useArchiverAccounts(enabled: boolean) {
  return useQuery({ queryKey: ak.accounts, queryFn: () => api<ArchiverAccount[]>('/mailarchiver/accounts'), enabled, staleTime: 5 * 60_000, retry: false });
}

export function useArchiverFolders(accountId: number | undefined) {
  return useQuery({
    queryKey: ak.folders(accountId ?? 0),
    queryFn: () => api<ArchiverFolder[]>(`/mailarchiver/accounts/${accountId}/folders`),
    enabled: !!accountId,
    staleTime: 5 * 60_000,
  });
}

export function useArchiverSearch(q: ArchiverSearchQuery, enabled: boolean) {
  return useQuery({
    queryKey: ak.search(q),
    queryFn: () => api<ArchiverSearchResult>('/mailarchiver/emails', { query: q as Record<string, string | number | undefined> }),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useArchiverEmail(id: number | undefined) {
  return useQuery({
    queryKey: ak.email(id ?? 0),
    queryFn: () => api<ArchiverEmailDetail>(`/mailarchiver/emails/${id}`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

export const attachmentUrl = (emailId: number, attachmentId: number, inline = false) =>
  apiUrl(`/mailarchiver/emails/${emailId}/attachments/${attachmentId}`, inline ? { inline: 1 } : undefined);

export const emlUrl = (emailId: number) => apiUrl(`/mailarchiver/emails/${emailId}/eml`);

export function formatArchiveDate(iso: string, long = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (long) return d.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}
