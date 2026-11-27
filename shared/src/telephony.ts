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
  /** Ergebnis für die Konfigurations-API (Status, Anrufliste, Telefonbuch, Kollegen) */
  configApi?: { ok: boolean; message: string };
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
  /** Bei eingehenden Anrufen benachrichtigen (Hinweis, Desktop, Web Push) */
  notifyCalls: boolean;
}

export interface ThreeCxCallResult {
  /** started: Anruf läuft; accepted: 3CX hat den Auftrag angenommen, Zustand noch offen */
  status: 'started' | 'accepted';
  /** Tatsächlich gewählte Nummer (nach Normalisierung) */
  destination: string;
  message: string;
}

/* ───────────── Bereich „Telefon“ (3CX-Konfigurations-API + Call Control) ───────────── */

/** Anwesenheitsprofile von 3CX V20 (CurrentProfileName) */
export type ThreeCxProfile = 'Available' | 'Away' | 'Out of office' | 'Custom 1' | 'Custom 2';

/** Eintrag im 3CX-Telefonbuch */
export interface ThreeCxContact {
  id: number;
  name: string;
  company: string | null;
  department: string | null;
  title: string | null;
  email: string | null;
  phones: { type: 'mobile' | 'work' | 'home' | 'other' | 'fax'; number: string }[];
}

/** Kollege (3CX-Benutzer) mit Status */
export interface ThreeCxColleague {
  extension: string;
  name: string;
  email: string | null;
  mobile: string | null;
  /** Anwesenheitsprofil, z. B. "Available" */
  profile: string | null;
  /** Mindestens ein Gerät angemeldet */
  registered: boolean;
  /** Gerade im Gespräch oder klingelt (nur für überwachte Nebenstellen bekannt) */
  onCall: boolean | null;
  /** Das bin ich */
  me: boolean;
}

export interface ThreeCxColleagueList {
  colleagues: ThreeCxColleague[];
  /** Eigenes Anwesenheitsprofil */
  myProfile: string | null;
}

export type ThreeCxCallDirection = 'in' | 'out' | 'missed' | 'internal';

/** Eintrag der eigenen Anrufliste */
export interface ThreeCxCallLogEntry {
  id: string;
  start: string;
  direction: ThreeCxCallDirection;
  /** Gegenstelle: Name (falls bekannt) und Nummer zum Zurückrufen */
  name: string | null;
  number: string | null;
  answered: boolean;
  /** Gesprächsdauer in Sekunden */
  talkSeconds: number;
  status: string | null;
}

export interface ThreeCxCallLog {
  entries: ThreeCxCallLogEntry[];
  days: number;
}

/** Eingehender Anruf an der eigenen Nebenstelle (Echtzeit-Ereignis "threecx.call") */
export interface ThreeCxIncomingCall {
  /** Eindeutig je Anruf und Nebenstelle – Folgemeldungen ersetzen bzw. schließen die Benachrichtigung */
  key: string;
  /** ringing: klingelt · answered: angenommen · ended: vorbei (angenommen oder woanders) · missed: verpasst */
  state: 'ringing' | 'answered' | 'ended' | 'missed';
  /** Rufnummer bzw. Nebenstelle der anrufenden Person */
  number: string | null;
  /** Name aus Kuvert-Kontakten, 3CX-Telefonbuch oder laut 3CX */
  name: string | null;
  company: string | null;
  /** Interner Anruf von einer Nebenstelle */
  internal: boolean;
  /** Über Warteschlange oder Ringgruppe zugestellt (deren Nummer bzw. Name) */
  via: string | null;
  at: string;
}

/** Laufendes Gespräch der eigenen Nebenstelle */
export interface ThreeCxActiveCall {
  participantId: number;
  /** Ringing, Dialing, Connected … (Wert von 3CX) */
  status: string;
  name: string | null;
  number: string | null;
}
