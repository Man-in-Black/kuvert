import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarClock, PenLine, RotateCcw, X } from 'lucide-react';
import type { ScheduledSend } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { Badge, Button, ColorDot, EmptyState, Spinner } from '@/components/ui';
import { fetchScheduled, mailKeys } from './api';
import { cancelJob, restoreInit, retryJob } from './compose/send';
import { openComposer } from './compose/store';

const STATUS: Record<ScheduledSend['status'], { label: string; color: string }> = {
  pending: { label: 'Geplant', color: '#2563eb' },
  sending: { label: 'Wird gesendet', color: '#d97706' },
  sent: { label: 'Gesendet', color: '#16a34a' },
  failed: { label: 'Fehlgeschlagen', color: '#dc2626' },
  cancelled: { label: 'Abgebrochen', color: '#6b7280' },
};

/** Geplanter / verzögerter Versand */
export function ScheduledView() {
  const qc = useQueryClient();
  const accounts = useAccountMap();
  const { data, isLoading, error } = useQuery({ queryKey: mailKeys.scheduled, queryFn: fetchScheduled, refetchInterval: 30_000 });

  const refresh = () => void qc.invalidateQueries({ queryKey: mailKeys.scheduled });

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold">Geplanter Versand</h1>
        <div className="text-xs text-muted">Später gesendete und zurückgehaltene Nachrichten</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : error ? (
          <EmptyState title="Fehler">{errorMessage(error)}</EmptyState>
        ) : !data?.length ? (
          <EmptyState icon={<CalendarClock />} title="Keine geplanten Nachrichten">
            Über „Später senden“ im Verfassen-Fenster lassen sich Nachrichten zeitversetzt verschicken.
          </EmptyState>
        ) : (
          data.map((j) => {
            const acc = accounts.get(j.accountId);
            const st = STATUS[j.status];
            return (
              <div key={j.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
                <ColorDot color={acc?.color} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{j.subject || '(ohne Betreff)'}</div>
                  <div className="truncate text-xs text-muted">
                    an {j.to.map((a) => a.name || a.address).join(', ')} · {format(new Date(j.sendAt), "EEE, d. MMM yyyy 'um' HH:mm", { locale: de })}
                  </div>
                  {j.error && <div className="truncate text-xs text-danger">{j.error}</div>}
                </div>
                <Badge color={st.color}>{st.label}</Badge>
                {j.status === 'pending' && (
                  <>
                    <Button
                      size="sm"
                      icon={<PenLine className="h-3.5 w-3.5" />}
                      onClick={async () => {
                        const msg = await cancelJob(j.id);
                        if (msg) openComposer(restoreInit(j.accountId, msg));
                        refresh();
                      }}
                    >
                      Bearbeiten
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<X className="h-3.5 w-3.5" />}
                      onClick={async () => {
                        await cancelJob(j.id);
                        refresh();
                      }}
                    >
                      Abbrechen
                    </Button>
                  </>
                )}
                {j.status === 'failed' && (
                  <Button
                    size="sm"
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                    onClick={async () => {
                      await retryJob(j.id);
                      refresh();
                    }}
                  >
                    Erneut senden
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
