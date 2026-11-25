import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button, Field, Input, Modal, type MenuItem } from '@/components/ui';

/** Kontextmenü an Mausposition */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [x, y, onClose]);
  return createPortal(
    <div ref={ref} className="fixed z-50 min-w-48 rounded-lg border border-border bg-surface py-1 shadow-xl" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
            className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-50', it.danger && 'text-danger')}
          >
            {it.icon && <span className="text-muted [&_svg]:h-4 [&_svg]:w-4">{it.icon}</span>}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Einfacher Eingabedialog */
export function PromptDialog({
  open,
  title,
  label,
  initial = '',
  confirmLabel = 'OK',
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const submit = () => {
    if (!value.trim()) return;
    onSubmit(value.trim());
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
      {children}
    </Modal>
  );
}
