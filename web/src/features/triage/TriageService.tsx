import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useServerEvent } from '@/lib/events';
import { patchMessages } from '@/features/mail/api';
import { clearTriagePending, useTriagePending } from '@/features/mail/triage-pending';
import { fetchTriageStatus, triageKeys } from './api';

/** Abfrageintervall, solange eine angestoßene Einordnung läuft */
const PENDING_POLL_MS = 4000;

/**
 * Übernimmt fertige Einordnungen in Listen und Leseansicht, ohne neu zu laden, und
 * beendet die „wird eingeordnet …“-Animation – per Ereignis, oder wenn die Warteschlange
 * leer ist (Fehlschlag, Stopp, Antwort nicht auswertbar).
 */
export function TriageService() {
  const qc = useQueryClient();
  const { hasAny } = useTriagePending();

  useServerEvent('mail.triage', (e) => {
    const refs = e.items.map((it) => ({ accountId: e.accountId, folderId: it.folderId, id: it.id }));
    for (const [i, it] of e.items.entries()) patchMessages(qc, [refs[i]!], { triage: it.triage ?? undefined });
    clearTriagePending(refs);
    void qc.invalidateQueries({ queryKey: triageKeys.status });
    void qc.invalidateQueries({ queryKey: triageKeys.failed });
  });

  useEffect(() => {
    if (!hasAny) return;
    let stopped = false;
    const timer = setInterval(() => {
      void fetchTriageStatus()
        .then((s) => {
          if (stopped) return;
          qc.setQueryData(triageKeys.status, s);
          if (s.queued === 0) {
            clearTriagePending();
            void qc.invalidateQueries({ queryKey: triageKeys.failed });
          }
        })
        .catch(() => {
          /* nächster Versuch */
        });
    }, PENDING_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hasAny, qc]);

  return null;
}
