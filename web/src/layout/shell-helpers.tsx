import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, LogOut, Monitor, Moon, Settings as SettingsIcon, Shield, Sun, UserRound } from 'lucide-react';
import type { UserSettings } from '@kuvert/shared';
import { api } from '@/lib/api';
import { qk, useAppInfo, useSettings, useUpdateSettings } from '@/lib/queries';
import { useModules } from '@/modules/context';
import type { NavItem, ShellAction, SidePanelDef } from '@/modules/types';
import { toggleSidePanel, useSidePanelOpen } from './side-panel-store';
import type { MenuItem } from '@/components/ui';

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      await qc.invalidateQueries({ queryKey: qk.app });
      navigate('/');
    }
  };
}

/** Navigationseinträge aller Module, aufgeteilt in Haupt- und Systembereich */
export function useNavItems(): { main: NavItem[]; system: NavItem[] } {
  const mods = useModules();
  return useMemo(() => {
    const all = mods.flatMap((m) => m.nav ?? []).sort((a, b) => a.order - b.order);
    const isSystem = (n: NavItem) => n.path === 'settings' || n.path === 'admin';
    return { main: all.filter((n) => !isSystem(n)), system: all.filter(isSystem) };
  }, [mods]);
}

/** Panels der Seitenleiste rechts aller Module, sortiert */
export function useSidePanels(): SidePanelDef[] {
  const mods = useModules();
  return useMemo(() => mods.flatMap((m) => m.sidePanels ?? []).sort((a, b) => a.order - b.order), [mods]);
}

/** Globale Aktionen aller Module (z. B. KI-Chat) – inklusive „Panel öffnen“ für jedes Panel rechts */
export function useShellActions(): ShellAction[] {
  const mods = useModules();
  const panels = useSidePanels();
  return useMemo(() => {
    const fromPanels = panels.map<ShellAction>((p) => ({
      id: `panel-${p.id}`,
      label: p.actionLabel ?? `${p.label}-Leiste`,
      icon: p.icon,
      order: p.order,
      keywords: `${p.keywords ?? ''} seitenleiste sidebar panel rechts`,
      run: () => toggleSidePanel(p.id),
      useActive: () => useSidePanelOpen(p.id),
      sidePanel: true,
    }));
    return [...mods.flatMap((m) => m.actions ?? []), ...fromPanels].sort((a, b) => a.order - b.order);
  }, [mods, panels]);
}

export const THEME_OPTIONS: { value: UserSettings['theme']; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Hell', icon: Sun },
  { value: 'dark', label: 'Dunkel', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function useThemeSwitch() {
  const { settings } = useSettings();
  const update = useUpdateSettings();
  return {
    theme: settings.theme,
    setTheme: (theme: UserSettings['theme']) => {
      document.documentElement.classList.add('theme-transition');
      update.mutate({ theme });
      setTimeout(() => document.documentElement.classList.remove('theme-transition'), 350);
    },
  };
}

/** Einträge des Benutzermenüs (unten in der Seitenleiste bzw. mobil im "Mehr"-Menü) */
export function useUserMenuItems(): MenuItem[] {
  const { data: app } = useAppInfo();
  const navigate = useNavigate();
  const logout = useLogout();
  const { theme, setTheme } = useThemeSwitch();
  const user = app?.user;
  return [
    {
      label: (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-fg">{user?.name}</span>
          <span className="truncate text-xs text-muted">{user?.email}</span>
        </span>
      ),
      disabled: true,
    },
    { divider: true, label: '' },
    { label: 'Mein Profil', icon: <UserRound />, onClick: () => navigate('/settings/profile') },
    { label: 'Einstellungen', icon: <SettingsIcon />, onClick: () => navigate('/settings') },
    ...(user?.isAdmin ? [{ label: 'Admin-Bereich', icon: <Shield />, onClick: () => navigate('/admin') } as MenuItem] : []),
    { divider: true, label: '' },
    ...THEME_OPTIONS.map<MenuItem>((t) => ({ label: t.label, icon: <t.icon />, checked: theme === t.value, onClick: () => setTheme(t.value) })),
    { divider: true, label: '' },
    { label: 'API-Dokumentation', icon: <BookOpen />, onClick: () => window.open(app?.apiDocsUrl ?? '/api/docs', '_blank', 'noopener') },
    { label: 'Abmelden', icon: <LogOut />, danger: true, onClick: () => void logout() },
  ];
}
