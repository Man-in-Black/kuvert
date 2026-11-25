import { Fragment, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, MoreHorizontal, Search, X } from 'lucide-react';
import { useAppInfo } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useModules } from '@/modules/context';
import type { NavItem, ShellAction } from '@/modules/types';
import { Avatar, Dropdown, EmptyState, Kbd } from '@/components/ui';
import { BrandMark } from '@/pages/AuthLayout';
import { CommandPalette, openCommandPalette } from './CommandPalette';
import { useNavItems, useShellActions, useUserMenuItems } from './shell-helpers';

const COLLAPSE_KEY = 'kuvert.sidebar.collapsed';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Grundlayout: Seitenleiste links (aus den Modulen zusammengesetzt, ein-/ausklappbar),
 * rechts der Inhalt der aktiven Route. Mobil: Leiste unten.
 */
export function AppShell() {
  const mods = useModules();
  const { main, system } = useNavItems();
  const routes = useMemo(() => mods.flatMap((m) => m.routes ?? []), [mods]);
  const services = useMemo(() => mods.flatMap((m) => m.services ?? []), [mods]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* egal */
      }
      return !c;
    });
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      <Sidebar main={main} system={system} collapsed={collapsed} onToggle={toggle} />

      <main className="min-h-0 min-w-0 flex-1 pb-[60px] md:pb-0">
        <Routes>
          {routes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="/" element={<Navigate to={main[0] ? `/${main[0].path}` : '/settings'} replace />} />
          <Route path="*" element={<EmptyState title="Seite nicht gefunden">Die aufgerufene Seite existiert nicht (mehr).</EmptyState>} />
        </Routes>
      </main>

      <MobileNav main={main} system={system} />
      <CommandPalette />

      {services.map((S, i) => (
        <Fragment key={i}>
          <S />
        </Fragment>
      ))}
    </div>
  );
}

/* ═════════════════════════════ Seitenleiste (Desktop) ═════════════════════════════ */

function Sidebar({ main, system, collapsed, onToggle }: { main: NavItem[]; system: NavItem[]; collapsed: boolean; onToggle: () => void }) {
  const { data: app } = useAppInfo();
  const userItems = useUserMenuItems();
  const actions = useShellActions();
  const user = app?.user;

  return (
    <aside
      className={cn(
        'relative hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-out md:flex',
        collapsed ? 'w-[68px]' : 'w-[232px]',
      )}
    >
      {/* Marke + Einklappen */}
      <div className={cn('flex h-14 items-center gap-2.5', collapsed ? 'justify-center px-2' : 'px-4')}>
        <BrandMark className="h-8 w-8 shrink-0" />
        {!collapsed && <span className="flex-1 text-[15px] font-semibold tracking-tight">Kuvert</span>}
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title="Seitenleiste einklappen"
            aria-label="Seitenleiste einklappen"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Suche / Befehlspalette */}
      <div className={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
        <button
          type="button"
          onClick={openCommandPalette}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-surface text-sm text-subtle shadow-soft transition-colors hover:border-border-strong hover:text-muted',
            collapsed ? 'justify-center' : 'px-2.5',
          )}
          title="Befehlspalette (Strg+K)"
        >
          <Search className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Suchen …</span>
              <span className="flex gap-0.5">
                <Kbd>{isMac ? '⌘' : 'Strg'}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </>
          )}
        </button>
      </div>

      <nav className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
        {main.map((n) => (
          <RailLink key={n.path} item={n} collapsed={collapsed} />
        ))}
        {actions.length > 0 && <div className="my-1.5 border-t border-border" />}
        {actions.map((a) => (
          <RailAction key={a.id} action={a} collapsed={collapsed} />
        ))}
        <div className="flex-1" />
        {system.map((n) => (
          <RailLink key={n.path} item={n} collapsed={collapsed} />
        ))}
      </nav>

      <div className={cn('border-t border-border py-3', collapsed ? 'px-2' : 'px-3')}>
        {collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="mb-2 flex h-9 w-full items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
            title="Seitenleiste ausklappen"
            aria-label="Seitenleiste ausklappen"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        )}
        <Dropdown
          side="top"
          className="block w-full"
          items={userItems}
          trigger={
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-hover',
                collapsed && 'justify-center',
              )}
              title={user?.email}
            >
              <Avatar name={user?.name} email={user?.email} src={user?.avatarUrl} size={32} />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{user?.name}</span>
                  <span className="block truncate text-xs text-muted">{user?.isAdmin ? 'Administrator' : user?.email}</span>
                </span>
              )}
              {!collapsed && <MoreHorizontal className="h-4 w-4 shrink-0 text-subtle" />}
            </button>
          }
        />
      </div>
    </aside>
  );
}

function RailLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={`/${item.path}`}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium transition-all duration-150',
          collapsed ? 'justify-center' : 'px-2.5',
          isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-hover hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={cn('h-[18px] w-[18px] shrink-0 transition-transform group-hover:scale-105', isActive ? 'text-primary' : '')} />
          {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
          {item.useBadge && <NavBadge useCount={item.useBadge} variant={collapsed ? 'dot' : 'pill'} />}
        </>
      )}
    </NavLink>
  );
}

/** Globale Aktion im Stil eines Navigationseintrags (z. B. KI-Chat) */
function RailAction({ action, collapsed }: { action: ShellAction; collapsed: boolean }) {
  const active = useActionActive(action);
  return (
    <button
      type="button"
      onClick={action.run}
      title={collapsed ? action.label : undefined}
      aria-pressed={action.useActive ? active : undefined}
      className={cn(
        'group relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium transition-all duration-150',
        collapsed ? 'justify-center' : 'px-2.5',
        active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      <action.icon className="h-[18px] w-[18px] shrink-0 transition-transform group-hover:scale-105" />
      {!collapsed && <span className="flex-1 truncate text-left">{action.label}</span>}
    </button>
  );
}

const useNever = () => false;
function useActionActive(action: ShellAction): boolean {
  return (action.useActive ?? useNever)();
}

/** Zähler an einem Navigationseintrag (z. B. ungelesene Chatnachrichten) */
function NavBadge({ useCount, variant }: { useCount: () => number; variant: 'pill' | 'dot' | 'icon' }) {
  const n = useCount();
  if (!n) return null;
  const label = n > 99 ? '99+' : String(n);
  if (variant === 'pill') {
    return <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-fg">{label}</span>;
  }
  return (
    <span
      className={cn(
        'absolute inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-fg ring-2 ring-surface',
        variant === 'dot' ? 'right-1 top-0.5' : '-right-2 -top-1.5',
      )}
      aria-label={`${label} ungelesen`}
    >
      {label}
    </span>
  );
}

/* ═════════════════════════════ Mobile Leiste unten ═════════════════════════════ */

function MobileNav({ main, system }: { main: NavItem[]; system: NavItem[] }) {
  const [more, setMore] = useState(false);
  const location = useLocation();
  const { data: app } = useAppInfo();
  const userItems = useUserMenuItems();
  const actions = useShellActions();
  const primary = main.slice(0, 4);
  const rest = [...main.slice(4), ...system];

  useEffect(() => setMore(false), [location.pathname]);

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-30 flex h-[60px] items-stretch border-t border-border bg-surface/90 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        {primary.map((n) => (
          <NavLink
            key={n.path}
            to={`/${n.path}`}
            className={({ isActive }) =>
              cn('flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium', isActive ? 'text-primary' : 'text-muted')
            }
          >
            <span className="relative">
              <n.icon className="h-5 w-5" />
              {n.useBadge && <NavBadge useCount={n.useBadge} variant="icon" />}
            </span>
            {n.label}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore(true)} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted">
          <MoreHorizontal className="h-5 w-5" />
          Mehr
        </button>
      </nav>

      {more && (
        <div className="fixed inset-0 z-50 flex animate-fade-in items-end bg-slate-950/40 backdrop-blur-sm md:hidden" onClick={() => setMore(false)}>
          <div className="w-full animate-slide-up rounded-t-3xl border-t border-border bg-surface p-4 pb-8 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-3">
              <Avatar name={app?.user?.name} email={app?.user?.email} src={app?.user?.avatarUrl} size={40} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{app?.user?.name}</div>
                <div className="truncate text-xs text-muted">{app?.user?.email}</div>
              </div>
              <button type="button" className="rounded-md p-1.5 text-muted hover:bg-hover" onClick={() => setMore(false)} aria-label="Schließen">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {rest.map((n) => (
                <NavLink key={n.path} to={`/${n.path}`} className="flex flex-col items-center gap-1.5 rounded-xl p-3 text-xs text-fg hover:bg-hover">
                  <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2">
                    <n.icon className="h-5 w-5 text-muted" />
                    {n.useBadge && <NavBadge useCount={n.useBadge} variant="icon" />}
                  </span>
                  {n.label}
                </NavLink>
              ))}
              {actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setMore(false);
                    a.run();
                  }}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-3 text-xs text-fg hover:bg-hover"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-soft">
                    <a.icon className="h-5 w-5 text-primary" />
                  </span>
                  {a.label}
                </button>
              ))}
            </div>
            <div className="mt-3 space-y-0.5 border-t border-border pt-3">
              {userItems
                .filter((i) => !i.divider && !i.disabled)
                .map((i, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setMore(false);
                      i.onClick?.();
                    }}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-hover [&_svg]:h-4 [&_svg]:w-4', i.danger ? 'text-danger' : 'text-fg')}
                  >
                    <span className={i.danger ? 'text-danger' : 'text-muted'}>{i.icon}</span>
                    <span className="flex-1 text-left">{i.label}</span>
                    {i.checked && <span className="text-xs text-primary">aktiv</span>}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
