import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal, Textarea } from '@/components/ui';

const LANGS = ['Deutsch', 'Englisch', 'Französisch', 'Spanisch', 'Italienisch', 'Niederländisch', 'Polnisch', 'Portugiesisch', 'Türkisch'];

/** Abfrage einer freien Anweisung bzw. einer Zielsprache */
export function InstructionDialog({
  open,
  kind,
  title,
  placeholder,
  onClose,
  onSubmit,
  defaultLanguage,
}: {
  open: boolean;
  kind: 'instruction' | 'language';
  title: string;
  placeholder?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
  defaultLanguage?: string;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue(kind === 'language' ? (defaultLanguage === 'Englisch' ? 'Deutsch' : 'Englisch') : '');
  }, [open, kind, defaultLanguage]);
  const submit = () => {
    if (kind === 'language' && !value.trim()) return;
    onSubmit(value.trim());
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={submit}>
            Los
          </Button>
        </>
      }
    >
      {kind === 'language' ? (
        <Field label="Zielsprache">
          <Input list="kuvert-ai-langs" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <datalist id="kuvert-ai-langs">
            {LANGS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </Field>
      ) : (
        <Field label="Anweisung an die KI">
          <Textarea
            autoFocus
            rows={4}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
            }}
          />
        </Field>
      )}
    </Modal>
  );
}

export { LANGS as AI_LANGUAGES };
