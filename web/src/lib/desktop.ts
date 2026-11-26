/**
 * Kuvert-Desktop-App: Electron-Hülle um diese Oberfläche, eigenes Projekt
 * https://github.com/Man-in-Black/kuvert-desktop. Im Browser ist `desktop` undefined;
 * in der App stellt deren preload.js die Schnittstelle bereit. Änderungen hier nur
 * abwärtskompatibel, denn ältere App-Versionen laden immer die aktuelle Oberfläche.
 */
export interface KuvertDesktop {
  version: string;
  platform: string;
  /** Fenster nach vorn holen */
  show(): void;
  /** mailto:-Links aus dem System oder dem Infobereich empfangen */
  onMailto(cb: (raw: string) => void): void;
  isDefaultMailClient(): Promise<boolean>;
  setDefaultMailClient(): Promise<boolean>;
}

export const desktop: KuvertDesktop | undefined =
  typeof window !== 'undefined' ? (window as unknown as { kuvertDesktop?: KuvertDesktop }).kuvertDesktop : undefined;
