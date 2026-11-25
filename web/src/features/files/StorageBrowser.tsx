/**
 * Auswahldialog für Cloud-Speicher (OneDrive, Google Drive, Nextcloud …).
 * Wird u. a. vom Mail-Bereich genutzt: "Anhang aus Cloud" und "Anhang in Cloud speichern".
 */
import { useEffect, useState } from 'react';
import { Cloud, FolderInput, Search } from 'lucide-react';
import type { StorageItem } from '@kuvert/shared';
import { Button, EmptyState, Input, Modal, Select } from '@/components/ui';
import { useAccountsWith } from '@/lib/queries';
import { Breadcrumbs, StorageItemList, useStorageNav } from './browser';

export interface StoragePickResult {
  accountId: string;
  item: StorageItem;
}

export interface StoragePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** "file" = Datei(en) wählen (Anhang aus Cloud), "folder" = Zielordner wählen (Anhang in Cloud speichern) */
  mode: 'file' | 'folder';
  title?: string;
  multiple?: boolean;
  /** Bei mode "file": gewählte Dateien; bei mode "folder": gewählter Ordner (item.id = Ordner-ID, Wurzel = item.id "") */
  onPick: (picked: StoragePickResult[]) => void;
}

export function StoragePickerDialog({ open, onClose, mode, title, multiple, onPick }: StoragePickerDialogProps) {
  const accounts = useAccountsWith('storage');
  const nav = useStorageNav(accounts, 'kuvert.files.account');
  const [selected, setSelected] = useState<Map<string, StorageItem>>(new Map());

  // Auswahl beim Öffnen bzw. Kontowechsel zurücksetzen
  useEffect(() => {
    if (open) setSelected(new Map());
  }, [open, nav.accountId]);

  if (!open) return null;

  const toggle = (item: StorageItem) => {
    setSelected((prev) => {
      const next = new Map(multiple ? prev : []);
      if (prev.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  };

  const currentFolder = (): StorageItem => {
    const crumb = nav.crumbs[nav.crumbs.length - 1]!;
    return {
      id: crumb.id,
      accountId: nav.accountId!,
      name: crumb.name,
      isFolder: true,
      parentId: nav.crumbs.length > 1 ? nav.crumbs[nav.crumbs.length - 2]!.id : null,
    };
  };

  const confirm = () => {
    if (!nav.accountId) return;
    if (mode === 'folder') onPick([{ accountId: nav.accountId, item: currentFolder() }]);
    else onPick([...selected.values()].map((item) => ({ accountId: nav.accountId!, item: { ...item, accountId: item.accountId || nav.accountId! } })));
    onClose();
  };

  const folderMode = mode === 'folder';
  const count = selected.size;

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      title={title ?? (folderMode ? 'Zielordner wählen' : multiple ? 'Dateien auswählen' : 'Datei auswählen')}
      className="h-[80vh]"
      footer={
        accounts.length > 0 ? (
          <>
            {folderMode && (
              <div className="mr-auto flex min-w-0 items-center gap-1.5 text-sm text-muted">
                <FolderInput className="h-4 w-4 shrink-0" />
                <span className="truncate">Ziel: {nav.crumbs.map((c) => c.name).join(' / ')}</span>
              </div>
            )}
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" disabled={folderMode ? !!nav.debouncedSearch || !nav.accountId : count === 0} onClick={confirm}>
              {folderMode ? 'Hier speichern' : count > 1 ? `${count} Dateien auswählen` : 'Auswählen'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      {accounts.length === 0 ? (
        <EmptyState icon={<Cloud />} title="Kein Cloud-Speicher verbunden">
          Verbinde OneDrive, Google Drive oder Nextcloud in den Kontoeinstellungen.
        </EmptyState>
      ) : (
        <div className="-m-5 flex h-[calc(100%+2.5rem)] flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            {accounts.length > 1 && (
              <Select className="w-52" value={nav.accountId} onChange={(e) => nav.setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input className="pl-8" placeholder={folderMode ? 'Ordner suchen' : 'Dateien suchen'} value={nav.search} onChange={(e) => nav.setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
            <Breadcrumbs crumbs={nav.crumbs} onGo={nav.goTo} searching={!!nav.debouncedSearch} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <StorageItemList
              accountId={nav.accountId}
              folderId={nav.folderId}
              search={nav.debouncedSearch}
              selectedIds={new Set(selected.keys())}
              dimFiles={folderMode}
              onItemClick={(item) => {
                if (item.isFolder) nav.open(item);
                else if (!folderMode) toggle(item);
              }}
              onItemDoubleClick={(item) => {
                if (!item.isFolder && !folderMode) {
                  onPick([{ accountId: nav.accountId!, item }]);
                  onClose();
                }
              }}
              emptyHint={folderMode ? 'Mit „Hier speichern“ wird dieser Ordner als Ziel verwendet.' : undefined}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
