import { useMemo } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useModules } from '@/modules/context';
import { EmptyState } from '@/components/ui';

/** Pfad-Präfix für eigenständige Fenster (z. B. Verfassen im Popup) */
export const WINDOW_PREFIX = '/window/';

/**
 * Eigenständiges Fenster ohne Navigationsleiste und ohne Hintergrunddienste –
 * die Routen kommen aus WebModule.windows.
 */
export function StandaloneWindow() {
  const mods = useModules();
  const windows = useMemo(() => mods.flatMap((m) => m.windows ?? []), [mods]);
  return (
    <div className="h-full">
      <Routes>
        {windows.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<EmptyState title="Fenster nicht gefunden">Dieses Fenster gibt es (nicht mehr).</EmptyState>} />
      </Routes>
    </div>
  );
}
