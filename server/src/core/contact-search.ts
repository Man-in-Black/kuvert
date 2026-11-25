/**
 * Lokale Kontaktsuche: findet Suchbegriffe überall im Kontakt (Teilstring),
 * nicht nur am Wortanfang – unabhängig von Groß-/Kleinschreibung und Akzenten.
 */
import type { AddressSuggestion, Contact } from '@kuvert/shared';

/** Kleinbuchstaben, Akzente entfernt (é → e, ü → u), ß → ss */
export function foldSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
}

/** Jedes Wort der Suche muss irgendwo in Name, Firma, E-Mail oder Telefon vorkommen. */
export function contactMatches(c: Contact, q: string): boolean {
  const parts = foldSearch(q).split(/\s+/).filter(Boolean);
  if (!parts.length) return true;
  const phones = c.phones.map((p) => p.number);
  const hay = foldSearch(
    [
      c.displayName,
      c.firstName,
      c.lastName,
      c.company,
      c.department,
      c.jobTitle,
      ...c.emails.map((e) => e.address),
      ...phones,
      ...phones.map((p) => p.replace(/[\s\-/()]/g, '')),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return parts.every((part) => hay.includes(part));
}

/** Adressvorschläge aus einer Kontaktliste per Teilstring-Suche */
export function suggestFromContacts(contacts: Contact[], q: string, limit: number, accountId: string): AddressSuggestion[] {
  const out: AddressSuggestion[] = [];
  for (const c of contacts) {
    if (!c.emails.length || !contactMatches(c, q)) continue;
    for (const e of c.emails) {
      out.push({ address: e.address, name: c.displayName, source: 'contact', accountId });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Vorschlagslisten zusammenführen, doppelte Adressen nur einmal */
export function mergeSuggestions(lists: AddressSuggestion[][], limit: number): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const s of lists.flat()) {
    const key = s.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Wartet höchstens ms auf p; danach leeres Ergebnis (p läuft im Hintergrund weiter, z. B. zum Cache-Füllen). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}
