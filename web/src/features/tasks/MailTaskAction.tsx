/** Knopf „Aufgabe erstellen“ in der Nachrichtenansicht */
import { lazy, Suspense, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { IconButton } from '@/components/ui';
import type { MessageExtensionProps } from '@/features/mail/extension-types';

const TaskFromMailDialog = lazy(() => import('./TaskFromMailDialog'));

export function MailTaskAction({ accountId, folderId, message }: MessageExtensionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="Aufgabe erstellen" size="icon-sm" onClick={() => setOpen(true)}>
        <ListPlus className="h-4 w-4" />
      </IconButton>
      {open && (
        <Suspense fallback={null}>
          <TaskFromMailDialog accountId={accountId} folderId={folderId} message={message} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
