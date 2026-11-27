/**
 * Anrufer erkennen: Rufnummer in den Kontakten des Benutzers (alle Konten mit Kontakten und
 * Kontaktquellen) und im 3CX-Telefonbuch suchen. Verglichen werden die letzten Ziffern, damit
 * „+49 30 1234567“, „0049301234567“ und „030 1234567“ zueinander passen.
 */
import type { Contact } from '@kuvert/shared';
import type { ModuleContext } from '../../core/module.js';
import type { ThreeCxClient } from './client.js';
import { searchContacts } from './directory.js';

export interface CallerInfo {
  name: string;
  company: string | null;
}

/** So viele Endziffern müssen übereinstimmen (kürzere Nummern: alle) */
const MATCH_DIGITS = 9;
/** Kürzere Nummern sind Nebenstellen oder Sonderrufnummern – die stehen nicht in Kontakten */
const MIN_DIGITS = 6;
const INDEX_TTL = 30 * 60_000;
const MAX_CONTACTS_PER_BOOK = 5000;

function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\(0\)/g, '').replace(/\D/g, '');
  if (digits.length < MIN_DIGITS) return null;
  return digits.slice(-MATCH_DIGITS);
}

const indexes = new Map<string, { at: number; data: Promise<Map<string, CallerInfo>> }>();

async function allContacts(ctx: ModuleContext, userId: string): Promise<Contact[]> {
  const out: Contact[] = [];
  const accs = ctx.accounts.withCapability(userId, 'contacts');
  await Promise.all(
    accs.map(async (a) => {
      try {
        const c = ctx.accounts.providersFor(a).contacts!;
        for (const book of await c.listAddressBooks()) {
          let cursor: string | undefined;
          let n = 0;
          do {
            const page = await c.listContacts(book.id, { cursor, limit: 1000 });
            out.push(...page.items);
            n += page.items.length;
            cursor = page.nextCursor ?? undefined;
          } while (cursor && n < MAX_CONTACTS_PER_BOOK);
        }
      } catch (err) {
        ctx.log.debug({ err, accountId: a.id }, '3CX: Kontakte für Anrufererkennung nicht lesbar');
      }
    }),
  );
  for (const s of ctx.hooks.contactSources) {
    if (!s.available(userId)) continue;
    try {
      out.push(...(await s.listContacts(userId)));
    } catch (err) {
      ctx.log.debug({ err, source: s.id }, '3CX: Kontaktquelle für Anrufererkennung nicht lesbar');
    }
  }
  return out;
}

function buildIndex(ctx: ModuleContext, userId: string): Promise<Map<string, CallerInfo>> {
  const cached = indexes.get(userId);
  if (cached && Date.now() - cached.at < INDEX_TTL) return cached.data;
  const data = allContacts(ctx, userId).then((contacts) => {
    const map = new Map<string, CallerInfo>();
    for (const c of contacts) {
      const name = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || '';
      if (!name) continue;
      for (const p of c.phones) {
        const key = phoneKey(p.number);
        if (key && !map.has(key)) map.set(key, { name, company: c.company && c.company !== name ? c.company : null });
      }
    }
    return map;
  });
  indexes.set(userId, { at: Date.now(), data });
  data.catch(() => {
    if (indexes.get(userId)?.data === data) indexes.delete(userId);
  });
  return data;
}

/** Kontakte im Hintergrund vorladen, damit der erste Anruf nicht warten muss */
export function warmCallerIndex(ctx: ModuleContext, userId: string) {
  void buildIndex(ctx, userId).catch(() => undefined);
}

export async function lookupCaller(ctx: ModuleContext, userId: string, number: string | null, client: ThreeCxClient, cacheKey: string): Promise<CallerInfo | null> {
  const key = phoneKey(number);
  if (!key) return null;
  try {
    const hit = (await buildIndex(ctx, userId)).get(key);
    if (hit) return hit;
  } catch {
    /* weiter mit dem 3CX-Telefonbuch */
  }
  try {
    const book = await searchContacts(client, cacheKey, '', 100_000);
    for (const c of book) {
      if (c.phones.some((p) => phoneKey(p.number) === key)) return { name: c.name, company: c.company && c.company !== c.name ? c.company : null };
    }
  } catch {
    /* Konfigurations-API nicht freigegeben – dann eben ohne Telefonbuch */
  }
  return null;
}
