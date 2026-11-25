import type { QueryClient } from '@tanstack/react-query';
import type { MessageSummary, TriageFailure, TriageInfo, TriagePriority, TriageRunResult, TriageStatus } from '@kuvert/shared';
import { api } from '@/lib/api';
import { patchMessages, type MessageRef } from '@/features/mail/api';

export const triageKeys = {
  status: ['triage', 'status'] as const,
  failed: ['triage', 'failed'] as const,
};

export type TriageStatusResponse = TriageStatus & { stats: { total: number; byPriority: Record<string, number> } };

export const fetchTriageStatus = () => api<TriageStatusResponse>('/triage/status');

/** Nachrichten (neu) einordnen lassen – das Ergebnis kommt per Ereignis "mail.triage" */
export const runTriage = (accountId: string, folderId: string, ids: string[]) =>
  api<TriageRunResult>('/triage/run', { method: 'POST', body: { accountId, folderId, ids } });

export const fetchFailedTriage = () => api<TriageFailure[]>('/triage/failed');
export const retryFailedTriage = () => api<TriageRunResult>('/triage/failed/retry', { method: 'POST', body: {} });
export const clearFailedTriage = () => api<{ removed: number }>('/triage/failed/clear', { method: 'POST', body: {} });

export const stopTriage = () => api<{ stopped: number }>('/triage/stop', { method: 'POST', body: {} });

export const triageInbox = (limit: number) => api<TriageRunResult>('/triage/inbox', { method: 'POST', body: { limit } });

type Target = MessageRef & Pick<MessageSummary, 'messageIdHeader'>;

export interface TriagePatch {
  priority?: TriagePriority;
  category?: string;
  done?: boolean;
}

const refBody = (m: Target) => ({ accountId: m.accountId, folderId: m.folderId, id: m.id, messageIdHeader: m.messageIdHeader });

/** Einordnung von Hand überschreiben (nicht angegebene Felder bleiben) */
export async function setTriage(qc: QueryClient, m: Target, patch: TriagePatch) {
  const triage = await api<TriageInfo>('/triage/message', { method: 'PUT', body: { ...refBody(m), ...patch } });
  patchMessages(qc, [m], { triage });
}

/** Mehrere Nachrichten (z. B. eine Unterhaltung) überschreiben – Caches folgen per Ereignis "mail.triage" */
export const setTriageMany = (items: Target[], patch: TriagePatch) =>
  api<{ updated: number }>('/triage/messages', { method: 'POST', body: { items: items.map(refBody), ...patch } });

/** Mehrere Nachrichten über Ordner hinweg neu einordnen lassen */
export const runTriageMany = (items: Target[]) => api<TriageRunResult>('/triage/run-many', { method: 'POST', body: { items: items.map(refBody) } });

export async function removeTriage(qc: QueryClient, m: Target) {
  await api('/triage/message/remove', { method: 'POST', body: refBody(m) });
  patchMessages(qc, [m], { triage: undefined });
}
