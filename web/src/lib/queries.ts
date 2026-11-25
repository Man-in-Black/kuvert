/** Gemeinsame React-Query-Hooks für Daten, die viele Bereiche brauchen. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountInfo, AppInfo, Capability, Signature, UserSettings } from '@kuvert/shared';
import { DEFAULT_USER_SETTINGS } from '@kuvert/shared';
import { api } from './api';

export const qk = {
  app: ['app'] as const,
  accounts: ['accounts'] as const,
  settings: ['settings'] as const,
  signatures: ['signatures'] as const,
  templates: ['templates'] as const,
};

export function useAppInfo() {
  return useQuery({ queryKey: qk.app, queryFn: () => api<AppInfo>('/app'), staleTime: 60_000 });
}

/** Feature-Flag eines Server-Moduls (z. B. "ai", "smime", "push") */
export function useFeature(name: string): boolean {
  const { data } = useAppInfo();
  return !!data?.features?.[name];
}

export function useAccounts() {
  return useQuery({ queryKey: qk.accounts, queryFn: () => api<AccountInfo[]>('/accounts'), staleTime: 30_000 });
}

/** Aktive Konten mit einer bestimmten Fähigkeit */
export function useAccountsWith(cap: Capability): AccountInfo[] {
  const { data } = useAccounts();
  return (data ?? []).filter((a) => a.enabled && a.capabilities.includes(cap));
}

export function useAccountMap(): Map<string, AccountInfo> {
  const { data } = useAccounts();
  return new Map((data ?? []).map((a) => [a.id, a]));
}

export function useSettings() {
  const q = useQuery({ queryKey: qk.settings, queryFn: () => api<UserSettings>('/settings'), staleTime: 60_000 });
  return { ...q, settings: q.data ?? DEFAULT_USER_SETTINGS };
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) => api<UserSettings>('/settings', { method: 'PUT', body: patch }),
    onSuccess: (data) => qc.setQueryData(qk.settings, data),
  });
}

export function useSignatures() {
  return useQuery({ queryKey: qk.signatures, queryFn: () => api<Signature[]>('/signatures'), staleTime: 60_000 });
}
