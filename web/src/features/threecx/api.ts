/** API-Zugriffe und Hooks der 3CX-Anbindung. */
import { useCallback } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ThreeCxActiveCall,
  ThreeCxAdminConfig,
  ThreeCxAssignmentList,
  ThreeCxCallLog,
  ThreeCxCallResult,
  ThreeCxColleagueList,
  ThreeCxContact,
  ThreeCxMe,
} from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useFeature } from '@/lib/queries';

export const tk = {
  all: ['threecx'] as const,
  me: ['threecx', 'me'] as const,
  adminConfig: ['threecx', 'admin', 'config'] as const,
  assignments: ['threecx', 'admin', 'assignments'] as const,
  active: ['threecx', 'active'] as const,
  log: (days: number) => ['threecx', 'log', days] as const,
  contacts: (q: string) => ['threecx', 'contacts', q] as const,
  colleagues: ['threecx', 'colleagues'] as const,
};

/** Laufende Gespräche: alle 3 s, solange die Seite sichtbar ist */
export function useActiveCalls(enabled: boolean) {
  return useQuery({
    queryKey: tk.active,
    queryFn: () => api<ThreeCxActiveCall[]>('/threecx/calls/active'),
    enabled,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useCallLog(days: number, enabled: boolean) {
  return useQuery({ queryKey: tk.log(days), queryFn: () => api<ThreeCxCallLog>('/threecx/calls/log', { query: { days } }), enabled, staleTime: 30_000, retry: false });
}

export function useThreeCxContacts(q: string, enabled: boolean) {
  return useQuery({
    queryKey: tk.contacts(q),
    queryFn: () => api<ThreeCxContact[]>('/threecx/contacts', { query: { q: q || undefined } }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

export function useColleagues(enabled: boolean) {
  return useQuery({
    queryKey: tk.colleagues,
    queryFn: () => api<ThreeCxColleagueList>('/threecx/colleagues'),
    enabled,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

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

/** Anruf über 3CX starten; true bei Erfolg */
export async function callViaThreeCx(number: string): Promise<boolean> {
  const id = toast.loading(`Rufe ${number} an …`);
  try {
    const r = await api<ThreeCxCallResult>('/threecx/call', { method: 'POST', body: { number } });
    toast.success(r.message, { id, description: 'Je nach Gerät klingelt zuerst dein Telefon – abheben, dann wird verbunden.' });
    return true;
  } catch (err) {
    toast.error(errorMessage(err), { id });
    return false;
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
