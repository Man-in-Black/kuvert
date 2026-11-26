/**
 * Zustand der Seitenleiste rechts (Kalender, Kontakte, Chat, KI-Chat, Telefon …):
 * welches Panel aufgeklappt ist (null = eingeklappt), ob sie angepinnt ist und wie breit
 * jedes Panel ist. Angepinnt bleibt das zuletzt offene Panel auch nach dem Neuladen offen.
 */
import { useSyncExternalStore } from 'react';

const ACTIVE_KEY = 'kuvert.rightbar.active';
const PINNED_KEY = 'kuvert.rightbar.pinned';
const WIDTH_KEY = 'kuvert.panels.width';
/** Früher pro Leiste angepinnt – einmalig übernehmen */
const LEGACY_PINNED_KEY = 'kuvert.panels.pinned';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Speicher nicht verfügbar */
  }
}

function loadPinned(): boolean {
  const v = read(PINNED_KEY);
  if (v !== null) return v === '1';
  try {
    const legacy: unknown = JSON.parse(read(LEGACY_PINNED_KEY) ?? '{}');
    return !!legacy && typeof legacy === 'object' && Object.values(legacy).some(Boolean);
  } catch {
    return false;
  }
}

function loadWidths(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(read(WIDTH_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

interface State {
  active: string | null;
  pinned: boolean;
  width: Record<string, number>;
}

const pinned = loadPinned();
/** Mobil ist ein Panel bildschirmfüllend – dort nach dem Neuladen nicht von selbst öffnen */
const mobileStart = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
let state: State = { active: pinned && !mobileStart ? read(ACTIVE_KEY) : null, pinned, width: loadWidths() };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useSidePanelState<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state));
}

/* ───────────────────────────── Öffnen / Schließen ───────────────────────────── */

export function openSidePanel(id: string) {
  if (state.active === id) return;
  write(ACTIVE_KEY, id);
  set({ active: id });
}

export function closeSidePanel() {
  if (state.active === null) return;
  write(ACTIVE_KEY, null);
  set({ active: null });
}

export function toggleSidePanel(id: string) {
  if (state.active === id) closeSidePanel();
  else openSidePanel(id);
}

/** Schließt die Leiste nur, wenn gerade dieses Panel offen ist */
export function closeSidePanelIf(id: string) {
  if (state.active === id) closeSidePanel();
}

export function useActiveSidePanel(): string | null {
  return useSidePanelState((s) => s.active);
}

export function useSidePanelOpen(id: string): boolean {
  return useSidePanelState((s) => s.active === id);
}

/* ───────────────────────────── Anpinnen / Breite ───────────────────────────── */

export function isSidebarPinned(): boolean {
  return state.pinned;
}

export function setSidebarPinned(value: boolean) {
  write(PINNED_KEY, value ? '1' : '0');
  set({ pinned: value });
}

export function setSidePanelWidth(id: string, width: number | null, persist: boolean) {
  const next = { ...state.width };
  if (width === null) delete next[id];
  else next[id] = width;
  set({ width: next });
  if (persist) write(WIDTH_KEY, JSON.stringify(next));
}

export function persistSidePanelWidths() {
  write(WIDTH_KEY, JSON.stringify(state.width));
}

export function getSidePanelWidth(id: string): number | undefined {
  return state.width[id];
}
