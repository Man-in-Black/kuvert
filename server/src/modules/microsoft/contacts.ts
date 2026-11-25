/**
 * Kontakte (Outlook) und Adressvorschläge (People-API / Verzeichnis).
 * Adressbuch "default" = Standard-Kontaktordner, sonst ID eines contactFolder.
 */
import type { AddressBook, AddressSuggestion, Contact, ContactInput, Paged } from '@kuvert/shared';
import type { AccountContext } from '../../core/module.js';
import { contactMatches, mergeSuggestions, suggestFromContacts, within } from '../../core/contact-search.js';
import type { ContactsProvider } from '../../core/providers.js';
import { enc, qs, type GraphClient } from './graph.js';

interface GPhysicalAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  countryOrRegion?: string | null;
  postalCode?: string | null;
}

interface GContact {
  id: string;
  displayName?: string;
  givenName?: string | null;
  surname?: string | null;
  companyName?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  emailAddresses?: { name?: string; address?: string }[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string | null;
  homeAddress?: GPhysicalAddress;
  businessAddress?: GPhysicalAddress;
  otherAddress?: GPhysicalAddress;
  birthday?: string | null;
  personalNotes?: string | null;
  businessHomePage?: string | null;
  changeKey?: string;
}

const CONTACT_SELECT =
  'id,displayName,givenName,surname,companyName,department,jobTitle,emailAddresses,businessPhones,homePhones,mobilePhone,homeAddress,businessAddress,otherAddress,birthday,personalNotes,businessHomePage,changeKey';

const DEFAULT_BOOK = 'default';
const CACHE_TTL = 120_000;

const isEmptyAddress = (a?: GPhysicalAddress) => !a || !(a.street || a.city || a.state || a.countryOrRegion || a.postalCode);

export class GraphContactsProvider implements ContactsProvider {
  private cache = new Map<string, { at: number; items: Contact[] }>();
  /** Laufende Ladevorgänge, damit schnelle Tastenanschläge nicht mehrfach alles laden */
  private loading = new Map<string, Promise<Contact[]>>();

  constructor(
    private graph: GraphClient,
    private ctx: AccountContext,
  ) {}

  private base(bookId: string): string {
    return !bookId || bookId === DEFAULT_BOOK ? '/me/contacts' : `/me/contactFolders/${enc(bookId)}/contacts`;
  }

  async listAddressBooks(): Promise<AddressBook[]> {
    const folders = await this.graph.all<{ id: string; displayName: string }>('/me/contactFolders?$top=100&$select=id,displayName');
    return [
      { id: DEFAULT_BOOK, accountId: this.ctx.account.id, name: 'Kontakte' },
      ...folders.map((f) => ({ id: f.id, accountId: this.ctx.account.id, name: f.displayName })),
    ];
  }

  private toContact(c: GContact, bookId: string): Contact {
    const phones: Contact['phones'] = [
      ...(c.mobilePhone ? [{ type: 'mobile', number: c.mobilePhone }] : []),
      ...(c.businessPhones ?? []).filter(Boolean).map((n) => ({ type: 'work', number: n })),
      ...(c.homePhones ?? []).filter(Boolean).map((n) => ({ type: 'home', number: n })),
    ];
    const addresses: NonNullable<Contact['addresses']> = [];
    const pushAddr = (type: string, a?: GPhysicalAddress) => {
      if (isEmptyAddress(a)) return;
      addresses.push({
        type,
        street: a!.street ?? undefined,
        city: a!.city ?? undefined,
        region: a!.state ?? undefined,
        country: a!.countryOrRegion ?? undefined,
        postalCode: a!.postalCode ?? undefined,
      });
    };
    pushAddr('work', c.businessAddress);
    pushAddr('home', c.homeAddress);
    pushAddr('other', c.otherAddress);
    const displayName =
      c.displayName || [c.givenName, c.surname].filter(Boolean).join(' ') || c.companyName || c.emailAddresses?.[0]?.address || '';
    return {
      id: c.id,
      accountId: this.ctx.account.id,
      addressBookId: bookId || DEFAULT_BOOK,
      displayName,
      firstName: c.givenName ?? undefined,
      lastName: c.surname ?? undefined,
      company: c.companyName ?? undefined,
      department: c.department ?? undefined,
      jobTitle: c.jobTitle ?? undefined,
      emails: (c.emailAddresses ?? []).filter((e) => e.address).map((e) => ({ address: e.address! })),
      phones,
      addresses,
      birthday: c.birthday ? c.birthday.slice(0, 10) : null,
      notes: c.personalNotes ?? undefined,
      website: c.businessHomePage ?? undefined,
      etag: c.changeKey,
    };
  }

