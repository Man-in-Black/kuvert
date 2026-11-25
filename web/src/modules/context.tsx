import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { WebModule } from './types';
import { activeModules } from './index';
import { useAccounts, useAppInfo } from '@/lib/queries';

const ModulesContext = createContext<WebModule[]>([]);

export function ModulesProvider({ children }: { children: ReactNode }) {
  const { data: app } = useAppInfo();
  const { data: accounts } = useAccounts();
  const mods = useMemo(() => (app ? activeModules({ app, accounts: accounts ?? [] }) : []), [app, accounts]);
  return <ModulesContext.Provider value={mods}>{children}</ModulesContext.Provider>;
}

/** Alle aktiven Module */
export function useModules(): WebModule[] {
  return useContext(ModulesContext);
}

/** Sammelt einen Erweiterungspunkt über alle aktiven Module, z. B. useExtensions('composerToolbar') */
export function useExtensions<K extends keyof WebModule>(key: K): NonNullable<WebModule[K]> extends (infer U)[] ? U[] : never {
  const mods = useModules();
  return mods.flatMap((m) => (m[key] as unknown[] | undefined) ?? []) as never;
}
