/** Typen für den lokalen Volltext-Suchindex (Meilisearch). */

export type SearchAccountState = 'disabled' | 'pending' | 'indexing' | 'ready' | 'error';

export interface SearchAccountStatus {
  accountId: string;
  name: string;
  email: string;
  /** Vom Benutzer für dieses Konto deaktiviert */
  excluded: boolean;
  state: SearchAccountState;
  /** Anzahl Nachrichten im Index */
  documents: number;
  /** Nachrichten, deren Text noch nachgeladen wird (bereits über Kopfdaten auffindbar) */
  bodiesPending: number;
  foldersDone: number;
  foldersTotal: number;
  /** Ordner, der gerade eingelesen wird */
  currentFolder?: string | null;
  lastSyncAt?: string | null;
  error?: string | null;
}

export interface SearchStatus {
  /** Suchindex serverseitig eingerichtet und erreichbar */
  available: boolean;
  enabled: boolean;
  error?: string | null;
  accounts: SearchAccountStatus[];
}

export interface SearchAdminStatus {
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  version?: string | null;
  error?: string | null;
  documents: number;
  /** Speicherbedarf des Index in Bytes (falls von Meilisearch gemeldet) */
  sizeBytes?: number | null;
  isIndexing: boolean;
  accounts: { total: number; ready: number; indexing: number; errors: number };
}

export interface SearchResult {
  items: import('./mail').MessageSummary[];
  /** Geschätzte Gesamtzahl Treffer */
  total: number;
  processingTimeMs: number;
  /** true = Ergebnis kommt (zumindest teilweise) aus dem Index */
  indexed: boolean;
  /** Konten, die (noch) live beim Anbieter durchsucht wurden */
  liveAccounts: string[];
  errors: { accountId: string; account: string; message: string }[];
}
