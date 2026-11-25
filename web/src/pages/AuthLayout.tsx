import type { ReactNode } from 'react';
import { CalendarDays, Lock, Mail, Sparkles } from 'lucide-react';

/** Gemeinsamer Rahmen für Anmeldung, Ersteinrichtung und erzwungene Sicherheitsschritte. */
export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-backdrop flex min-h-full">
      {/* Markenbereich (ab lg) */}
      <aside className="brand-gradient relative hidden w-[44%] max-w-xl overflow-hidden p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <BrandMark className="h-10 w-10" light />
          <span className="text-xl font-semibold tracking-tight">Kuvert</span>
        </div>
        <div className="relative mt-auto space-y-8">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Alle Postfächer, Kalender und Kontakte –
            <br />
            an einem Ort.
          </h2>
          <ul className="space-y-4 text-sm text-white/85">
            <Feature icon={<Mail />} text="Microsoft 365, Google, IMAP & Nextcloud in einem gemeinsamen Posteingang" />
            <Feature icon={<CalendarDays />} text="Kalender überlagert oder nebeneinander, Teams- & Meet-Termine per Klick" />
            <Feature icon={<Sparkles />} text="Lokaler KI-Assistent zum Formulieren und Zusammenfassen" />
            <Feature icon={<Lock />} text="S/MIME, Zwei-Faktor-Anmeldung und verschlüsselt gespeicherte Zugangsdaten" />
          </ul>
        </div>
        <div className="relative mt-10 text-xs text-white/60">Selbst gehostet · Open Source · modular</div>
      </aside>

      <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className={wide ? 'w-full max-w-xl' : 'w-full max-w-[400px]'}>
          <div className="mb-8 flex items-center justify-center gap-2.5 lg:hidden">
            <BrandMark className="h-9 w-9" />
            <span className="text-lg font-semibold tracking-tight">Kuvert</span>
          </div>
          <div className="animate-slide-up rounded-2xl border border-border/80 bg-surface/90 p-7 shadow-pop backdrop-blur-xl sm:p-8">{children}</div>
        </div>
      </main>
    </div>
  );
}

function Feature({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <span className="pt-1.5 leading-snug">{text}</span>
    </li>
  );
}

/** Markenzeichen (Briefumschlag) – SVG, passt sich hell/dunkel an */
export function BrandMark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="kuvert-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="0.5" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={light ? 'rgba(255,255,255,0.16)' : 'url(#kuvert-g)'} />
      <rect x="13" y="19" width="38" height="27" rx="5" fill="#fff" />
      <path d="M15 22l17 12.5L49 22" fill="none" stroke={light ? '#4f46e5' : '#4f46e5'} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AuthHeading({ title, subtitle, icon }: { title: string; subtitle?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6">
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft text-primary ring-1 ring-primary/10 [&_svg]:h-5 [&_svg]:w-5">{icon}</div>
      )}
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="animate-fade-in rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{children}</div>;
}
