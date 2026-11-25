import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import type { AdminUser, AuditEntry } from '@kuvert/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, PageHeader, Select, Skeleton, Table, Td, Th } from '@/components/ui';
import { absoluteTime, relativeTime } from '@/features/profile/format';
import { AUDIT_GROUPS, auditLabel, auditTone } from './audit-labels';

const PAGE = 50;

export function AuditSection() {
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const { data: users } = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'audit', userId, action, page],
    queryFn: () => api<{ items: AuditEntry[]; total: number }>('/admin/audit', { query: { userId, action, limit: PAGE, offset: page * PAGE } }),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));

  return (
    <div className="space-y-5">
      <PageHeader icon={<ScrollText />} title="Audit-Log" description="Sicherheitsrelevante Vorgänge der letzten 12 Monate: Anmeldungen, 2FA, Admin-Aktionen, API-Tokens und Konten." />

      <div className="flex flex-wrap items-center gap-3">
        <Select
          className="w-64"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Alle Benutzer</option>
          {(users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.email})
            </option>
          ))}
        </Select>
        <Select
          className="w-56"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(0);
          }}
        >
          {AUDIT_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-muted">{data ? `${data.total} Einträge` : ''}</span>
      </div>

      {isLoading ? (
        <Skeleton className="h-80 w-full rounded-2xl" />
      ) : !data?.items.length ? (
        <div className="rounded-2xl border border-dashed border-border py-10">
          <EmptyState icon={<ScrollText />} title="Keine Einträge" />
        </div>
      ) : (
        <Table className={cn(isFetching && 'opacity-70 transition-opacity')}>
          <thead>
            <tr>
              <Th className="w-40">Zeitpunkt</Th>
              <Th>Ereignis</Th>
              <Th className="hidden md:table-cell">Ausgelöst von</Th>
              <Th className="hidden lg:table-cell">IP</Th>
              <Th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => {
              const hasDetails = !!e.details && Object.keys(e.details).length > 0;
              const expanded = open === e.id;
              return (
                <Fragment key={e.id}>
                  <tr className={cn('transition-colors', hasDetails && 'cursor-pointer hover:bg-hover/50')} onClick={() => hasDetails && setOpen(expanded ? null : e.id)}>
                    <Td className="whitespace-nowrap text-muted" title={absoluteTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={auditTone(e.action)}>{auditLabel(e.action)}</Badge>
                        {e.userEmail && e.userEmail !== e.actorEmail && <span className="text-xs text-muted">→ {e.userEmail}</span>}
                      </div>
                      <code className="mt-0.5 block font-mono text-[10px] text-subtle">{e.action}</code>
                    </Td>
                    <Td className="hidden md:table-cell">{e.actorEmail ?? <span className="text-muted">{(e.details?.email as string) ?? 'System'}</span>}</Td>
                    <Td className="hidden font-mono text-xs text-muted lg:table-cell">{e.ip ?? '–'}</Td>
                    <Td>{hasDetails && <ChevronDown className={cn('h-4 w-4 text-subtle transition-transform', expanded && 'rotate-180')} />}</Td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={5} className="border-b border-border bg-surface-2/60 px-4 py-3">
                        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-fg/80">{JSON.stringify(e.details, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" icon={<ChevronLeft className="h-3.5 w-3.5" />} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Zurück
          </Button>
          <span className="text-xs tabular-nums text-muted">
            Seite {page + 1} / {pages}
          </span>
          <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Weiter <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
