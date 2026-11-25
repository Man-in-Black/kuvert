import { cn } from '@/lib/utils';

/** Einfache Einschätzung der Passwortstärke (Länge + Zeichenvielfalt) */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes >= 3) s++;
  if (pw.length >= 16 && classes >= 3) s++;
  return Math.min(4, s) as 0 | 1 | 2 | 3 | 4;
}

export function PasswordStrength({ value }: { value: string }) {
  if (!value) return null;
  const score = passwordScore(value);
  const labels = ['Zu kurz', 'Schwach', 'Mittel', 'Gut', 'Sehr gut'];
  const colors = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];
  return (
    <div className="-mt-1 flex items-center gap-3">
      <div className="flex flex-1 gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full transition-colors', i <= score ? colors[score] : 'bg-surface-3')} />
        ))}
      </div>
      <span className="w-16 text-right text-[11px] text-muted">{labels[score]}</span>
    </div>
  );
}
