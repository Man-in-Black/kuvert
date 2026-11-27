/**
 * Zeiterfassung (angelehnt an Kimai): Kunden → Projekte → Tätigkeiten sind für alle Benutzer
 * gemeinsam, Zeiteinträge gehören dem jeweiligen Benutzer. Zeiten sind ISO-Zeitstempel (UTC),
 * Dauern in Sekunden.
 */

export interface TtCustomer {
  id: string;
  name: string;
  number: string | null;
  comment: string | null;
  color: string | null;
  currency: string;
  /** Stundensatz (gilt, wenn Projekt/Tätigkeit keinen eigenen haben) */
  hourlyRate: number | null;
  visible: boolean;
  /** Aus Kimai übernommen */
  imported: boolean;
}

export interface TtProject {
  id: string;
  customerId: string;
  name: string;
  number: string | null;
  orderNumber: string | null;
  comment: string | null;
  color: string | null;
  hourlyRate: number | null;
  billable: boolean;
  visible: boolean;
  imported: boolean;
}

export interface TtActivity {
  id: string;
  /** null = globale Tätigkeit (für alle Projekte) */
  projectId: string | null;
  name: string;
  comment: string | null;
  color: string | null;
  hourlyRate: number | null;
  billable: boolean;
  visible: boolean;
  imported: boolean;
}

export interface TtMasterData {
  customers: TtCustomer[];
  projects: TtProject[];
  activities: TtActivity[];
}

export interface TtCustomerInput {
  name: string;
  number?: string | null;
  comment?: string | null;
  color?: string | null;
  currency?: string;
  hourlyRate?: number | null;
  visible?: boolean;
}

export interface TtProjectInput {
  customerId: string;
  name: string;
  number?: string | null;
  orderNumber?: string | null;
  comment?: string | null;
  color?: string | null;
  hourlyRate?: number | null;
  billable?: boolean;
  visible?: boolean;
}

export interface TtActivityInput {
  projectId: string | null;
  name: string;
  comment?: string | null;
  color?: string | null;
  hourlyRate?: number | null;
  billable?: boolean;
  visible?: boolean;
}

export interface TtEntry {
  id: string;
  projectId: string;
  activityId: string | null;
  customerId: string;
  /** Namen zur Anzeige (aufgelöst) */
  customerName: string;
  projectName: string;
  activityName: string | null;
  /** Farbe von Tätigkeit, Projekt oder Kunde */
  color: string | null;
  begin: string;
  /** null = läuft gerade */
  end: string | null;
  /** Sekunden; bei laufenden Einträgen bis jetzt */
  duration: number;
  description: string | null;
  tags: string[];
  billable: boolean;
  hourlyRate: number | null;
  fixedRate: number | null;
  /** Betrag des Eintrags */
  rate: number | null;
  currency: string;
  exported: boolean;
  imported: boolean;
}

export interface TtEntryInput {
  projectId: string;
  activityId?: string | null;
  begin: string;
  /** null = Timer läuft (nur für den neuesten Eintrag sinnvoll) */
  end?: string | null;
  description?: string | null;
  tags?: string[];
  billable?: boolean;
  fixedRate?: number | null;
}

export interface TtStartInput {
  projectId: string;
  activityId?: string | null;
  description?: string | null;
  tags?: string[];
  billable?: boolean;
}

export interface TtEntryList {
  items: TtEntry[];
  /** Summe der Dauern aller gefundenen Einträge (Sekunden) */
  total: number;
  /** Mehr Einträge vorhanden als geliefert */
  truncated: boolean;
}

/** Zuletzt verwendete Kombinationen für den Schnellstart */
export interface TtRecent {
  projectId: string;
  activityId: string | null;
  description: string | null;
  tags: string[];
  customerName: string;
  projectName: string;
  activityName: string | null;
  color: string | null;
  lastUsed: string;
}

export interface TtReportRow {
  customerId: string;
  customerName: string;
  projectId: string;
  projectName: string;
  activityId: string | null;
  activityName: string | null;
  color: string | null;
  currency: string;
  duration: number;
  billableDuration: number;
  amount: number;
  count: number;
}

export interface TtReport {
  from: string;
  to: string;
  rows: TtReportRow[];
  /** Summe je Kalendertag (Zeitzone des Browsers, Parameter tz) */
  days: { date: string; duration: number }[];
  total: number;
  billable: number;
  /** Beträge je Währung */
  amounts: { currency: string; amount: number }[];
  tags: { tag: string; duration: number }[];
}

/* ───────────────────────────── Kimai-Import ───────────────────────────── */

export interface TtKimaiConnection {
  baseUrl: string;
  /** Leer = API-Token (Kimai ≥ 2.0, Bearer); gesetzt = Benutzername + API-Passwort (Kimai 1.x) */
  username: string | null;
  tokenConfigured: boolean;
  lastImport: TtImportStatus | null;
}

export interface TtKimaiInput {
  baseUrl: string;
  /** Leer lassen = gespeicherten Token verwenden */
  token?: string;
  username?: string | null;
}

export interface TtKimaiTestResult {
  ok: boolean;
  version: string | null;
  user: string | null;
  message: string;
}

export type TtImportPhase = 'customers' | 'projects' | 'activities' | 'timesheets' | 'done';

export interface TtImportCounts {
  customers: number;
  projects: number;
  activities: number;
  /** neu angelegte Zeiteinträge */
  created: number;
  /** aktualisierte (bereits früher importierte) Zeiteinträge */
  updated: number;
  /** übersprungen (laufend oder ohne Projekt) */
  skipped: number;
}

export interface TtImportStatus {
  state: 'running' | 'done' | 'error';
  phase: TtImportPhase;
  /** Fortschritt der aktuellen Phase */
  done: number;
  total: number | null;
  counts: TtImportCounts;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
