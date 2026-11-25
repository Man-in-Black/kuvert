/**
 * CardDAV-Kontakte. Adressbuch-ID = Collection-URL, Kontakt-ID = vCard-URL.
 * Adressbücher werden kurz zwischengespeichert, gesucht wird clientseitig.
 */
import type { DAVAddressBook, DAVClient } from 'tsdav';
import type { AddressBook, AddressSuggestion, Contact, ContactInput, Paged } from '@kuvert/shared';
import { AuthError, NotFoundError } from '../../core/errors.js';
import type { AccountContext } from '../../core/module.js';
import type { ContactsProvider } from '../../core/providers.js';
import { contactMatches } from '../../core/contact-search.js';
import { DavSession, ensureOk, mapDavError } from './session.js';
import { buildVCard, newContactUid, parseVCards, vcardToContact, vcardUid, type VProp } from './vcard.js';

const BOOK_TTL = 5 * 60_000;
const CARD_TTL = 60_000;

interface CachedCard {
  contact: Contact;
  props: VProp[];
}

export class DavContactsProvider implements ContactsProvider {
  private books: { at: number; list: DAVAddressBook[] } | null = null;
  private cards = new Map<string, { at: number; items: CachedCard[] }>();
  private loading = new Map<string, Promise<CachedCard[]>>();

  constructor(
    private ctx: AccountContext,
    private session: DavSession,
  ) {}

  private get accountId() {
    return this.ctx.account.id;
  }

  private async call<T>(fn: (client: DAVClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session.carddav());
    } catch (err) {
      const mapped = mapDavError(err, 'CardDAV-Server');
      if (mapped instanceof AuthError) this.session.reset();
      throw mapped;
    }
  }

  async listAddressBooks(): Promise<AddressBook[]> {
    if (!this.books || Date.now() - this.books.at > BOOK_TTL) {
      const list = await this.call((c) => c.fetchAddressBooks());
      this.books = { at: Date.now(), list };
    }
    return this.books.list.map((b) => ({
      id: b.url,
      accountId: this.accountId,
      name: typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName : 'Kontakte',
      readOnly: false,
    }));
  }

  private toCached(obj: { url: string; etag?: string; data?: unknown }, bookId: string): CachedCard | undefined {
    if (!obj.data) return undefined;
    const props = parseVCards(String(obj.data))[0];
    if (!props) return undefined;
    return { props, contact: vcardToContact(props, { id: obj.url, accountId: this.accountId, addressBookId: bookId, etag: obj.etag }) };
  }

  private async load(bookId: string, force = false): Promise<CachedCard[]> {
    const cached = this.cards.get(bookId);
    if (!force && cached && Date.now() - cached.at < CARD_TTL) return cached.items;
    let p = this.loading.get(bookId);
    if (!p) {
      p = this.call((c) => c.fetchVCards({ addressBook: { url: bookId } }))
        .then((objs) => {
          const items = objs.map((o) => this.toCached(o, bookId)).filter((x): x is CachedCard => !!x);
          items.sort((a, b) => a.contact.displayName.localeCompare(b.contact.displayName, 'de'));
          this.cards.set(bookId, { at: Date.now(), items });
          return items;
        })
        .finally(() => this.loading.delete(bookId));
      this.loading.set(bookId, p);
    }
    return p;
  }

  async listContacts(addressBookId: string, opts: { search?: string; cursor?: string; limit?: number }): Promise<Paged<Contact>> {
    const all = await this.load(addressBookId);
    const filtered = opts.search ? all.filter((c) => contactMatches(c.contact, opts.search!)) : all;
    const offset = Math.max(0, Number(opts.cursor ?? 0) || 0);
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    return {
      items: filtered.slice(offset, offset + limit).map((c) => c.contact),
      nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    };
  }

  async getContact(addressBookId: string, contactId: string): Promise<Contact> {
    const found = (await this.load(addressBookId)).find((c) => c.contact.id === contactId);
    if (found) return found.contact;
    const fresh = await this.fetchOne(addressBookId, contactId);
    return fresh.contact;
  }

  private async fetchOne(bookId: string, url: string): Promise<CachedCard> {
    const objs = await this.call((c) => c.fetchVCards({ addressBook: { url: bookId }, objectUrls: [url] }));
    const cached = objs.map((o) => this.toCached(o, bookId)).find(Boolean);
    if (!cached) throw new NotFoundError('Kontakt');
    return cached;
  }

  async createContact(addressBookId: string, input: ContactInput): Promise<Contact> {
    const uid = newContactUid();
    const vcf = buildVCard(input, { uid });
    const filename = `${uid}.vcf`;
    await this.call(async (c) =>
      ensureOk(await c.createVCard({ addressBook: { url: addressBookId }, vCardString: vcf, filename }), 'Kontakt anlegen'),
    );
    this.cards.delete(addressBookId);
    const url = new URL(filename, addressBookId.endsWith('/') ? addressBookId : `${addressBookId}/`).href;
    try {
      return (await this.fetchOne(addressBookId, url)).contact;
    } catch {
      return vcardToContact(parseVCards(vcf)[0]!, { id: url, accountId: this.accountId, addressBookId });
    }
  }

  async updateContact(addressBookId: string, contactId: string, input: ContactInput): Promise<Contact> {
    const current = await this.fetchOne(addressBookId, contactId);
    const vcf = buildVCard(input, { uid: vcardUid(current.props) ?? newContactUid(), existing: current.props });
    await this.call(async (c) =>
      ensureOk(await c.updateVCard({ vCard: { url: contactId, etag: current.contact.etag, data: vcf } }), 'Kontakt ändern'),
    );
    this.cards.delete(addressBookId);
    try {
      return (await this.fetchOne(addressBookId, contactId)).contact;
    } catch {
      return vcardToContact(parseVCards(vcf)[0]!, { id: contactId, accountId: this.accountId, addressBookId });
    }
  }

  async deleteContact(addressBookId: string, contactId: string): Promise<void> {
    await this.call(async (c) => ensureOk(await c.deleteVCard({ vCard: { url: contactId } }), 'Kontakt löschen'));
    this.cards.delete(addressBookId);
  }

  /** Schnelle Vorschläge aus allen Adressbüchern (nutzt den Cache) */
  async suggest(query: string, limit: number): Promise<AddressSuggestion[]> {
    const books = await this.listAddressBooks();
    const out: AddressSuggestion[] = [];
    for (const b of books) {
      for (const c of await this.load(b.id)) {
        if (!contactMatches(c.contact, query)) continue;
        for (const e of c.contact.emails) {
          out.push({ address: e.address, name: c.contact.displayName, source: 'contact', accountId: this.accountId });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.cards.clear();
    this.books = null;
  }
}
