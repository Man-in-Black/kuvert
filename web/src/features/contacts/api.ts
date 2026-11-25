/** Datenzugriff für Kontakte. Alle Query-Keys beginnen mit 'contacts'. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AddressBook, Contact, ContactInput } from '@kuvert/shared';
import { api } from '@/lib/api';

export interface AccountError {
  accountId: string;
  account: string;
  message: string;
}

export interface BookSelection {
  accountId: string;
  addressBookId: string;
}

export const bookKey = (b: { accountId: string; id: string }) => `${b.accountId}|${b.id}`;

export function useAddressBooks() {
  return useQuery({
    queryKey: ['contacts', 'addressbooks'],
    queryFn: () => api<{ addressBooks: AddressBook[]; errors: AccountError[] }>('/contacts/addressbooks'),
    staleTime: 5 * 60_000,
  });
}

export function useContactList(book: BookSelection | null, search: string) {
  return useQuery({
    queryKey: ['contacts', 'list', book?.accountId ?? 'all', book?.addressBookId ?? 'all', search],
    queryFn: async () => {
      const res = await api<{ items: Contact[]; nextCursor?: string | null; errors?: AccountError[] }>('/contacts', {
        query: { accountId: book?.accountId, addressBookId: book?.addressBookId, search: search || undefined, limit: 1000 },
      });
      // Einzelnes Adressbuch: Provider-Antwort ggf. um Konto/Adressbuch ergänzen
      if (book) res.items = res.items.map((c) => ({ ...c, accountId: c.accountId || book.accountId, addressBookId: c.addressBookId || book.addressBookId }));
      return res;
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function createContact(accountId: string, addressBookId: string, contact: ContactInput) {
  return api<Contact>(`/contacts/accounts/${encodeURIComponent(accountId)}`, { method: 'POST', body: { addressBookId, contact } });
}

export function updateContact(accountId: string, addressBookId: string, contactId: string, contact: ContactInput) {
  return api<Contact>(`/contacts/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    body: { addressBookId, contactId, contact },
  });
}

export function deleteContact(accountId: string, addressBookId: string, contactId: string) {
  return api(`/contacts/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', query: { addressBookId, contactId } });
}

export const EMAIL_TYPES: { value: string; label: string }[] = [
  { value: 'work', label: 'Arbeit' },
  { value: 'home', label: 'Privat' },
  { value: 'other', label: 'Sonstige' },
];

export const PHONE_TYPES: { value: string; label: string }[] = [
  { value: 'mobile', label: 'Mobil' },
  { value: 'work', label: 'Arbeit' },
  { value: 'home', label: 'Privat' },
  { value: 'fax', label: 'Fax' },
  { value: 'other', label: 'Sonstige' },
];

export const ADDRESS_TYPES: { value: string; label: string }[] = [
  { value: 'work', label: 'Arbeit' },
  { value: 'home', label: 'Privat' },
  { value: 'other', label: 'Sonstige' },
];

export function typeLabel(list: { value: string; label: string }[], t?: string): string {
  if (!t) return '';
  return list.find((x) => x.value === t.toLowerCase())?.label ?? t;
}
