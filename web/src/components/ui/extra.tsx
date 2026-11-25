/**
 * Ergänzende UI-Bausteine: Karten, Seitenköpfe, Kennzahlen, Tabellen,
 * Skeletons, Tastenkürzel, Tooltip, Seitenpanel (Drawer), Kopieren-Button.
 */
import { useEffect, useState, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/* ───────────────────────────── Karte ───────────────────────────── */

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  icon,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:h-4 [&_svg]:w-4">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-sm font-semibold leading-6">{title}</h2>}
              {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-5', (title || actions) && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/* ───────────────────────────── Seitenkopf ───────────────────────────── */

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary ring-1 ring-primary/10 [&_svg]:h-5 [&_svg]:w-5">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ───────────────────────────── Kennzahl ───────────────────────────── */

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'primary',
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children?: ReactNode;
}) {
  const tones = {
    primary: 'bg-primary-soft text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
    info: 'bg-info/10 text-info',
    neutral: 'bg-surface-2 text-muted',
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors hover:border-border-strong">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon && <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4', tones[tone])}>{icon}</span>}
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
      {children}
    </div>
  );
}

export function Progress({ value, max = 100, tone = 'primary', className }: { value: number; max?: number; tone?: 'primary' | 'success' | 'warning' | 'danger'; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const color = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' }[tone];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ───────────────────────────── Tabelle ───────────────────────────── */

/**
 * Tabelle im Karten-Look. `scroll={false}` verzichtet auf horizontales Scrollen –
 * nötig, wenn Zeilen Dropdown-Menüs enthalten (sonst würden diese abgeschnitten).
 */
export function Table({ children, className, scroll = true }: { children: ReactNode; className?: string; scroll?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-surface shadow-card [&_thead_th:first-child]:rounded-tl-2xl [&_thead_th:last-child]:rounded-tr-2xl',
        scroll && 'overflow-x-auto',
        className,
      )}
    >
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn('border-b border-border bg-surface-2/70 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted', className)}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-border px-4 py-3 align-middle [tr:last-child>&]:border-b-0', className)} {...rest} />;
}

/* ───────────────────────────── Kleinteile ───────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium text-muted shadow-[inset_0_-1px_0_var(--k-border)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Leichter Tooltip per CSS (für Icons/kurze Hinweise) */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'right' }) {
  const pos = {
    top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
    bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
    right: 'left-full top-1/2 ml-2 -translate-y-1/2',
  }[side];
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-pop transition-opacity delay-300 duration-150 group-hover/tt:opacity-100 dark:bg-slate-700',
          pos,
        )}
      >
        {content}
      </span>
    </span>
  );
}

export function CopyButton({ value, label = 'Kopieren', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Kopieren nicht möglich');
        }
      }}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover',
        className,
      )}
      title={label}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5 text-muted" />}
      {done ? 'Kopiert' : label}
    </button>
  );
}

/** Code/Secret-Anzeige mit Kopieren */
export function CodeBox({ value, className, multiline }: { value: string; className?: string; multiline?: boolean }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border border-border bg-surface-2 p-2 pl-3', className)}>
      <code className={cn('min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed text-fg', multiline ? 'whitespace-pre-wrap break-all' : 'truncate')}>{value}</code>
      <CopyButton value={value} label="Kopieren" className="shrink-0" />
    </div>
  );
}

/* ───────────────────────────── Mobile Seitenleiste ───────────────────────────── */

/** Seitenleiste als Schublade von links – für schmale Bildschirme */
export function SidebarSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex animate-fade-in bg-slate-950/40 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="flex h-full w-72 max-w-[85vw] flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </aside>
    </div>,
    document.body,
  );
}

/* ───────────────────────────── Seitenpanel ───────────────────────────── */

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex animate-fade-in justify-end bg-slate-950/30 backdrop-blur-[2px]" onMouseDown={onClose}>
      <aside
        className={cn('flex h-full w-full animate-slide-in-right flex-col border-l border-border bg-surface shadow-pop', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg" aria-label="Schließen">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
