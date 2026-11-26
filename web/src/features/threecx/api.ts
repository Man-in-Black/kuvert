/** API-Zugriffe und Hooks der 3CX-Anbindung. */
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ThreeCxAdminConfig, ThreeCxAssignmentList, ThreeCxCallResult, ThreeCxMe } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useFeature } from '@/lib/queries';

export const tk = {
  all: ['threecx'] as const,
  me: ['threecx', 'me'] as const,
  adminConfig: ['threecx', 'admin', 'config'] as const,
  assignments: ['threecx', 'admin', 'assignments'] as const,
};

export function useThreeCxMe(enabled = true) {
  const feature = useFeature('threecx');
  return useQuery({ queryKey: tk.me, queryFn: () => api<ThreeCxMe>('/threecx/me'), enabled: feature && enabled, staleTime: 60_000, retry: false });
}

export function useThreeCxAdminConfig() {
  return useQuery({ queryKey: tk.adminConfig, queryFn: () => api<ThreeCxAdminConfig>('/threecx/admin/config') });
}

export function useThreeCxAssignments(enabled: boolean) {
  return useQuery({ queryKey: tk.assignments, queryFn: () => api<ThreeCxAssignmentList>('/threecx/admin/assignments'), enabled, retry: false });
}

export async function callViaThreeCx(number: string) {
  const id = toast.loading(`Rufe ${number} an …`);
  try {
    const r = await api<ThreeCxCallResult>('/threecx/call', { method: 'POST', body: { number } });
    toast.success(r.message, { id, description: 'Je nach Gerät klingelt zuerst dein Telefon – abheben, dann wird verbunden.' });
  } catch (err) {
    toast.error(errorMessage(err), { id });
  }
}

/**
 * Click-to-Call: `ready` ist true, wenn die Anbindung aktiv und dem Benutzer eine Nebenstelle
 * zugeordnet ist. Sonst bleibt es beim normalen tel:-Link.
 */
export function useClickToCall(): { ready: boolean; extension: string | null; call: (number: string) => void } {
  const { data } = useThreeCxMe();
  const ready = !!data?.enabled && !!data.extension;
  const call = useCallback((number: string) => void callViaThreeCx(number), []);
  return { ready, extension: data?.extension ?? null, call };
}
