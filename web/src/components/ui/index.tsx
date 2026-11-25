/**
 * Gemeinsame UI-Bausteine. Bewusst ohne schwere UI-Bibliothek –
 * alles mit Tailwind und den Design-Tokens aus styles.css.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Inbox, Loader2, X } from 'lucide-react';
import { cn, colorFromString, initials } from '@/lib/utils';

export * from './extra';

/* ───────────────────────────── Button ───────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'soft';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-fg shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-primary-hover active:translate-y-px',
  secondary: 'bg-surface text-fg border border-border shadow-soft hover:bg-hover hover:border-border-strong active:translate-y-px',
  outline: 'border border-border text-fg bg-transparent hover:bg-hover hover:border-border-strong',
  ghost: 'text-fg hover:bg-hover',
  soft: 'bg-primary-soft text-primary hover:brightness-95 dark:hover:brightness-125',
  danger: 'bg-danger text-white shadow-soft hover:brightness-110 active:translate-y-px',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
  icon: 'h-9 w-9 justify-center rounded-lg',
  'icon-sm': 'h-7 w-7 justify-center rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 select-none items-center font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** Quadratischer Icon-Button mit Tooltip über title */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, size = 'icon', variant = 'ghost', children, className, ...rest },
  ref,
) {
  return (
    <Button ref={ref} size={size} variant={variant} title={label} aria-label={label} className={cn('text-muted hover:text-fg', className)} {...rest}>
      {children}
    </Button>
  );
});

/* ───────────────────────────── Formular ───────────────────────────── */

const fieldBase =
  'w-full rounded-lg border border-input-border bg-input px-3 text-sm text-fg shadow-[inset_0_1px_1px_rgb(15_23_42/0.03)] placeholder:text-subtle transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus:border-primary focus:outline-none focus:shadow-glow disabled:cursor-not-allowed disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cn(fieldBase, 'k-select h-9 cursor-pointer appearance-none pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-xs font-medium text-fg/80">{label}</span>}
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cn('group inline-flex cursor-pointer select-none items-center gap-2.5 text-sm', disabled && 'cursor-not-allowed opacity-50', className)}>
      <span className="relative inline-flex h-[18px] w-[18px] shrink-0">
        <input
          type="checkbox"
          className="peer absolute inset-0 cursor-pointer appearance-none rounded-[5px] border border-border-strong bg-surface transition-colors checked:border-primary checked:bg-primary focus-visible:shadow-glow focus-visible:outline-none disabled:cursor-not-allowed"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Check className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-white opacity-0 transition-opacity peer-checked:opacity-100" strokeWidth={3.5} />
      </span>
      {label}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-3 text-sm', disabled && 'cursor-not-allowed opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-[22px] w-10 shrink-0 rounded-full transition-colors duration-200 focus-visible:shadow-glow',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-all duration-200',
            checked ? 'left-[21px]' : 'left-[3px]',
          )}
        />
      </button>
      {label}
    </label>
  );
}

/* ───────────────────────────── Anzeige ───────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted', className)} />;
}

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted ring-border',
  primary: 'bg-primary-soft text-primary ring-primary/20',
  success: 'bg-success/10 text-success ring-success/25',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  danger: 'bg-danger/10 text-danger ring-danger/25',
  info: 'bg-info/10 text-info ring-info/25',
};

export function Badge({ children, color, tone, className }: { children: ReactNode; color?: string; tone?: BadgeTone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        !color && badgeTones[tone ?? 'neutral'],
        className,
      )}
      style={color ? { backgroundColor: `${color}1f`, color, ['--tw-ring-color' as string]: `${color}40` } : undefined}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, email, src, size = 32, className }: { name?: string; email?: string; src?: string | null; size?: number; className?: string }) {
  const label = name || email || '?';
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={cn('inline-block shrink-0 rounded-full object-cover ring-1 ring-black/5', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const base = colorFromString(email || label);
  return (
    <span
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ring-1 ring-black/5', className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 70%, #000))`,
      }}
      aria-hidden
    >
      {initials(label)}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full animate-fade-in flex-col items-center justify-center gap-3 p-8 text-center text-muted">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/10 [&_svg]:h-6 [&_svg]:w-6">
        {icon ?? <Inbox />}
      </div>
      <div className="text-sm font-semibold text-fg">{title}</div>
      {children && <div className="max-w-sm text-sm leading-relaxed">{children}</div>}
    </div>
  );
}

export function ColorDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-black/5', className)}
      style={{ backgroundColor: color ?? 'var(--k-muted)' }}
    />
  );
}

/* ───────────────────────────── Modal ───────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-[96vw] h-[92vh]' }[size];
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal
        className={cn(
          'flex max-h-[92vh] w-full animate-scale-in flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-pop sm:rounded-2xl',
          width,
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <IconButton label="Schließen" size="icon-sm" onClick={onClose} className="-mr-1 mt-0.5">
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-auto p-5', title !== undefined && 'pt-1')}>{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Bestätigungsdialog als Promise: `if (await confirm('Wirklich löschen?')) …` */
export function useConfirm() {
  const [state, setState] = useState<{ message: ReactNode; resolve: (v: boolean) => void; danger?: boolean } | null>(null);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const dialog = state ? (
    <Modal
      open
      size="sm"
      title={state.danger ? 'Bist du sicher?' : 'Bitte bestätigen'}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>Abbrechen</Button>
          <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {state.danger ? 'Ja, fortfahren' : 'OK'}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-fg/90">{state.message}</div>
    </Modal>
  ) : null;
  const confirm = (message: ReactNode, opts?: { danger?: boolean }) =>
    new Promise<boolean>((resolve) => setState({ message, resolve, danger: opts?.danger }));
  return { confirm, dialog };
}

/* ───────────────────────────── Dropdown-Menü ───────────────────────────── */

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  /** Rechts angezeigter Hinweis, z. B. Tastenkürzel */
  hint?: ReactNode;
  /** Häkchen anzeigen (Auswahlmenüs) */
  checked?: boolean;
}

export function Dropdown({
  trigger,
  items,
  align = 'left',
  className,
  side = 'bottom',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
  /** Menü oberhalb des Auslösers öffnen (z. B. unten in der Seitenleiste) */
  side?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          className={cn(
            'absolute z-40 min-w-52 animate-scale-in overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
            side === 'top' ? 'bottom-full mb-1.5 origin-bottom' : 'mt-1.5 origin-top',
          )}
        >
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} className="mx-1 my-1 border-t border-border" />
            ) : (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent',
                  it.danger ? 'text-danger hover:bg-danger/10' : 'text-fg',
                  it.disabled && !it.onClick && 'opacity-100',
                  it.disabled && it.onClick && 'opacity-50',
                )}
              >
                {it.icon && <span className={cn('[&_svg]:h-4 [&_svg]:w-4', it.danger ? 'text-danger' : 'text-muted')}>{it.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.checked && <Check className="h-4 w-4 text-primary" />}
                {it.hint && <span className="ml-3 text-xs text-subtle">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Tabs ───────────────────────────── */

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn('inline-flex rounded-lg border border-border bg-surface-2 p-0.5', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-all duration-150',
            value === t.value ? 'bg-surface text-fg shadow-soft ring-1 ring-border' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
