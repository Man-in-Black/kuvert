/**
 * Einstellungen → KI-Triage: endgültig fehlgeschlagene Einordnungen anzeigen,
 * gesammelt wiederholen oder verwerfen.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button, Spinner } from '@/components/ui';
import { messageUrl } from '@/features/mail/links';
import { clearFailedTriage, fetchFailedTriage, retryFailedTriage, triageKeys } from './api';

export function FailedTriage({ count, disabled }: { count: number; disabled?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: items, isLoading } = useQuery({ queryKey: triageKeys.failed, queryFn: fetchFailedTriage, enabled: open });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: triageKeys.status });
    void qc.invalidateQueries({ queryKey: triageKeys.failed });
  };
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast.success(await fn());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!count) return null;
  return (
    <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <XCircle className="h-4 w-4 shrink-0 text-danger" />
        <button type="button" className="flex items-center gap-1 font-medium text-danger hover:underline" onClick={() => setOpen((o) => !o)}>
          {count === 1 ? '1 Einordnung' : `${count} Einordnungen`} fehlgeschlagen
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          disabled={busy || disabled}
          onClick={() =>
            void act(async () => {
              const r = await retryFailedTriage();
              return r.queued ? `${r.queued} Einordnungen werden wiederholt` : 'Alle sind bereits in Arbeit';
            })
          }
        >
          Wiederholen
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          disabled={busy}
          title="Liste leeren, ohne zu wiederholen"
          onClick={() =>
            void act(async () => {
              await clearFailedTriage();
              return 'Liste geleert';
            })
          }
        >
          Verwerfen
        </Button>
      </div>

      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto border-t border-danger/20 pt-2">
          {isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <ul className="space-y-1.5">
              {(items ?? []).map((f) => (
                <li key={`${f.accountId}|${f.folderId}|${f.messageId}`} className="text-xs">
                  <div className="flex items-baseline gap-2">
                    <Link
                      to={messageUrl({ accountId: f.accountId, folderId: f.folderId, id: f.messageId })}
                      className="min-w-0 flex-1 truncate font-medium text-fg hover:underline"
                    >
                      {f.subject || '(Betreff unbekannt)'}
                    </Link>
                    <span className="shrink-0 text-muted">{formatDateTime(f.failedAt)}</span>
                  </div>
                  <div className="truncate text-muted" title={f.error}>
                    {f.from ? `${f.from} · ` : ''}
                    {f.error}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
