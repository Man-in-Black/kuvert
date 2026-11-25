import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Sechsstellige Code-Eingabe (TOTP) mit Einzelfeldern, Einfügen-/Autofill-Unterstützung
 * und automatischem Absenden, sobald alle Ziffern eingegeben sind.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus = true,
  length = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  length?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  useEffect(() => {
    if (autoFocus) refs.current[Math.min(value.length, length - 1)]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
    refs.current[Math.min(clean.length, length - 1)]?.focus();
  };

  /** Ziffern ab Position i einsetzen (eine oder mehrere, z. B. per Autofill) */
  const insertAt = (i: number, typed: string) => {
    const start = Math.min(i, value.length);
    set(value.slice(0, start) + typed + value.slice(start + typed.length));
  };

  return (
    <div
      className="flex justify-between gap-2"
      onPaste={(e) => {
        e.preventDefault();
        set(e.clipboardData.getData('text'));
      }}
    >
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          aria-label={`Ziffer ${i + 1}`}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            if (!raw) return;
            // Vorhandene Ziffer wurde (dank select()) ersetzt; bei Mehrfacheingabe alle übernehmen
            const typed = raw.length > 1 && raw.startsWith(d) && d ? raw.slice(1) : raw;
            insertAt(i, typed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              const pos = d ? i : Math.max(0, i - 1);
              onChange(value.slice(0, pos));
              refs.current[pos]?.focus();
            } else if (e.key === 'ArrowLeft') refs.current[Math.max(0, i - 1)]?.focus();
            else if (e.key === 'ArrowRight') refs.current[Math.min(length - 1, i + 1)]?.focus();
          }}
          className={cn(
            'h-12 w-full min-w-0 rounded-xl border border-border bg-surface text-center font-mono text-xl font-semibold text-fg caret-transparent shadow-[inset_0_1px_1px_rgb(15_23_42/0.04)] transition-all focus:border-primary focus:shadow-glow focus:outline-none disabled:opacity-60',
            d && 'border-border-strong',
          )}
        />
      ))}
    </div>
  );
}
