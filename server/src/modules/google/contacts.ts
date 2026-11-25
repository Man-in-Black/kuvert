/**
 * Google Kontakte (People API v1): "Meine Kontakte" (bearbeitbar) und
 * "Weitere Kontakte" (automatisch gesammelt, schreibgeschützt) + Firmenverzeichnis.
 */
import type { AddressBook, AddressSuggestion, Contact, ContactInput, Paged } from '@kuvert/shared';
import { contactMatches, mergeSuggestions, suggestFromContacts, within } from '../../core/contact-search.js';
import { BadRequestError } from '../../core/errors.js';
import type { ContactsProvider } from '../../core/providers.js';
import { gurl, type GoogleClient } from './client.js';

const BASE = 'https://people.googleapis.com/v1';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,urls,photos,metadata';
const OTHER_FIELDS = 'names,emailAddresses,phoneNumbers,photos,metadata';
const UPDATE_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,urls';

const BOOK_MAIN = 'contacts';
const BOOK_OTHER = 'other';
const CACHE_TTL = 120_000;

interface GPerson {
  resourceName: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string; unstructuredName?: string }[];
  emailAddresses?: { value?: string; type?: string; formattedType?: string }[];
  phoneNumbers?: { value?: string; type?: string; formattedType?: string }[];
  organizations?: { name?: string; title?: string; department?: string }[];
  addresses?: {
    type?: string;
    formattedType?: string;
    streetAddress?: string;
    city?: string;
    postalCode?: string;
    region?: string;
    country?: string;
  }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number }; text?: string }[];
  biographies?: { value?: string }[];
  urls?: { value?: string }[];
  photos?: { url?: string; default?: boolean }[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export class GoogleContactsProvider implements ContactsProvider {
  private warmedUp = false;
  private cache = new Map<string, { at: number; items: Contact[] }>();
  /** Laufende Ladevorgänge, damit schnelle Tastenanschläge nicht mehrfach alles laden */
  private loading = new Map<string, Promise<Contact[]>>();

  constructor(private g: GoogleClient) {}

  /**
   * Alle Kontakte eines Adressbuchs (kurz gecacht) für die lokale Suche –
   * Googles Suche findet nur Wortanfänge, "bittl" also nicht in "gerhard.bittl@…".
   */
  private loadAll(bookId: string): Promise<Contact[]> {
    const hit = this.cache.get(bookId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.items);
    let p = this.loading.get(bookId);
    if (!p) {
      const people =
        bookId === BOOK_OTHER
          ? this.g.paged<GPerson, { otherContacts?: GPerson[]; nextPageToken?: string }>(
              (pageToken) => gurl(`${BASE}/otherContacts`, { readMask: OTHER_FIELDS, pageSize: 1000, pageToken }),
              (r) => r.otherContacts,
              20,
            )
          : this.g.paged<GPerson, { connections?: GPerson[]; nextPageToken?: string }>(
              (pageToken) =>
                gurl(`${BASE}/people/me/connections`, { personFields: PERSON_FIELDS, pageSize: 1000, pageToken, sortOrder: 'FIRST_NAME_ASCENDING' }),
              (r) => r.connections,
              20,
            );
      p = people
        .then((list) => {
          const items = list.map((x) => this.toContact(x, bookId));
          this.cache.set(bookId, { at: Date.now(), items });
          return items;
        })
        .finally(() => this.loading.delete(bookId));
      this.loading.set(bookId, p);
    }
    return p;
  }

  /** Laut Google-Doku: Leere Suche vorab senden, damit der Suchindex aktuell ist. */
  private warmup() {
    if (this.warmedUp) return;
    this.warmedUp = true;
    void this.g.json(gurl(`${BASE}/people:searchContacts`, { query: '', readMask: 'names' })).catch(() => undefined);
    void this.g.json(gurl(`${BASE}/otherContacts:search`, { query: '', readMask: 'names' })).catch(() => undefined);
  }

  async listAddressBooks(): Promise<AddressBook[]> {
    return [
      { id: BOOK_MAIN, accountId: this.g.accountId, name: 'Meine Kontakte' },
      { id: BOOK_OTHER, accountId: this.g.accountId, name: 'Weitere Kontakte', readOnly: true },
    ];
  }

  private toContact(p: GPerson, addressBookId: string): Contact {
    const n = p.names?.[0];
    const org = p.organizations?.[0];
    const emails = (p.emailAddresses ?? []).filter((e) => e.value).map((e) => ({ type: e.formattedType ?? e.type, address: e.value! }));
    const b = p.birthdays?.find((x) => x.date)?.date;
    const photo = p.photos?.find((x) => !x.default)?.url;
    return {
      id: p.resourceName,
      accountId: this.g.accountId,
      addressBookId,
      displayName: n?.displayName || [n?.givenName, n?.familyName].filter(Boolean).join(' ') || org?.name || emails[0]?.address || '(Ohne Namen)',
      firstName: n?.givenName,
      lastName: n?.familyName,
      company: org?.name,
      department: org?.department,
      jobTitle: org?.title,
      emails,
      phones: (p.phoneNumbers ?? []).filter((x) => x.value).map((x) => ({ type: x.formattedType ?? x.type, number: x.value! })),
      addresses: (p.addresses ?? []).map((a) => ({
        type: a.formattedType ?? a.type,
        street: a.streetAddress,
        city: a.city,
        postalCode: a.postalCode,
        region: a.region,
        country: a.country,
      })),
      birthday: b?.month && b.day ? (b.year ? `${b.year}-${pad(b.month)}-${pad(b.day)}` : `--${pad(b.month)}-${pad(b.day)}`) : null,
      notes: p.biographies?.[0]?.value,
      website: p.urls?.[0]?.value,
      photoUrl: photo,
      etag: p.etag,
    };
  }

  private toPerson(c: ContactInput): Omit<GPerson, 'resourceName'> {
    const hasParts = !!(c.firstName || c.lastName);
    const birthday = (() => {
      if (!c.birthday) return undefined;
      const m = c.birthday.match(/^(\d{4}|--)-?(\d{2})-(\d{2})/);
      if (!m) return undefined;
      return [{ date: { year: m[1] === '--' ? undefined : Number(m[1]), month: Number(m[2]), day: Number(m[3]) } }];
    })();
    return {
      names: [hasParts ? { givenName: c.firstName, familyName: c.lastName } : { unstructuredName: c.displayName }],
      emailAddresses: c.emails.map((e) => ({ value: e.address, type: e.type })),
      phoneNumbers: c.phones.map((p) => ({ value: p.number, type: p.type })),
      organizations: c.company || c.jobTitle || c.department ? [{ name: c.company, title: c.jobTitle, department: c.department }] : [],
      addresses: (c.addresses ?? []).map((a) => ({
        type: a.type,
        streetAddress: a.street,
        city: a.city,
        postalCode: a.postalCode,
        region: a.region,
        country: a.country,
      })),
      birthdays: birthday ?? [],
      biographies: c.notes ? [{ value: c.notes }] : [],
      urls: c.website ? [{ value: c.website }] : [],
    };
  }

  async listContacts(addressBookId: string, opts: { search?: string; cursor?: string; limit?: number }): Promise<Paged<Contact>> {
    const limit = opts.limit ?? 200;
    const search = opts.search?.trim();
    if (search && (addressBookId === BOOK_MAIN || addressBookId === BOOK_OTHER)) {
      try {
        const all = await this.loadAll(addressBookId);
        return { items: all.filter((c) => contactMatches(c, search)).slice(0, limit), nextCursor: null };
      } catch {
        /* Fallback: Googles Suche (nur Wortanfänge) */
      }
    }
    if (addressBookId === BOOK_OTHER) {
      if (search) {
        this.warmup();
        const res = await this.g.json<{ results?: { person: GPerson }[] }>(
          gurl(`${BASE}/otherContacts:search`, { query: search, readMask: OTHER_FIELDS, pageSize: Math.min(limit, 30) }),
        );
        return { items: (res.results ?? []).map((r) => this.toContact(r.person, BOOK_OTHER)), nextCursor: null };
      }
      const res = await this.g.json<{ otherContacts?: GPerson[]; nextPageToken?: string }>(
        gurl(`${BASE}/otherContacts`, { readMask: OTHER_FIELDS, pageSize: Math.min(limit, 1000), pageToken: opts.cursor }),
      );
      return { items: (res.otherContacts ?? []).map((p) => this.toContact(p, BOOK_OTHER)), nextCursor: res.nextPageToken ?? null };
    }
    if (addressBookId !== BOOK_MAIN) throw new BadRequestError('Unbekanntes Adressbuch');
    if (search) {
      this.warmup();
      const res = await this.g.json<{ results?: { person: GPerson }[] }>(
        gurl(`${BASE}/people:searchContacts`, { query: search, readMask: PERSON_FIELDS, pageSize: Math.min(limit, 30) }),
      );
      return { items: (res.results ?? []).map((r) => this.toContact(r.person, BOOK_MAIN)), nextCursor: null };
    }
    const res = await this.g.json<{ connections?: GPerson[]; nextPageToken?: string }>(
      gurl(`${BASE}/people/me/connections`, {
        personFields: PERSON_FIELDS,
        pageSize: Math.min(limit, 1000),
        pageToken: opts.cursor,
        sortOrder: 'FIRST_NAME_ASCENDING',
      }),
    );
    return { items: (res.connections ?? []).map((p) => this.toContact(p, BOOK_MAIN)), nextCursor: res.nextPageToken ?? null };
  }

  async getContact(addressBookId: string, contactId: string): Promise<Contact> {
    const p = await this.g.json<GPerson>(
      gurl(`${BASE}/${contactId}`, { personFields: addressBookId === BOOK_OTHER ? undefined : PERSON_FIELDS, readMask: addressBookId === BOOK_OTHER ? OTHER_FIELDS : undefined }),
    );
    return this.toContact(p, addressBookId);
  }

  private assertWritable(addressBookId: string) {
    if (addressBookId !== BOOK_MAIN) throw new BadRequestError('"Weitere Kontakte" sind schreibgeschützt');
  }

  async createContact(addressBookId: string, input: ContactInput): Promise<Contact> {
    this.assertWritable(addressBookId);
    const p = await this.g.json<GPerson>(gurl(`${BASE}/people:createContact`, { personFields: PERSON_FIELDS }), {
      method: 'POST',
      body: this.toPerson(input),
    });
    this.cache.delete(BOOK_MAIN);
    return this.toContact(p, BOOK_MAIN);
  }

  async updateContact(addressBookId: string, contactId: string, input: ContactInput): Promise<Contact> {
    this.assertWritable(addressBookId);
    const current = await this.g.json<GPerson>(gurl(`${BASE}/${contactId}`, { personFields: 'metadata' }));
    const p = await this.g.json<GPerson>(
      gurl(`${BASE}/${contactId}:updateContact`, { updatePersonFields: UPDATE_FIELDS, personFields: PERSON_FIELDS }),
      { method: 'PATCH', body: { ...this.toPerson(input), resourceName: contactId, etag: current.etag } },
    );
    this.cache.delete(BOOK_MAIN);
    return this.toContact(p, BOOK_MAIN);
  }

  async deleteContact(addressBookId: string, contactId: string): Promise<void> {
    this.assertWritable(addressBookId);
    await this.g.fetch(`${BASE}/${contactId}:deleteContact`, { method: 'DELETE' });
    this.cache.delete(BOOK_MAIN);
  }

  async suggest(query: string, limit: number): Promise<AddressSuggestion[]> {
    this.warmup();
    const mask = 'names,emailAddresses';
    const accountId = this.g.accountId;
    const local = within(
      Promise.allSettled([this.loadAll(BOOK_MAIN), this.loadAll(BOOK_OTHER)]).then((r) =>
        suggestFromContacts(
          r.flatMap((x) => (x.status === 'fulfilled' ? x.value : [])),
          query,
          limit,
          accountId,
        ),
      ),
      2000,
      [] as AddressSuggestion[],
    );
    const [own, other, dir, localHits] = await Promise.allSettled([
      this.g.json<{ results?: { person: GPerson }[] }>(gurl(`${BASE}/people:searchContacts`, { query, readMask: mask, pageSize: limit })),
      this.g.json<{ results?: { person: GPerson }[] }>(gurl(`${BASE}/otherContacts:search`, { query, readMask: mask, pageSize: limit })),
      this.g.json<{ people?: GPerson[] }>(
        gurl(`${BASE}/people:searchDirectoryPeople`, {
          query,
          readMask: mask,
          pageSize: limit,
          sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'],
        }),
      ),
      local,
    ]);
    const toSuggestions = (people: GPerson[], source: AddressSuggestion['source']) =>
      people.flatMap((p) =>
        (p.emailAddresses ?? [])
          .filter((e) => e.value)
          .map<AddressSuggestion>((e) => ({ name: p.names?.[0]?.displayName, address: e.value!, source, accountId })),
      );
    return mergeSuggestions(
      [
        own.status === 'fulfilled' ? toSuggestions((own.value.results ?? []).map((r) => r.person), 'contact') : [],
        other.status === 'fulfilled' ? toSuggestions((other.value.results ?? []).map((r) => r.person), 'contact') : [],
        localHits.status === 'fulfilled' ? localHits.value : [],
        dir.status === 'fulfilled' ? toSuggestions(dir.value.people ?? [], 'directory') : [],
      ],
      limit,
    );
  }
}