  private toGraph(input: ContactInput): Record<string, unknown> {
    const phones = input.phones ?? [];
    const typeOf = (t?: string) => (t ?? '').toLowerCase();
    const mobile = phones.find((p) => ['mobile', 'cell', 'mobil', 'handy'].includes(typeOf(p.type)));
    const home = phones.filter((p) => ['home', 'privat', 'private'].includes(typeOf(p.type)));
    const business = phones.filter((p) => p !== mobile && !home.includes(p));
    const addrOf = (types: string[]): GPhysicalAddress => {
      const a = (input.addresses ?? []).find((x) => types.includes(typeOf(x.type)));
      return a
        ? { street: a.street ?? null, city: a.city ?? null, state: a.region ?? null, countryOrRegion: a.country ?? null, postalCode: a.postalCode ?? null }
        : { street: null, city: null, state: null, countryOrRegion: null, postalCode: null };
    };
    const firstUntyped = (input.addresses ?? []).find((x) => !['home', 'privat', 'private', 'other'].includes(typeOf(x.type)));
    const displayName =
      input.displayName || [input.firstName, input.lastName].filter(Boolean).join(' ') || input.company || input.emails?.[0]?.address || '';
    return {
      displayName,
      givenName: input.firstName ?? null,
      surname: input.lastName ?? null,
      companyName: input.company ?? null,
      department: input.department ?? null,
      jobTitle: input.jobTitle ?? null,
      emailAddresses: (input.emails ?? []).slice(0, 3).map((e) => ({ address: e.address, name: displayName || e.address })),
      mobilePhone: mobile?.number ?? null,
      businessPhones: business.map((p) => p.number).slice(0, 2),
      homePhones: home.map((p) => p.number).slice(0, 2),
      businessAddress: firstUntyped
        ? {
            street: firstUntyped.street ?? null,
            city: firstUntyped.city ?? null,
            state: firstUntyped.region ?? null,
            countryOrRegion: firstUntyped.country ?? null,
            postalCode: firstUntyped.postalCode ?? null,
          }
        : addrOf(['work', 'business', 'geschäftlich']),
      homeAddress: addrOf(['home', 'privat', 'private']),
      otherAddress: addrOf(['other']),
      birthday: input.birthday ? `${input.birthday.slice(0, 10)}T00:00:00Z` : null,
      personalNotes: input.notes ?? null,
      businessHomePage: input.website ?? null,
    };
  }

  /** Alle Kontakte eines Adressbuchs (kurz gecacht, für die lokale Suche) */
  private async loadAll(bookId: string): Promise<Contact[]> {
    const hit = this.cache.get(bookId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.items;
    let p = this.loading.get(bookId);
    if (!p) {
      p = this.graph
        .all<GContact>(`${this.base(bookId)}${qs({ $top: 500, $select: CONTACT_SELECT, $orderby: 'displayName' })}`, undefined, 10_000)
        .then((raw) => {
          const items = raw.map((c) => this.toContact(c, bookId));
          this.cache.set(bookId, { at: Date.now(), items });
          return items;
        })
        .finally(() => this.loading.delete(bookId));
      this.loading.set(bookId, p);
    }
    return p;
  }

  async listContacts(addressBookId: string, opts: { search?: string; cursor?: string; limit?: number }): Promise<Paged<Contact>> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    if (opts.search) {
      const all = await this.loadAll(addressBookId);
      const items = all.filter((c) => contactMatches(c, opts.search!)).slice(0, limit);
      return { items, nextCursor: null };
    }
    const url = opts.cursor ?? `${this.base(addressBookId)}${qs({ $top: limit, $select: CONTACT_SELECT, $orderby: 'displayName' })}`;
    const page = await this.graph.page<GContact>(url);
    return { items: page.items.map((c) => this.toContact(c, addressBookId)), nextCursor: page.next ?? null };
  }

  async getContact(addressBookId: string, contactId: string): Promise<Contact> {
    const c = await this.graph.json<GContact>(`${this.base(addressBookId)}/${enc(contactId)}?$select=${CONTACT_SELECT}`);
    return this.toContact(c, addressBookId);
  }

  async createContact(addressBookId: string, input: ContactInput): Promise<Contact> {
    const c = await this.graph.json<GContact>(this.base(addressBookId), { method: 'POST', body: this.toGraph(input) });
    this.cache.delete(addressBookId);
    return this.toContact(c, addressBookId);
  }

  async updateContact(addressBookId: string, contactId: string, input: ContactInput): Promise<Contact> {
    const c = await this.graph.json<GContact>(`${this.base(addressBookId)}/${enc(contactId)}`, { method: 'PATCH', body: this.toGraph(input) });
    this.cache.delete(addressBookId);
    return this.toContact(c, addressBookId);
  }

  async deleteContact(addressBookId: string, contactId: string): Promise<void> {
    await this.graph.raw(`${this.base(addressBookId)}/${enc(contactId)}`, { method: 'DELETE' });
    this.cache.delete(addressBookId);
  }

  /**
   * Vorschläge aus der People-API (Kontakte, Kollegen, häufige Kontakte) plus
   * lokale Teilstring-Suche in den Kontakten – die People-API findet nur Wortanfänge.
   */
  async suggest(query: string, limit: number): Promise<AddressSuggestion[]> {
    const accountId = this.ctx.account.id;
    const local = within(
      this.loadAll(DEFAULT_BOOK).then((all) => suggestFromContacts(all, query, limit, accountId)),
      2000,
      [] as AddressSuggestion[],
    );
    const people = this.graph
      .page<{
        displayName?: string;
        scoredEmailAddresses?: { address?: string }[];
        personType?: { class?: string; subclass?: string };
      }>(`/me/people${qs({ $search: `"${query.replace(/"/g, '')}"`, $top: limit, $select: 'displayName,scoredEmailAddresses,personType' })}`)
      .then((res) =>
        res.items.flatMap<AddressSuggestion>((p) => {
          const address = p.scoredEmailAddresses?.[0]?.address;
          if (!address) return [];
          const source = p.personType?.subclass === 'OrganizationUser' ? 'directory' : 'contact';
          return [{ name: p.displayName || undefined, address, source, accountId }];
        }),
      )
      .catch((err) => {
        this.ctx.log.debug({ err }, 'People-API nicht verfügbar – nur lokale Kontakte');
        return [] as AddressSuggestion[];
      });
    return mergeSuggestions(await Promise.all([people, local]), limit);
  }

  async dispose(): Promise<void> {
    this.cache.clear();
  }
}
