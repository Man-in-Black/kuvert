/**
 * Typen der Paperless-ngx-Anbindung: Dokumente suchen und an Mails anhängen
 * (oder als Freigabelink einfügen), Mail-Anhänge an Paperless übergeben.
 */

export interface PaperlessAdminConfig {
  enabled: boolean;
  /** Standard-URL von Paperless-ngx, z. B. https://paperless.example.com */
  baseUrl: string;
}

export interface PaperlessUserConfig {
  enabled: boolean;
  configured: boolean;
  /** Effektive URL (eigene oder Standard) */
  baseUrl: string | null;
  /** Eigene URL (überschreibt Standard) */
  overrideUrl: string | null;
  defaultBaseUrl: string | null;
  tokenHint: string | null;
}

export interface PaperlessStats {
  documents: number;
  /** Dokumente mit Posteingangs-Tag */
  inbox: number | null;
  correspondents: number | null;
  tags: number | null;
}

/** Korrespondent, Dokumenttyp oder Tag */
export interface PaperlessNamed {
  id: number;
  name: string;
  /** Nur bei Tags: Hintergrundfarbe */
  color?: string | null;
  documentCount?: number | null;
}

export interface PaperlessMeta {
  correspondents: PaperlessNamed[];
  documentTypes: PaperlessNamed[];
  tags: PaperlessNamed[];
}

export interface PaperlessDocument {
  id: number;
  title: string;
  /** Ausstellungsdatum (YYYY-MM-DD) */
  created: string | null;
  added: string | null;
  correspondent: number | null;
  documentType: number | null;
  tags: number[];
  originalFileName: string | null;
  /** Gesetzt, wenn Paperless ein durchsuchbares Archiv-PDF erzeugt hat */
  archivedFileName: string | null;
  mimeType: string | null;
  pageCount: number | null;
  /** Trefferausschnitt der Volltextsuche (reiner Text) */
  snippet: string | null;
}

export interface PaperlessSearchQuery {
  q?: string;
  correspondent?: number;
  documentType?: number;
  tag?: number;
  page?: number;
  pageSize?: number;
}

export interface PaperlessSearchResult {
  count: number;
  page: number;
  pageSize: number;
  results: PaperlessDocument[];
}

export interface PaperlessShareLink {
  url: string;
  expires: string | null;
}

/** Ergebnis von „an Paperless übergeben“: Paperless verarbeitet asynchron */
export interface PaperlessUploadResult {
  taskId: string;
}

export interface PaperlessTaskStatus {
  status: 'pending' | 'running' | 'success' | 'failure';
  message: string | null;
  documentId: number | null;
}
