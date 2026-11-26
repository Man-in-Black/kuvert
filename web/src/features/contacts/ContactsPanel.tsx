/**
 * Kontakte als Panel der Seitenleiste rechts: Suche über alle Adressbücher, Liste und
 * Details (E-Mail schreiben, anrufen, bearbeiten) – dieselben Bausteine wie die Kontaktseite.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Maximize2, Plus, Search, Users } from 'lucide-react';
import type { Contact } from '@kuvert/shared';
import { Avatar, ColorDot, Input, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountMap } from '@/lib/queries';
import { useIsMobile } from '@/lib/useIsMobile';
import { closeSidePanel, isSidebarPinned } from '@/layout/side-panel-store';
import { useAddressBooks, useContactList } from './api';
import { ContactDetail, contactKey, letterOf, type Origin } from './ContactsPage';
import { ContactEditor } from './ContactEditor';

export default function ContactsPanel() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const accountMap = useAccountMap();
  const { data: booksData, isLoading: booksLoading } = useAddressBooks();
  const books = useMemo(() => booksData?.addressBooks ?? [], [booksData]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ contact?: Contact } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isFetching, error } = useContactList(null, debounced);
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

  const noBooks = !booksLoading && books.length === 0;
  const canCreate = books.some((b) => !b.readOnly);

  const openFull = () => {
    navigate('/contacts');
    if (mobile || !isSidebarPinned()) closeSidePanel();
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        {current ? (
          <HeaderButton label="Zurück zur Liste" onClick={() => setSelected(null)}>
            <ChevronLeft className="h-4 w-4" />
          </HeaderButton>
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Users className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{current ? current.displayName || '(ohne Namen)' : 'Kontakte'}</div>
        {isFetching && <Spinner className="h-4 w-4 shrink-0" />}
        <HeaderButton label="Neuer Kontakt" onClick={() => setEditor({})} disabled={!canCreate}>
          <Plus className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton label="In Kontakte öffnen" onClick={openFull}>
          <Maximize2 className="h-4 w-4" />
        </HeaderButton>
      </header>

      {current ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
          <ContactDetail
            compact
            contact={current}
            origin={sourceOf(current.accountId)}
            book={books.find((b) => b.accountId === current.accountId && b.id === current.addressBookId)}
            onEdit={() => setEditor({ contact: current })}
            onDeleted={() => setSelected(null)}
          />
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input className="pl-8" placeholder="Kontakte durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus={!mobile} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {noBooks ? (
              <p className="p-4 text-center text-sm text-muted">
                Kein Adressbuch verbunden.{' '}
                <Link to="/settings/accounts" className="text-primary hover:underline">
                  Konto verbinden
                </Link>
              </p>
            ) : isLoading ? (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            ) : error ? (
              <div className="p-4 text-sm text-danger">{errorMessage(error)}</div>
            ) : contacts.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted">{debounced ? 'Keine Treffer' : 'Keine Kontakte'}</p>
            ) : (
              groups.map(([letter, list]) => (
                <div key={letter}>
                  <div className="sticky top-0 z-10 border-b border-border bg-surface-2/95 px-3 py-0.5 text-xs font-semibold text-muted backdrop-blur">{letter}</div>
                  {list.map((c) => (
                    <button
                      key={contactKey(c)}
                      type="button"
                      onClick={() => setSelected(contactKey(c))}
                      className="flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-1.5 text-left hover:bg-hover"
                    >
                      <Avatar name={c.displayName} email={c.emails[0]?.address} size={30} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.displayName || c.emails[0]?.address || '(ohne Namen)'}</span>
                        <span className="block truncate text-xs text-muted">{c.emails[0]?.address || c.company || c.phones[0]?.number || ''}</span>
                      </span>
                      <ColorDot color={sourceOf(c.accountId)?.color} className="h-2 w-2" />
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          {contacts.length > 0 && <div className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted">{contacts.length} Kontakte</div>}
        </>
      )}

      {editor && (
        <ContactEditor
          contact={editor.contact}
          addressBooks={books}
          accountMap={accountMap}
          onClose={() => setEditor(null)}
          onSaved={(c) => c.id && setSelected(contactKey(c))}
        />
      )}
    </>
  );
}

function HeaderButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
