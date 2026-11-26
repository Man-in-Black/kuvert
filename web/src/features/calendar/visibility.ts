import { useCallback, useState } from 'react';

/** Ausgeblendete Kalender (Schlüssel calKey) – gilt für Kalenderseite und Seitenleiste */
export const HIDDEN_KEY = 'kuvert.calendar.hidden';
export const COLLAPSED_KEY = 'kuvert.calendar.collapsedAccounts';

/** Menge von Schlüsseln, im Browser gespeichert */
export function usePersistentSet(key: string) {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const update = useCallback(
    (fn: (s: Set<string>) => void) =>
      setSet((prev) => {
        const next = new Set(prev);
        fn(next);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          /* Speicher nicht verfügbar */
        }
        return next;
      }),
    [key],
  );
  return [set, update] as const;
}
