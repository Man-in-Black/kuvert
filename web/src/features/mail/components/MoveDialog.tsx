import { useMemo, useState } from 'react';
import { Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input, Modal, Spinner } from '@/components/ui';
import { buildFolderTree, flattenTree, folderLabel } from '../api';
import { useFolders } from '../hooks';
import { FolderIcon } from './FolderIcon';

/** Zielordner wählen (innerhalb eines Kontos) */
export function MoveDialog({
  open,
  accountId,
  excludeFolderId,
  onClose,
  onPick,
}: {
  open: boolean;
  accountId: string | undefined;
  excludeFolderId?: string;
  onClose: () => void;
  onPick: (folderId: string) => void;
}) {
  const { data, isLoading } = useFolders(open ? accountId : undefined);
  const [filter, setFilter] = useState('');
  const nodes = useMemo(() => flattenTree(buildFolderTree(data?.folders ?? [])), [data]);
  const mailboxes = data?.mailboxes ?? [];
  const list = nodes.filter((n) => n.folder.selectable !== false && n.folder.id !== excludeFolderId && folderLabel(n.folder).toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Verschieben nach …" size="md">
      <Input placeholder="Ordner suchen …" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus className="mb-3" />
      {isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-auto">
          {list.map((n) => {
            const mb = mailboxes.length > 1 ? mailboxes.find((m) => m.id === n.folder.mailboxId) : undefined;
            return (
              <button
                key={n.folder.id}
                type="button"
                onClick={() => {
                  onPick(n.folder.id);
                  onClose();
                }}
                className={cn('flex w-full items-center gap-2 rounded-md py-1.5 pr-3 text-left text-sm hover:bg-hover')}
                style={{ paddingLeft: 12 + (filter ? 0 : n.depth * 16) }}
              >
                {n.folder.role !== 'other' ? <FolderIcon role={n.folder.role} className="h-4 w-4 text-muted" /> : <Folder className="h-4 w-4 text-muted" />}
                <span className="truncate">{folderLabel(n.folder)}</span>
                {mb && <span className="ml-auto truncate text-xs text-muted">{mb.name}</span>}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
