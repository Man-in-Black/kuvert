import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { AccountInfo, FolderListResult, MailIdentity } from '@kuvert/shared';
import { useAccountsWith } from '@/lib/queries';
import { fetchFolders, fetchIdentities, mailKeys } from './api';

export function useMailAccounts(): AccountInfo[] {
  return useAccountsWith('mail');
}

export function useFolders(accountId: string | undefined) {
  return useQuery({
    queryKey: mailKeys.folders(accountId ?? ''),
    queryFn: () => fetchFolders(accountId!),
    enabled: !!accountId,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** Ordnerlisten aller Mail-Konten (gleicher Cache wie die Ordnerleiste) */
export function useAllFolders(accounts: AccountInfo[]) {
  return useQueries({
    queries: accounts.map((a) => ({ queryKey: mailKeys.folders(a.id), queryFn: () => fetchFolders(a.id), staleTime: 60_000, refetchInterval: 120_000 })),
  });
}

/** Ungelesen-Zähler über alle ausgewählten Posteingänge (Hauptpostfach + gewählte freigegebene Postfächer) */
export function unifiedUnreadOf(accounts: AccountInfo[], folders: { data?: FolderListResult }[]): number {
  return accounts.reduce((sum, a, i) => {
    const data = folders[i]?.data;
    if (!data) return sum;
    const primary = data.mailboxes[0]?.id;
    const shared = new Set((a.settings.unifiedSharedMailboxes ?? []).map((m) => m.trim().toLowerCase()));
    return (
      sum +
      data.folders
        .filter((f) => f.role === 'inbox')
        .filter((f) => (!f.mailboxId || f.mailboxId === primary ? a.settings.includeInUnifiedInbox !== false : shared.has(f.mailboxId.toLowerCase())))
        .reduce((n, f) => n + (f.unread ?? 0), 0)
    );
  }, 0);
}

/** Badge an „Mail“ in der Navigation: ungelesene Mails im Sammel-Posteingang */
export function useUnifiedUnread(): number {
  const accounts = useMailAccounts();
  return unifiedUnreadOf(accounts, useAllFolders(accounts));
}

export interface IdentityOption {
  key: string;
  accountId: string;
  account: AccountInfo;
  identity: MailIdentity;
}

/** Alle Absender-Identitäten aller Mail-Konten (inkl. freigegebener Postfächer) */
export function useAllIdentities(): { options: IdentityOption[]; loading: boolean } {
  const accounts = useMailAccounts();
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: mailKeys.identities(a.id),
      queryFn: () => fetchIdentities(a.id),
      staleTime: 10 * 60_000,
    })),
  });
  const loading = results.some((r) => r.isLoading);
  const dataKey = results.map((r) => r.dataUpdatedAt).join(',');
  const options = useMemo(() => {
    const out: IdentityOption[] = [];
    accounts.forEach((a, i) => {
      const ids = results[i]?.data;
      const list: MailIdentity[] = ids && ids.length ? ids : [{ id: 'primary', address: a.email, name: a.name }];
      for (const identity of list) out.push({ key: `${a.id}::${identity.id}`, accountId: a.id, account: a, identity });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, dataKey]);
  return { options, loading };
}

/** Alle eigenen Adressen (kleingeschrieben) – für "Allen antworten" */
export function useOwnAddresses(): Set<string> {
  const { options } = useAllIdentities();
  const accounts = useMailAccounts();
  return useMemo(() => {
    const s = new Set<string>();
    for (const a of accounts) s.add(a.email.toLowerCase());
    for (const o of options) s.add(o.identity.address.toLowerCase());
    return s;
  }, [accounts, options]);
}
