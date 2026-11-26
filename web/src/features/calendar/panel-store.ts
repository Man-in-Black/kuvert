/** Offen/zu der Kalender-Seitenleiste. Angepinnt bleibt sie auch nach dem Neuladen offen. */
import { useSyncExternalStore } from 'react';
import { isPanelPinned } from '@/layout/SidePanel';

export const CALENDAR_PANEL_ID = 'calendar';
const OPEN_KEY = 'kuvert.calendarPanel.open';

let open = (() => {
  try {
    return isPanelPinned(CALENDAR_PANEL_ID) && localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

function setOpen(value: boolean) {
  if (open === value) return;
  open = value;
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0');
  } catch {
    /* Speicher nicht verfügbar */
  }
  listeners.forEach((l) => l());
}

export const openCalendarPanel = () => setOpen(true);
export const closeCalendarPanel = () => setOpen(false);
export const toggleCalendarPanel = () => setOpen(!open);

export function useCalendarPanelOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
