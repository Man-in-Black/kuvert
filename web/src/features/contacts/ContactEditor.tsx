import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import type { AccountInfo, AddressBook, Contact, ContactInput } from '@kuvert/shared';
import { Button, Field, IconButton, Input, Modal, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { ADDRESS_TYPES, EMAIL_TYPES, PHONE_TYPES, bookKey, createContact, updateContact, type BookSelection } from './api';

type Addr = NonNullable<ContactInput['addresses']>[number];

function emptyInput(): ContactInput {
  return {
    displayName: '',
    firstName: '',
    lastName: '',
    company: '',
    department: '',
    jobTitle: '',
    emails: [{ type: 'work', address: '' }],
    phones: [{ type: 'mobile', number: '' }],
    addresses: [],
    birthday: null,
    notes: '',
    website: '',
  };
}

function fromContact(c: Contact): ContactInput {
  return {
    displayName: c.displayName ?? '',
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    company: c.company ?? '',
    department: c.department ?? '',
    jobTitle: c.jobTitle ?? '',
    emails: c.emails.length ? c.emails.map((e) => ({ ...e })) : [{ type: 'work', address: '' }],
    phones: c.phones.length ? c.phones.map((p) => ({ ...p })) : [{ type: 'mobile', number: '' }],
    addresses: (c.addresses ?? []).map((a) => ({ ...a })),
    birthday: c.birthday ?? null,
    notes: c.notes ?? '',
    website: c.website ?? '',
    photoUrl: c.photoUrl,
  };
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Dialog zum Anlegen/Bearbeiten eines Kontakts. */
export function ContactEditor({
  contact,
  addressBooks,
  defaultBook,
  accountMap,
  onClose,
  onSaved,
}: {
  contact?: Contact;
  addressBooks: AddressBook[];
  defaultBook?: BookSelection | null;
  accountMap: Map<string, AccountInfo>;
  onClose: () => void;
  onSaved?: (c: Contact) => void;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<ContactInput>(() => (contact ? fromContact(contact) : emptyInput()));
  const writable = addressBooks.filter((b) => !b.readOnly);
  const [book, setBook] = useState<string>(() => {
    if (contact) return bookKey({ accountId: contact.accountId, id: contact.addressBookId });
    if (defaultBook && writable.some((b) => b.accountId === defaultBook.accountId && b.id === defaultBook.addressBookId))
      return bookKey({ accountId: defaultBook.accountId, id: defaultBook.addressBookId });
    return writable[0] ? bookKey(writable[0]) : '';
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ContactInput>(k: K, val: ContactInput[K]) => setV((p) => ({ ...p, [k]: val }));

  const grouped = useMemo(() => {
    const m = new Map<string, AddressBook[]>();
    for (const b of writable) m.set(b.accountId, [...(m.get(b.accountId) ?? []), b]);
    return [...m.entries()];
  }, [writable]);

  const save = async () => {
    const target = addressBooks.find((b) => bookKey(b) === book);
    if (!target) {
      toast.error('Bitte ein Adressbuch wählen');
      return;
    }
    const input: ContactInput = {
      ...v,
      emails: v.emails.filter((e) => e.address.trim()).map((e) => ({ ...e, address: e.address.trim() })),
      phones: v.phones.filter((p) => p.number.trim()),
      addresses: (v.addresses ?? []).filter((a) => Object.entries(a).some(([k, val]) => k !== 'type' && String(val ?? '').trim())),
      birthday: v.birthday || null,
    };
    input.displayName =
      v.displayName.trim() ||
      [v.firstName, v.lastName].filter((x) => x?.trim()).join(' ') ||
      v.company?.trim() ||
      input.emails[0]?.address ||
      '';
    if (!input.displayName) {
      toast.error('Bitte mindestens einen Namen oder eine E-Mail-Adresse angeben');
      return;
    }
    setSaving(true);
    try {
      const saved = contact
        ? await updateContact(contact.accountId, contact.addressBookId, contact.id, input)
        : await createContact(target.accountId, target.id, input);
      toast.success(contact ? 'Kontakt gespeichert' : 'Kontakt angelegt');
      await qc.invalidateQueries({ queryKey: ['contacts'] });
      onSaved?.({ ...saved, accountId: saved.accountId ?? target.accountId, addressBookId: saved.addressBookId ?? target.id });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const updateAddr = (i: number, patch: Partial<Addr>) =>
    set(
      'addresses',
      (v.addresses ?? []).map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    );

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={contact ? 'Kontakt bearbeiten' : 'Neuer Kontakt'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!contact && (
          <Field label="Adressbuch">
            <Select value={book} onChange={(e) => setBook(e.target.value)}>
              {!book && <option value="">– wählen –</option>}
              {grouped.map(([accId, books]) => (
                <optgroup key={accId} label={accountMap.get(accId)?.name ?? accId}>
                  {books.map((b) => (
                    <option key={bookKey(b)} value={bookKey(b)}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vorname">
            <Input autoFocus value={v.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} />
          </Field>
          <Field label="Nachname">
            <Input value={v.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} />
          </Field>
          <Field label="Anzeigename" hint="Leer = aus Vor- und Nachname" className="sm:col-span-2">
            <Input value={v.displayName} onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="Firma">
            <Input value={v.company ?? ''} onChange={(e) => set('company', e.target.value)} />
          </Field>
          <Field label="Abteilung">
            <Input value={v.department ?? ''} onChange={(e) => set('department', e.target.value)} />
          </Field>
          <Field label="Position" className="sm:col-span-2">
            <Input value={v.jobTitle ?? ''} onChange={(e) => set('jobTitle', e.target.value)} />
          </Field>
        </div>

        <Section
          title="E-Mail"
          action={
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set('emails', [...v.emails, { type: 'work', address: '' }])}>
              Hinzufügen
            </Button>
          }
        >
          {v.emails.map((e, i) => (
            <div key={i} className="flex gap-2">
              <Select className="w-32" value={e.type ?? 'other'} onChange={(ev) => set('emails', v.emails.map((x, j) => (j === i ? { ...x, type: ev.target.value } : x)))}>
                {EMAIL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input
                type="email"
                placeholder="name@beispiel.de"
                value={e.address}
                onChange={(ev) => set('emails', v.emails.map((x, j) => (j === i ? { ...x, address: ev.target.value } : x)))}
              />
              <IconButton label="Entfernen" onClick={() => set('emails', v.emails.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          ))}
        </Section>

        <Section
          title="Telefon"
          action={
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set('phones', [...v.phones, { type: 'mobile', number: '' }])}>
              Hinzufügen
            </Button>
          }
        >
          {v.phones.map((p, i) => (
            <div key={i} className="flex gap-2">
              <Select className="w-32" value={p.type ?? 'other'} onChange={(ev) => set('phones', v.phones.map((x, j) => (j === i ? { ...x, type: ev.target.value } : x)))}>
                {PHONE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input
                type="tel"
                placeholder="+49 …"
                value={p.number}
                onChange={(ev) => set('phones', v.phones.map((x, j) => (j === i ? { ...x, number: ev.target.value } : x)))}
              />
              <IconButton label="Entfernen" onClick={() => set('phones', v.phones.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          ))}
        </Section>

        <Section
          title="Adressen"
          action={
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set('addresses', [...(v.addresses ?? []), { type: 'work' }])}>
              Hinzufügen
            </Button>
          }
        >
          {(v.addresses ?? []).length === 0 && <div className="text-xs text-muted">Keine Adresse hinterlegt.</div>}
          {(v.addresses ?? []).map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex gap-2">
                <Select className="w-32" value={a.type ?? 'other'} onChange={(e) => updateAddr(i, { type: e.target.value })}>
                  {ADDRESS_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <Input placeholder="Straße und Hausnummer" value={a.street ?? ''} onChange={(e) => updateAddr(i, { street: e.target.value })} />
                <IconButton label="Entfernen" onClick={() => set('addresses', (v.addresses ?? []).filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-2">
                <Input placeholder="PLZ" value={a.postalCode ?? ''} onChange={(e) => updateAddr(i, { postalCode: e.target.value })} />
                <Input placeholder="Ort" value={a.city ?? ''} onChange={(e) => updateAddr(i, { city: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Bundesland/Region" value={a.region ?? ''} onChange={(e) => updateAddr(i, { region: e.target.value })} />
                <Input placeholder="Land" value={a.country ?? ''} onChange={(e) => updateAddr(i, { country: e.target.value })} />
              </div>
            </div>
          ))}
        </Section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Geburtstag">
            <Input type="date" value={v.birthday ? v.birthday.slice(0, 10) : ''} onChange={(e) => set('birthday', e.target.value || null)} />
          </Field>
          <Field label="Webseite">
            <Input type="url" placeholder="https://" value={v.website ?? ''} onChange={(e) => set('website', e.target.value)} />
          </Field>
        </div>
        <Field label="Notizen">
          <Textarea rows={4} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
