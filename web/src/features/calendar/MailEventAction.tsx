/** Knopf „Termin erstellen“ in der Nachrichtenansicht */
import { lazy, Suspense, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Dropdown, IconButton } from '@/components/ui';
import type { MessageExtensionProps } from '@/features/mail/extension-types';
import type { MailEventMode } from './EventFromMailDialog';

const EventFromMailDialog = lazy(() => import('./EventFromMailDialog'));

export function MailEventAction({ accountId, folderId, message }: MessageExtensionProps) {
  const [mode, setMode] = useState<MailEventMode | null>(null);
  const others = [...(message.to ?? []), ...(message.cc ?? [])].length > 1;
  return (
    <>
      <Dropdown
        trigger={
          <IconButton label="Termin erstellen" size="icon-sm">
            <CalendarPlus className="h-4 w-4" />
          </IconButton>
        }
        items={[
          { label: 'Termin erstellen', onClick: () => setMode('plain') },
          ...(message.from?.address ? [{ label: 'Besprechung mit Absender …', onClick: () => setMode('sender') }] : []),
          ...(others ? [{ label: 'Besprechung mit allen Beteiligten …', onClick: () => setMode('all') }] : []),
        ]}
      />
      {mode && (
        <Suspense fallback={null}>
          <EventFromMailDialog accountId={accountId} folderId={folderId} message={message} mode={mode} onClose={() => setMode(null)} />
        </Suspense>
      )}
    </>
  );
}
