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
  /** Native Systembenachrichtigung (ab App 1.1.0); ein Klick holt das Fenster nach vorn und meldet `url` über onNavigate */
  notify?(n: DesktopNotification): void;
  /** Pfad in Kuvert öffnen, nachdem eine Benachrichtigung angeklickt wurde (ab App 1.1.0) */
  onNavigate?(cb: (url: string) => void): void;
}

export interface DesktopNotification {
  title: string;
  body?: string;
  /** Gleiches Tag ersetzt die vorige Benachrichtigung */
  tag?: string;
  /** Pfad in Kuvert, z. B. /chat/123 */
  url?: string;
  /** Bleibt stehen, bis sie weggeklickt wird (Termine) */
  requireInteraction?: boolean;
}

export const desktop: KuvertDesktop | undefined =
  typeof window !== 'undefined' ? (window as unknown as { kuvertDesktop?: KuvertDesktop }).kuvertDesktop : undefined;
