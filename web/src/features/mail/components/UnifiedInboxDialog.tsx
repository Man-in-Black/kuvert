/**
 * Auswahl, welche Posteingänge in „Alle Posteingänge“ erscheinen:
 * Hauptpostfach je Konto sowie freigegebene Postfächer (Microsoft 365).
 */
import { useEffect, useState } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Inbox, Users } from 'lucide-react';
import type { AccountInfo, FolderListResult } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button, Checkbox, ColorDot, Modal } from '@/components/ui';
import { mailKeys } from '../api';

interface Selection {
  primary: boolean;
  shared: string[];
}

const norm = (s: string) => s.trim().toLowerCase();
const sharedOf = (a: AccountInfo) => [...new Set((a.settings.sharedMailboxes ?? []).map(norm).filter((s) => s.includes('@')))];
const selectionOf = (a: AccountInfo): Selection => {
  const shared = sharedOf(a);
  return { primary: a.settings.includeInUnifiedInbox !== false, shared: (a.settings.unifiedSharedMailboxes ?? []).map(norm).filter((m) => shared.includes(m)) };
};
const sameSelection = (x: Selection, y: Selection) => x.primary === y.primary && x.shared.length === y.shared.length && x.shared.every((m) => y.shared.includes(m));

export function UnifiedInboxDialog({
  open,
  onClose,
  accounts,
  folderQueries,
}: {
  open: boolean;
  onClose: () => void;
  accounts: AccountInfo[];
  folderQueries: UseQueryResult<FolderListResult>[];
}) {
  const qc = useQueryClient();
  const [sel, setSel] = useState<Record<string, Selection>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setSel(Object.fromEntries(accounts.map((a) => [a.id, selectionOf(a)])));
    // Nur beim Öffnen übernehmen, damit Hintergrund-Aktualisierungen die Auswahl nicht zurücksetzen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (id: string, fn: (s: Selection) => Selection) => setSel((prev) => (prev[id] ? { ...prev, [id]: fn(prev[id]!) } : prev));
  const total = Object.values(sel).reduce((n, s) => n + (s.primary ? 1 : 0) + s.shared.length, 0);

  const save = async () => {
    const changed = accounts.filter((a) => sel[a.id] && !sameSelection(sel[a.id]!, selectionOf(a)));
    if (!changed.length) return onClose();
    setSaving(true);
    try {
      await Promise.all(
        changed.map((a) =>
          api(`/accounts/${a.id}`, {
            method: 'PATCH',
            body: { settings: { includeInUnifiedInbox: sel[a.id]!.primary, unifiedSharedMailboxes: sel[a.id]!.shared } },
          }),
        ),
      );
      await qc.invalidateQueries({ queryKey: qk.accounts });
      await qc.invalidateQueries({ queryKey: mailKeys.lists });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Alle Posteingänge"
      description="Welche Posteingänge sollen in der gemeinsamen Ansicht erscheinen?"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {accounts.map((a, i) => {
          const s = sel[a.id];
          if (!s) return null;
          const mailboxes = folderQueries[i]?.data?.mailboxes ?? [];
          return (
            <div key={a.id}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <ColorDot color={a.color} />
                <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{a.name}</span>
              </div>
              <div className="space-y-1.5 pl-1">
                <Checkbox
                  checked={s.primary}
                  onChange={(v) => update(a.id, (x) => ({ ...x, primary: v }))}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <span className="truncate">Posteingang</span>
                      {a.email && <span className="truncate text-xs text-muted">{a.email}</span>}
                    </span>
                  }
                />
                {sharedOf(a).map((mb) => {
                  const name = mailboxes.find((m) => norm(m.id) === mb)?.name;
                  return (
                    <Checkbox
                      key={mb}
                      checked={s.shared.includes(mb)}
                      onChange={(v) => update(a.id, (x) => ({ ...x, shared: v ? [...x.shared, mb] : x.shared.filter((m) => m !== mb) }))}
                      label={
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 shrink-0 text-muted" />
                          <span className="truncate">{name && norm(name) !== mb ? name : 'Freigegebenes Postfach'}</span>
                          <span className="truncate text-xs text-muted">{mb}</span>
                        </span>
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        {total === 0 && <p className="text-xs text-warning">Ohne Auswahl bleibt „Alle Posteingänge“ leer.</p>}
      </div>
    </Modal>
  );
}
