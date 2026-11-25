import { useEffect } from 'react';
import type { UserSettings } from '@kuvert/shared';

/** Setzt die Klasse "dark" am <html>-Element gemäß Einstellung (inkl. Systemmodus). */
export function useApplyTheme(theme: UserSettings['theme'], density: UserSettings['density']) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.body.classList.toggle('density-compact', density === 'compact');
  }, [density]);
}
