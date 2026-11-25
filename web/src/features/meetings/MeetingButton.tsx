/**
 * "Online-Meeting einfügen" (Microsoft Teams / Google Meet) im Verfassen-Fenster.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addMinutes, format, startOfHour, addHours } from 'date-fns';
import { Video } from 'lucide-react';
import type { AccountInfo, OnlineMeeting } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { escapeHtml } from '@/lib/utils';
import { Button, Field, Input, Modal, Select, Spinner } from '@/components/ui';
import type { ComposerExtensionProps } from '@/features/mail/extension-types';

export function providerLabel(a?: AccountInfo): string {
  if (!a) return 'Online-Meeting';
  if (a.type === 'microsoft') return 'Teams-Meeting';
  if (a.type === 'google') return 'Google Meet';
  return 'Online-Meeting';
}

const DURATIONS = [15, 30, 45, 60, 90, 120];

export function MeetingButton(props: ComposerExtensionProps) {
  const [open, setOpen] = useState(false);
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['meetings', 'accounts'],
    queryFn: () => api<AccountInfo[]>('/meetings/accounts'),
    staleTime: 5 * 60_000,
  });
  const preferred = accounts.find((a) => a.id === props.draft.accountId) ?? accounts[0];
  const label = providerLabel(preferred);

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2"
        title={`${label} einfügen`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
        disabled={!isLoading && !accounts.length}
      >
        <Video className="h-4 w-4" />
        <span className="hidden sm:inline">{preferred?.type === 'microsoft' ? 'Teams' : preferred?.type === 'google' ? 'Meet' : 'Meeting'}</span>
      </Button>
      {open && <MeetingDialog {...props} accounts={accounts} preferredId={preferred?.id} onClose={() => setOpen(false)} />}
    </>
  );
}

function MeetingDialog({
  accounts,
  preferredId,
  onClose,
  draft,
  insertHtml,
}: ComposerExtensionProps & { accounts: AccountInfo[]; preferredId?: string; onClose: () => void }) {
  const defaultStart = useMemo(() => addHours(startOfHour(new Date()), 1), []);
  const [accountId, setAccountId] = useState(preferredId ?? '');
  const [subject, setSubject] = useState(draft.message.subject || 'Besprechung');
  const [date, setDate] = useState(format(defaultStart, 'yyyy-MM-dd'));
  const [time, setTime] = useState(format(defaultStart, 'HH:mm'));
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accountId && preferredId) setAccountId(preferredId);
  }, [accountId, preferredId]);

  const account = accounts.find((a) => a.id === accountId);

  const create = async () => {
    const start = new Date(`${date}T${time}`);
    if (Number.isNaN(start.getTime())) return toast.error('Ungültiger Zeitpunkt');
    const end = addMinutes(start, duration);
    setBusy(true);
    try {
      const m = await api<OnlineMeeting>(`/meetings/accounts/${accountId}`, {
        method: 'POST',
        body: { subject: subject || 'Besprechung', start: start.toISOString(), end: end.toISOString() },
      });
      const html =
        m.html ||
        `<p><b>${escapeHtml(providerLabel(account))}</b><br>${escapeHtml(format(start, "EEEE, dd.MM.yyyy 'um' HH:mm"))} – ${escapeHtml(format(end, 'HH:mm'))}<br><a href="${escapeHtml(m.joinUrl)}">Jetzt an der Besprechung teilnehmen</a></p>`;
      insertHtml(html);
      toast.success(`${providerLabel(account)} erstellt`);
      onClose();
    } catch (err) {
      toast.error(`Meeting konnte nicht erstellt werden: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`${providerLabel(account)} einfügen`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!accountId} onClick={() => void create()}>
            Erstellen & einfügen
          </Button>
        </>
      }
    >
      {!accounts.length ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.length > 1 && (
            <Field label="Konto">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {providerLabel(a)} – {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Titel">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Datum">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Beginn">
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="Dauer">
              <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d < 60 ? `${d} Min.` : `${d / 60} Std.`.replace('.5 ', ',5 ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-muted">Der Teilnahmelink wird an der Cursorposition in die Nachricht eingefügt.</p>
        </div>
      )}
    </Modal>
  );
}
