import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, RotateCcw, XCircle } from 'lucide-react';
import type { ScheduledSend } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { Badge, Button, ColorDot, EmptyState, Spinner } from '@/components/ui';
import { SectionHeader, formatDate } from '../ui';

const STATUS: Record<ScheduledSend['status'], { label: string; color: string }> = {
  pending: { label: 'Geplant', color: 'var(--k-primary)' },
  sending: { label: 'Wird gesendet', color: 'var(--k-warning)' },
  sent: { label: 'Gesendet', color: 'var(--k-success)' },
  failed: { label: 'Fehlgeschlagen', color: 'var(--k-danger)' },
  cancelled: { label: 'Abgebrochen', color: 'var(--k-muted)' },
};

export function ScheduledSection() {
  const qc = useQueryClient();
  const accounts = useAccountMap();
  const { data = [], isLoading } = useQuery({
    queryKey: ['mail', 'scheduled'],
    queryFn: () => api<ScheduledSend[]>('/mail/scheduled'),
    refetchInterval: 15_000,
  });

  const act = async (job: ScheduledSend, action: 'cancel' | 'retry') => {
    try {
      await api(`/mail/scheduled/${job.id}/${action}`, { method: 'POST' });
      toast.success(action === 'cancel' ? 'Versand abgebrochen' : 'Versand wird erneut versucht');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      qc.invalidateQueries({ queryKey: ['mail', 'scheduled'] });
    }
  };

  return (
    <div>
      <SectionHeader title="Geplanter Versand" description="Nachrichten, die später gesendet werden, sowie fehlgeschlagene Sendungen der letzten 24 Stunden." />
      {isLoading && <Spinner />}
      {!isLoading && data.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState icon={<Clock />} title="Keine geplanten Nachrichten" />
        </div>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {data.map((job) => {
          const acc = accounts.get(job.accountId);
          const st = STATUS[job.status];
          return (
            <div key={job.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <ColorDot color={acc?.color} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{job.subject || '(kein Betreff)'}</div>
                <div className="truncate text-xs text-muted">
                  An {job.to.map((t) => t.name || t.address).join(', ') || '–'} · {acc?.name ?? 'Unbekanntes Konto'} · {formatDate(job.sendAt)}
                </div>
                {job.error && <div className="mt-1 text-xs text-danger">{job.error}</div>}
              </div>
              <Badge color={st.color}>{st.label}</Badge>
              {job.status === 'pending' && (
                <Button size="sm" variant="ghost" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => act(job, 'cancel')}>
                  Abbrechen
                </Button>
              )}
              {job.status === 'failed' && (
                <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => act(job, 'retry')}>
                  Erneut senden
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
