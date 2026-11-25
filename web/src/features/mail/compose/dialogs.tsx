import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, nextMonday, setHours, setMinutes, startOfHour, addHours } from 'date-fns';
import { de } from 'date-fns/locale';
import { FileText } from 'lucide-react';
import type { Template } from '@kuvert/shared';
import { api } from '@/lib/api';
import { Button, EmptyState, Field, Input, Modal, Spinner } from '@/components/ui';

const toLocalInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

/** "Später senden" – Zeitpunkt wählen */
export function ScheduleDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (iso: string) => void }) {
  const [value, setValue] = useState(() => toLocalInput(addHours(startOfHour(new Date()), 2)));
  const at8 = (d: Date) => setMinutes(setHours(d, 8), 0);
  const presets = [
    { label: 'In 1 Stunde', date: addHours(new Date(), 1) },
    { label: 'Morgen früh (8:00)', date: at8(addDays(new Date(), 1)) },
    { label: 'Morgen Nachmittag (13:00)', date: setMinutes(setHours(addDays(new Date(), 1), 13), 0) },
    { label: 'Montag früh (8:00)', date: at8(nextMonday(new Date())) },
  ];
  const submit = (d: Date) => {
    if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 30_000) return;
    onPick(d.toISOString());
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Später senden"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => submit(new Date(value))}>
            Planen
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => submit(p.date)}
            className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-hover"
          >
            <span>{p.label}</span>
            <span className="text-xs text-muted">{format(p.date, 'EEE, d. MMM HH:mm', { locale: de })}</span>
          </button>
        ))}
        <Field label="Eigener Zeitpunkt" className="pt-2">
          <Input type="datetime-local" value={value} min={toLocalInput(new Date())} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Vorlagen / Textbausteine einfügen */
export function TemplatesDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (t: Template) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['templates'], queryFn: () => api<Template[]>('/templates'), enabled: open });
  const [filter, setFilter] = useState('');
  const list = (data ?? []).filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Vorlage einfügen" size="md">
      <Input placeholder="Vorlagen durchsuchen …" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus className="mb-3" />
      {isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<FileText />} title="Keine Vorlagen">
          Vorlagen lassen sich in den Einstellungen anlegen.
        </EmptyState>
      ) : (
        <div className="max-h-96 space-y-1 overflow-auto">
          {list.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onPick(t);
                onClose();
              }}
              className="flex w-full flex-col rounded-md px-3 py-2 text-left hover:bg-hover"
            >
              <span className="text-sm font-medium">{t.name}</span>
              {t.subject && <span className="text-xs text-muted">Betreff: {t.subject}</span>}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
