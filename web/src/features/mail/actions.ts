/**
 * Aktionen für einzelne Nachrichten (Antworten, Archivieren …) –
 * gemeinsam genutzt von Leseansicht und Tastenkürzeln.
 */
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MessageDetail, MessageSummary } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { deleteMessages, moveToRole, setFlags, toRef, type MessageRef } from './api';
import { useOwnAddresses } from './hooks';
import { buildEditInit, buildReplyInit } from './compose/build';
import { openComposer } from './compose/store';

export function useMailActions() {
  const qc = useQueryClient();
  const own = useOwnAddresses();

  return useMemo(() => {
    const guard = async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) toast.success(ok);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    };
    return {
      reply(detail: MessageDetail, ref: MessageRef, mode: 'reply' | 'replyAll' | 'forward', bodyHtml?: string) {
        openComposer(buildReplyInit(detail, ref, mode, own, bodyHtml));
      },
      editDraft(detail: MessageDetail, ref: MessageRef) {
        openComposer(buildEditInit(detail, ref));
      },
      archive: (refs: MessageRef[]) => guard(() => moveToRole(qc, refs, 'archive'), refs.length > 1 ? `${refs.length} Nachrichten archiviert` : 'Archiviert'),
      spam: (refs: MessageRef[]) => guard(() => moveToRole(qc, refs, 'junk'), 'Als Spam verschoben'),
      notSpam: (refs: MessageRef[]) => guard(() => moveToRole(qc, refs, 'inbox'), 'In den Posteingang verschoben'),
      remove: (refs: MessageRef[], permanent?: boolean) => guard(() => deleteMessages(qc, refs, permanent), permanent ? 'Endgültig gelöscht' : 'Gelöscht'),
      toggleFlag: (msgs: MessageSummary[]) => guard(() => setFlags(qc, msgs.map(toRef), { flagged: !msgs.every((m) => m.flagged) })),
      toggleSeen: (msgs: MessageSummary[]) => {
        const seen = !msgs.every((m) => m.seen);
        return guard(() => setFlags(qc, msgs.map(toRef), { seen }, msgs));
      },
      markSeen: (m: MessageSummary) => guard(() => setFlags(qc, [toRef(m)], { seen: true }, [m])),
    };
  }, [qc, own]);
}
