/**
 * Typen der Telefonanlagen-Anbindung (3CX V20, Call Control API).
 */

/** Admin-Einstellungen der 3CX-Anbindung (API-Schlüssel wird nie zurückgegeben) */
export interface ThreeCxAdminConfig {
  enabled: boolean;
  /** Adresse der Anlage, z. B. https://firma.3cx.de oder https://pbx.example.com:5001 */
  baseUrl: string;
  /** Client-ID der API-Anwendung (3CX: Integrationen → API) */
  clientId: string;
  /** API-Schlüssel hinterlegt? */
  secretConfigured: boolean;
  /** Führendes „+“ beim Wählen ersetzen (z. B. "00"); leer = „+“ unverändert übergeben */
  plusPrefix: string;
}

export interface ThreeCxTestResult {
  ok: boolean;
  message: string;
  /** Nebenstellen, die die API-Anwendung überwachen darf */
  monitored?: string[];
}

/** Zuordnung Kuvert-Benutzer ↔ 3CX-Nebenstelle (Admin) */
export interface ThreeCxAssignment {
  userId: string;
  name: string;
  email: string;
  extension: string | null;
}

export interface ThreeCxAssignmentList {
  users: ThreeCxAssignment[];
  /** Von der API-Anwendung überwachte Nebenstellen; null = nicht abrufbar */
  monitored: string[] | null;
  monitoredError?: string | null;
}

export interface ThreeCxAutoAssignResult {
  assigned: number;
  /** Benutzer ohne passende 3CX-Nebenstelle (E-Mail-Adresse) */
  unmatched: number;
}

/** Registriertes Gerät einer Nebenstelle (Tischtelefon, App, Webclient …) */
export interface ThreeCxDevice {
  deviceId: string;
  userAgent: string;
}

/** Eigene Telefonie-Einstellungen */
export interface ThreeCxMe {
  enabled: boolean;
  extension: string | null;
  /** Bevorzugtes Gerät für ausgehende Anrufe; null = automatisch */
  deviceId: string | null;
  devices: ThreeCxDevice[];
  devicesError?: string | null;
}

export interface ThreeCxCallResult {
  /** started: Anruf läuft; accepted: 3CX hat den Auftrag angenommen, Zustand noch offen */
  status: 'started' | 'accepted';
  /** Tatsächlich gewählte Nummer (nach Normalisierung) */
  destination: string;
  message: string;
}
