import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  AlertTriangle,
  BookUser,
  Briefcase,
  Cake,
  ChevronLeft,
  Download,
  Globe,
  Mail,
  MapPin,
  Menu,
  Pencil,
  Phone,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Users,
} from 'lucide-react';
import type { AddressBook, Contact } from '@kuvert/shared';
import { Avatar, Button, ColorDot, EmptyState, IconButton, Input, SidebarSheet, Spinner, useConfirm } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { openCompose } from '@/features/mail/compose-api';
import { ADDRESS_TYPES, EMAIL_TYPES, PHONE_TYPES, bookKey, deleteContact, typeLabel, useAddressBooks, useContactList, type BookSelection } from './api';
import { ContactEditor } from './ContactEditor';
import { downloadVCard } from './vcard';

const contactKey = (c: Contact) => `${c.accountId}|${c.addressBookId}|${c.id}`;

function letterOf(name: string): string {
  const ch = name.trim().charAt(0).toLocaleUpperCase('de');
  if (!ch) return '#';
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /[A-Z]/.test(base) ? base : '#';
}

export default function ContactsPage() {
  const accountMap = useAccountMap();
  const { data: booksData, isLoading: booksLoading } = useAddressBooks();
  const books = booksData?.addressBooks ?? [];
  const [book, setBook] = useState<BookSelection | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ contact?: Contact } | null>(null);

  // Mobil: Adressbücher als Schublade, Liste und Details nacheinander
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isFetching, error } = useContactList(book, debounced);
  const contacts = useMemo(
    () => [...(data?.items ?? [])].sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'de', { sensitivity: 'base' })),
    [data],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Contact[]>();
    for (const c of contacts) {
      const l = letterOf(c.displayName || c.emails[0]?.address || '');
      m.set(l, [...(m.get(l) ?? []), c]);
    }
    return [...m.entries()];
  }, [contacts]);
  const current = contacts.find((c) => contactKey(c) === selected) ?? null;

  /** Herkunft eines Kontakts: Mailkonto oder Quelle ohne Konto (z. B. ein CRM) */
  const sourceOf = (accountId: string): Origin | undefined => {
    const acc = accountMap.get(accountId);
    if (acc) return { name: acc.name, color: acc.color };
    const b = books.find((x) => x.accountId === accountId && x.sourceName);
    return b ? { name: b.sourceName!, color: b.sourceColor } : undefined;
  };

  const booksByAccount = useMemo(() => {
    const m = new Map<string, AddressBook[]>();
    for (const b of books) m.set(b.accountId, [...(m.get(b.accountId) ?? []), b]);
    return [...m.entries()];
  }, [books]);

  const errors = [...(booksData?.errors ?? []), ...(data?.errors ?? [])].filter((e, i, arr) => arr.findIndex((x) => x.accountId === e.accountId) === i);
  const noBooks = !booksLoading && books.length === 0;
  const isBookActive = (b: AddressBook) => book?.accountId === b.accountId && book.addressBookId === b.id;
  const canCreate = books.some((b) => !b.readOnly);
  const bookLabel = book ? (books.find((b) => b.accountId === book.accountId && b.id === book.addressBookId)?.name ?? 'Adressbuch') : 'Alle Kontakte';
  const pickBook = (sel: BookSelection | null) => {
    setBook(sel);
    setNavOpen(false);
  };
  const newContact = () => {
    setNavOpen(false);
    setEditor({});
  };
  const showDetail = isMobile && !!current;

  const sidebarContent = (
    <>
      <div className="p-3">
        <Button variant="primary" className="w-full justify-center" icon={<Plus className="h-4 w-4" />} disabled={!canCreate} onClick={newContact}>
          Neuer Kontakt
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <button
          type="button"
          onClick={() => pickBook(null)}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover', !book && 'bg-primary-soft text-primary hover:bg-primary-soft')}
        >
          <Users className="h-4 w-4" /> Alle Kontakte
        </button>
        {booksLoading && (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        )}
        {booksByAccount.map(([accId, list]) => {
          const origin = sourceOf(accId);
          return (
            <div key={accId} className="mt-3">
              <div className="flex items-center gap-1.5 px-2 pb-1">
                <ColorDot color={origin?.color} />
                <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{origin?.name ?? 'Konto'}</span>
              </div>
              {list.map((b) => (
                <button
                  key={bookKey(b)}
                  type="button"
                  onClick={() => pickBook({ accountId: b.accountId, addressBookId: b.id })}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover',
                    isBookActive(b) && 'bg-primary-soft text-primary hover:bg-primary-soft',
                  )}
                >
                  <BookUser className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.readOnly && <span className="text-[10px] text-muted">nur lesen</span>}
                </button>
              ))}
            </div>
          );
        })}
        {errors.length > 0 && (
          <div className="mt-3 space-y-1">
            {errors.map((e) => (
              <div key={e.accountId} className="flex gap-1.5 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger" title={e.message}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{e.account}:</span> {e.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </nav>
    </>
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* Adressbücher */}
      {!isMobile && <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">{sidebarContent}</aside>}

      {/* Liste */}
      <section
        className={cn(
          'flex flex-col bg-surface',
          isMobile ? 'min-w-0 flex-1' : 'w-80 shrink-0 border-r border-border',
          showDetail && 'hidden',
        )}
      >
        {isMobile && (
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-hover hover:text-fg"
            >
              <Menu className="h-4 w-4 shrink-0" />
              <span className="truncate">{bookLabel}</span>
            </button>
            <div className="flex-1" />
            <IconButton label="Neuer Kontakt" size="icon-sm" disabled={!canCreate} onClick={newContact}>
              <Plus className="h-4 w-4" />
            </IconButton>
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input className="pl-8" placeholder="Kontakte durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {isFetching && <Spinner className="h-4 w-4" />}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {noBooks ? (
            <EmptyState icon={<Users />} title="Kein Adressbuch verbunden">
              Verbinde ein Konto mit Kontakten in den{' '}
              <Link to="/settings/accounts" className="text-primary hover:underline">
                Kontoeinstellungen
              </Link>
              .
            </EmptyState>
          ) : isLoading ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-danger">{errorMessage(error)}</div>
          ) : contacts.length === 0 ? (
            <EmptyState icon={<Search />} title={debounced ? 'Keine Treffer' : 'Keine Kontakte'} />
          ) : (
            groups.map(([letter, list]) => (
              <div key={letter}>
                <div className="sticky top-0 z-10 border-b border-border bg-surface-2/95 px-4 py-1 text-xs font-semibold text-muted backdrop-blur">{letter}</div>
                {list.map((c) => {
                  const key = contactKey(c);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelected(key)}
                      className={cn(
                        'flex w-full items-center gap-3 border-b border-border/60 px-4 py-2 text-left hover:bg-hover',
                        selected === key && 'bg-primary-soft hover:bg-primary-soft',
                      )}
                    >
                      <Avatar name={c.displayName} email={c.emails[0]?.address} size={34} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.displayName || c.emails[0]?.address || '(ohne Namen)'}</span>
                        <span className="block truncate text-xs text-muted">{c.emails[0]?.address || c.company || c.phones[0]?.number || ''}</span>
                      </span>
                      {!book && <ColorDot color={sourceOf(c.accountId)?.color} className="h-2 w-2" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-1.5 text-xs text-muted">{contacts.length} Kontakte</div>
      </section>

      {/* Details */}
      <section className={cn('min-w-0 flex-1 overflow-auto bg-bg', isMobile && !current && 'hidden')}>
        {showDetail && (
          <div className="sticky top-0 z-10 flex h-10 items-center border-b border-border bg-surface px-2">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-hover hover:text-fg"
            >
              <ChevronLeft className="h-4 w-4" /> Kontakte
            </button>
          </div>
        )}
        {current ? (
          <ContactDetail
            contact={current}
            origin={sourceOf(current.accountId)}
            book={books.find((b) => b.accountId === current.accountId && b.id === current.addressBookId)}
            onEdit={() => setEditor({ contact: current })}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <EmptyState icon={<Users />} title="Kein Kontakt ausgewählt">
            Wähle links einen Kontakt aus oder lege einen neuen an.
          </EmptyState>
        )}
      </section>

      <SidebarSheet open={isMobile && navOpen} onClose={() => setNavOpen(false)}>
        {sidebarContent}
      </SidebarSheet>

      {editor && (
        <ContactEditor
          contact={editor.contact}
          addressBooks={books}
          defaultBook={book}
          accountMap={accountMap}
          onClose={() => setEditor(null)}
          onSaved={(c) => c.id && setSelected(contactKey(c))}
        />
      )}
    </div>
  );
}

function DetailRow({ icon, label, children }: { icon: ReactNode; label?: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <span className="mt-0.5 text-muted [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <div className="min-w-0 flex-1">
        {children}
        {label && <div className="text-xs text-muted">{label}</div>}
      </div>
    </div>
  );
}

interface Origin {
  name: string;
  color?: string;
}

function ContactDetail({
  contact: c,
  origin,
  book,
  onEdit,
  onDeleted,
}: {
  contact: Contact;
  origin?: Origin;
  book?: AddressBook;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const readOnly = !!book?.readOnly;
  const primaryEmail = c.emails[0]?.address;

  const remove = async () => {
    if (!(await confirm(`Kontakt „${c.displayName}“ wirklich löschen?`, { danger: true }))) return;
    setDeleting(true);
    try {
      await deleteContact(c.accountId, c.addressBookId, c.id);
      toast.success('Kontakt gelöscht');
      await qc.invalidateQueries({ queryKey: ['contacts'] });
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const birthday = c.birthday ? (() => {
    const d = new Date(c.birthday.length === 10 ? `${c.birthday}T00:00:00` : c.birthday);
    return Number.isNaN(d.getTime()) ? c.birthday : format(d, 'd. MMMM yyyy', { locale: de });
  })() : null;

  return (
    <div className="mx-auto max-w-2xl p-3 sm:p-6">
      <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6">
        <div className="flex items-start gap-4 sm:gap-5">
          {c.photoUrl ? (
            <img src={c.photoUrl} alt="" className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <Avatar name={c.displayName} email={primaryEmail} size={80} />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">{c.displayName || '(ohne Namen)'}</h1>
            {(c.jobTitle || c.company) && (
              <div className="mt-0.5 text-sm text-muted">{[c.jobTitle, [c.company, c.department].filter(Boolean).join(' · ')].filter(Boolean).join(', ')}</div>
            )}
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <ColorDot color={origin?.color} className="h-2 w-2" />
              {origin?.name}
              {book && <span>· {book.name}</span>}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Mail className="h-4 w-4" />}
            disabled={!primaryEmail}
            onClick={() => openCompose({ to: [{ name: c.displayName, address: primaryEmail! }] })}
          >
            E-Mail schreiben
          </Button>
          {!readOnly && (
            <Button icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
              Bearbeiten
            </Button>
          )}
          <Button icon={<Download className="h-4 w-4" />} onClick={() => downloadVCard(c)}>
            vCard
          </Button>
          {!readOnly && (
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} loading={deleting} onClick={remove}>
              Löschen
            </Button>
          )}
        </div>

        <div className="mt-6 divide-y divide-border border-t border-border">
          {c.emails.map((e, i) => (
            <DetailRow key={`e${i}`} icon={<Mail />} label={typeLabel(EMAIL_TYPES, e.type) || 'E-Mail'}>
              <button type="button" className="truncate text-primary hover:underline" onClick={() => openCompose({ to: [{ name: c.displayName, address: e.address }] })}>
                {e.address}
              </button>
            </DetailRow>
          ))}
          {c.phones.map((p, i) => (
            <DetailRow key={`p${i}`} icon={<Phone />} label={typeLabel(PHONE_TYPES, p.type) || 'Telefon'}>
              <a href={`tel:${p.number.replace(/\s+/g, '')}`} className="hover:underline">
                {p.number}
              </a>
            </DetailRow>
          ))}
          {(c.addresses ?? []).map((a, i) => {
            const lines = [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), [a.region, a.country].filter(Boolean).join(', ')].filter(Boolean);
            return (
              <DetailRow key={`a${i}`} icon={<MapPin />} label={typeLabel(ADDRESS_TYPES, a.type) || 'Adresse'}>
                <a
                  href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(lines.join(', '))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="whitespace-pre-line hover:underline"
                >
                  {lines.join('\n')}
                </a>
              </DetailRow>
            );
          })}
          {(c.company || c.jobTitle) && (
            <DetailRow icon={<Briefcase />} label="Organisation">
              {[c.company, c.department, c.jobTitle].filter(Boolean).join(' · ')}
            </DetailRow>
          )}
          {birthday && (
            <DetailRow icon={<Cake />} label="Geburtstag">
              {birthday}
            </DetailRow>
          )}
          {c.website && (
            <DetailRow icon={<Globe />} label="Webseite">
              <a href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
                {c.website}
              </a>
            </DetailRow>
          )}
          {c.notes && (
            <DetailRow icon={<StickyNote />} label="Notizen">
              <div className="whitespace-pre-wrap break-words">{c.notes}</div>
            </DetailRow>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}
