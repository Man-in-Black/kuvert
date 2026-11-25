/** Gemeinsame Basistypen für Server und Web-Client. */

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Paged<T> {
  items: T[];
  /** Opaker Cursor für die nächste Seite; fehlt/null = keine weiteren Einträge */
  nextCursor?: string | null;
}

/** Fähigkeiten, die ein Konto (bzw. dessen Provider) anbieten kann. */
export type Capability = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'storage' | 'meetings';

export const ALL_CAPABILITIES: Capability[] = ['mail', 'calendar', 'contacts', 'tasks', 'storage', 'meetings'];

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
