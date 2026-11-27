/**
 * Aufgabe aus einer E-Mail anlegen: Titel = Betreff, wählbare Liste (Kuvert, To Do, Google …).
 * Kuvert-eigene Aufgaben merken sich die Mail; bei anderen Anbietern steht ein Link in den Notizen.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail } from 'lucide-react';
import type { MessageDetail, TaskInput, TaskList } from '@kuvert/shared';
import { Button, Checkbox, Field, Input, Modal, Select, Spinner, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { cleanSubject, mailSource } from '@/features/mail/mail-source';
import { LOCAL_SOURCE_ID, createTask, lastUsedList, listKey, rememberList, toDueValue, useTaskLists } from './api';

export default function TaskFromMailDialog({
  accountId,
  folderId,
  message,
  onClose,
}: {
  accountId: string;
  folderId: string;
  message: MessageDetail;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accountMap = useAccountMap();
  const { data, isLoading } = useTaskLists();
  const lists = useMemo(() => data?.lists ?? [], [data]);
  const src = useMemo(() => mailSource(accountId, folderId, message), [accountId, folderId, message]);

  const [title, setTitle] = useState(() => cleanSubject(src.subject));
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [important, setImportant] = useState(false);
  const [notes, setNotes] = useState('');
  const [withText, setWithText] = useState(false);
  const [saving, setSaving] = useState(false);

  // Vorauswahl: zuletzt benutzte Liste, sonst Kuvert-Standardliste
  const defaultKey = useMemo(() => {
    const last = lastUsedList();
    if (last && lists.some((l) => listKey(l) === last)) return last;
    const pick = lists.find((l) => l.accountId === LOCAL_SOURCE_ID && l.isDefault) ?? lists.find((l) => l.isDefault) ?? lists[0];
    return pick ? listKey(pick) : '';
  }, [lists]);
  const selectedKey = pickedKey ?? defaultKey;
  const list = lists.find((l) => listKey(l) === selectedKey);
  const isLocal = list?.accountId === LOCAL_SOURCE_ID;

  const grouped = useMemo(() => {
    const m = new Map<string, TaskList[]>();
    for (const l of lists) m.set(l.accountId, [...(m.get(l.accountId) ?? []), l]);
    return [...m.entries()];
  }, [lists]);

  const save = async () => {
    if (!list) {
      toast.error('Bitte eine Aufgabenliste wählen');
      return;
    }
    const parts = [notes.trim()];
    if (withText) parts.push(src.excerpt(4000));
    // Andere Anbieter kennen den Mail-Verweis nicht – dann als Link in die Notizen
    if (!isLocal) parts.push(`E-Mail: ${src.subject}${src.fromLabel ? ` (von ${src.fromLabel})` : ''}\n${src.url}`);
    const input: TaskInput = {
      title: title.trim() || src.subject,
      notes: parts.filter(Boolean).join('\n\n'),
      due: toDueValue(due || null),
      importance: important ? 'high' : 'normal',
      ...(isLocal ? { mailRef: src.ref } : {}),
    };
    setSaving(true);
    try {
      await createTask(list.accountId, list.id, input);
      rememberList(list);
      await qc.invalidateQueries({ queryKey: ['tasks', 'items', list.accountId, list.id] });
      toast.success('Aufgabe angelegt', {
        description: list.name,
        action: { label: 'Anzeigen', onClick: () => navigate('/tasks') },
      });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Aufgabe aus E-Mail"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={saving} disabled={!list} onClick={save}>
            Aufgabe anlegen
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input autoFocus placeholder="Was ist zu tun?" className="h-11 text-base font-medium" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{src.subject}</span>
              {src.fromLabel && <span className="block truncate">von {src.fromLabel}</span>}
              <span className="block">{isLocal ? 'Die Aufgabe verlinkt auf diese E-Mail.' : 'Ein Link auf diese E-Mail kommt in die Notizen.'}</span>
            </span>
          </div>
          <Field label="Liste">
            <Select value={selectedKey} onChange={(e) => setPickedKey(e.target.value)}>
              {!list && <option value="">– Liste wählen –</option>}
              {grouped.map(([accId, ls]) => (
                <optgroup key={accId} label={ls[0]?.sourceName ?? accountMap.get(accId)?.name ?? accId}>
                  {ls.map((l) => (
                    <option key={listKey(l)} value={listKey(l)}>
                      {l.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="Fällig am">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <div className="pb-2">
              <Checkbox checked={important} onChange={setImportant} label="Wichtig" />
            </div>
          </div>
          <Field label="Notizen">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
          <Checkbox checked={withText} onChange={setWithText} label="Text der E-Mail in die Notizen übernehmen" />
          <button type="submit" className="hidden" />
        </form>
      )}
    </Modal>
  );
}
