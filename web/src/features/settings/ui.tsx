/** Kleine Layout-Bausteine, die alle Einstellungsseiten gemeinsam nutzen. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, children, className, actions }: { title?: ReactNode; description?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface p-5 shadow-card', className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_16rem]">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Zeile "Bezeichnung links – Steuerelement rechts" */
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

/** Kurzes "Gespeichert"-Feedback; `trigger` hochzählen, um es anzuzeigen */
export function SavedIndicator({ trigger }: { trigger: number }) {
  const [visible, setVisible] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!trigger) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1800);
    return () => clearTimeout(t);
  }, [trigger]);
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-success transition-opacity', visible ? 'opacity-100' : 'opacity-0')}>
      <Check className="h-3.5 w-3.5" /> Gespeichert
    </span>
  );
}

export function HelpBox({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'danger' }) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed',
        tone === 'info' && 'border-primary/30 bg-primary-soft text-fg',
        tone === 'warning' && 'border-warning/40 bg-warning/10 text-fg',
        tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
      )}
    >
      {children}
    </div>
  );
}

/** ISO → Wert für <input type="datetime-local"> */
export function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}
