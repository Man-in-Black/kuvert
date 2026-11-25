import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { SettingsSection } from '@/modules/types';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui';

/**
 * Zweispaltiges Layout für Einstellungen und Admin-Bereich:
 * links die (filterbare) Abschnittsliste, rechts der Inhalt unter <basePath>/:sectionId.
 */
export function SectionLayout({
  title,
  subtitle,
  icon,
  basePath,
  sections,
  footer,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  basePath: string;
  sections: SettingsSection[];
  footer?: ReactNode;
}) {
  const sorted = useMemo(() => [...sections].sort((a, b) => a.order - b.order), [sections]);
  const [filter, setFilter] = useState('');
  const visible = filter ? sorted.filter((s) => s.label.toLowerCase().includes(filter.toLowerCase())) : sorted;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="shrink-0 border-b border-border bg-sidebar md:flex md:w-64 md:flex-col md:border-b-0 md:border-r">
        <div className="hidden px-5 pb-3 pt-6 md:block">
          <div className="flex items-center gap-2.5">
            {icon && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
            )}
            <div>
              <div className="text-[15px] font-semibold tracking-tight">{title}</div>
              {subtitle && <div className="text-xs text-muted">{subtitle}</div>}
            </div>
          </div>
          {sorted.length > 7 && (
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Bereich suchen"
                className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2 text-xs outline-none placeholder:text-subtle focus:border-primary focus:shadow-glow"
              />
            </div>
          )}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-1 md:flex-col md:overflow-y-auto md:px-3 md:pb-4 md:pt-0">
          {visible.map((s) => (
            <NavLink
              key={s.id}
              to={`${basePath}/${s.id}`}
              className={({ isActive }) =>
                cn(
                  'group relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-all duration-150',
                  isActive ? 'bg-surface font-medium text-fg shadow-soft ring-1 ring-border' : 'text-muted hover:bg-hover hover:text-fg',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute left-0 top-1/2 hidden h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary md:block" />}
                  {s.icon && <s.icon className={cn('h-4 w-4 shrink-0 transition-colors', isActive ? 'text-primary' : 'text-subtle group-hover:text-fg')} />}
                  {s.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        {footer && <div className="hidden border-t border-border p-3 md:block">{footer}</div>}
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl animate-fade-in px-4 py-6 md:px-10 md:py-10">
          <Routes>
            <Route index element={<Navigate to={sorted[0]?.id ?? '.'} replace />} />
            {sorted.map((s) => (
              <Route key={s.id} path={`${s.id}/*`} element={<s.component />} />
            ))}
            <Route path="*" element={<EmptyState title="Abschnitt nicht gefunden" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
