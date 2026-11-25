import type { AccountTypeInfo, Capability } from '@kuvert/shared';
import { CalendarDays, Cloud, HardDrive, Mail, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  mail: 'Mail',
  calendar: 'Kalender',
  contacts: 'Kontakte',
  tasks: 'Aufgaben',
  storage: 'Dateien',
  meetings: 'Meetings',
};

export const COLOR_PRESETS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777', '#4f46e5', '#059669', '#64748b', '#0f172a'];

export function CapabilityChips({ caps, className }: { caps: Capability[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {caps.map((c) => (
        <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          {CAPABILITY_LABELS[c] ?? c}
        </span>
      ))}
    </div>
  );
}

function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 23 23" className={className} aria-hidden>
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#7fba00" d="M12 1h10v10H12z" />
      <path fill="#00a4ef" d="M1 12h10v10H1z" />
      <path fill="#ffb900" d="M12 12h10v10H12z" />
    </svg>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Symbol für einen Kontotyp (Markenlogo oder passendes Icon) */
export function AccountTypeIcon({ type, icon, capabilities, className }: { type: string; icon?: string; capabilities?: Capability[]; className?: string }) {
  const cls = cn('h-5 w-5 shrink-0', className);
  const key = (icon || type).toLowerCase();
  if (key.includes('microsoft') || key.includes('outlook') || key === 'ms365') return <MicrosoftLogo className={cls} />;
  if (key.includes('google') || key.includes('gmail')) return <GoogleLogo className={cls} />;
  if (key.includes('nextcloud') || key.includes('cloud')) return <Cloud className={cn(cls, 'text-sky-500')} />;
  if (key.includes('webdav') || key.includes('storage')) return <HardDrive className={cn(cls, 'text-muted')} />;
  if (key.includes('caldav') || key.includes('carddav') || key.includes('dav') || key.includes('calendar')) return <CalendarDays className={cn(cls, 'text-emerald-500')} />;
  if (key.includes('imap') || key.includes('mail')) return <Mail className={cn(cls, 'text-primary')} />;
  if (capabilities?.includes('mail')) return <Mail className={cn(cls, 'text-primary')} />;
  if (capabilities?.includes('calendar')) return <CalendarDays className={cn(cls, 'text-emerald-500')} />;
  if (capabilities?.includes('storage')) return <Cloud className={cn(cls, 'text-sky-500')} />;
  return <Server className={cn(cls, 'text-muted')} />;
}

/** Hinweis, welche Umgebungsvariablen für einen OAuth-Typ fehlen */
export function oauthEnvHint(t: AccountTypeInfo): string {
  const where = 'Ein Administrator hinterlegt die Zugangsdaten unter Admin → Dienste & Anmeldung';
  if (t.type.includes('microsoft')) return `${where} (alternativ MS_CLIENT_ID/MS_CLIENT_SECRET in der .env).`;
  if (t.type.includes('google')) return `${where} (alternativ GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in der .env).`;
  return `${where}.`;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={cn('h-6 w-6 rounded-full border-2 transition-transform hover:scale-110', value.toLowerCase() === c ? 'border-fg' : 'border-transparent')}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="relative ml-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted hover:bg-hover" title="Eigene Farbe">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0" />
        Eigene
      </label>
    </div>
  );
}
