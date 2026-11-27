/**
 * Auswahldialog „Aus Paperless …“ im Editor: Dokumente per Volltext und Filtern suchen,
 * anhängen (Archiv-PDF oder Original) oder als Freigabelink einfügen.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Eye, FileText, Leaf, Link2, Paperclip, Search } from 'lucide-react';
import type { PaperlessDocument, PaperlessNamed, PaperlessShareLink, UploadInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Checkbox, EmptyState, IconButton, Input, Modal, Select, Skeleton } from '@/components/ui';
import type { AttachSourceDialogProps } from '@/features/mail/extension-types';
import { attachName, previewUrl, thumbUrl, usePaperlessConfig, usePaperlessMeta, usePaperlessSearch } from './api';
import { PaperlessSetup } from './PaperlessSettings';

const PAGE_SIZE = 25;

const formatDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return y && m && day ? `${day}.${m}.${y}` : d;
};

function Thumb({ id }: { id: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-2">
      {failed ? (
        <FileText className="h-5 w-5 text-muted" />
      ) : (
        <img src={thumbUrl(id)} alt="" loading="lazy" className="h-full w-full object-cover object-top" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  selected,
  onToggle,
  onPick,
  names,
}: {
  doc: PaperlessDocument;
  selected: boolean;
  onToggle: () => void;
  onPick: () => void;
  names: { correspondents: Map<number, PaperlessNamed>; types: Map<number, PaperlessNamed>; tags: Map<number, PaperlessNamed> };
}) {
  const meta = [formatDate(doc.created), doc.correspondent ? names.correspondents.get(doc.correspondent)?.name : null, doc.documentType ? names.types.get(doc.documentType)?.name : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onDoubleClick={onPick}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        'flex cursor-pointer items-start gap-3 border-b border-border px-4 py-2.5 outline-none hover:bg-hover focus-visible:bg-hover',
        selected && 'bg-primary-soft hover:bg-primary-soft',
      )}
    >
      {/* Eigener Klick auf die Checkbox darf nicht zusätzlich die Zeile umschalten */}
      <span className="mt-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onChange={onToggle} />
      </span>
      <Thumb id={doc.id} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={doc.title}>
          {doc.title}
        </div>
        {meta && <div className="truncate text-xs text-muted">{meta}</div>}
        {doc.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {doc.tags.slice(0, 6).map((t) => {
              const tag = names.tags.get(t);
              return tag ? (
                <Badge key={t} color={tag.color ?? undefined}>
                  {tag.name}
                </Badge>
              ) : null;
            })}
          </div>
        )}
        {doc.snippet && <p className="mt-1 line-clamp-2 text-xs text-muted">{doc.snippet}</p>}
      </div>
      <IconButton
        label="Vorschau in neuem Tab"
        size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          window.open(previewUrl(doc.id), '_blank', 'noopener');
        }}
      >
        <Eye className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

export function PaperlessPicker({ open, onClose, attach, insertLink }: AttachSourceDialogProps) {
  const { data: config } = usePaperlessConfig();
  const ready = open && !!config?.configured;
  const meta = usePaperlessMeta(ready);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [correspondent, setCorrespondent] = useState<number | undefined>();
  const [documentType, setDocumentType] = useState<number | undefined>();
  const [tag, setTag] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<number, PaperlessDocument>>(new Map());
  const [original, setOriginal] = useState(false);
  const [expiresDays, setExpiresDays] = useState<number | null>(30);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Bei neuer Suche zurück auf Seite 1
  useEffect(() => setPage(1), [debounced, correspondent, documentType, tag]);

  // Auswahl beim Öffnen zurücksetzen
  useEffect(() => {
    if (open) setSelected(new Map());
  }, [open]);

  const result = usePaperlessSearch({ q: debounced || undefined, correspondent, documentType, tag, page, pageSize: PAGE_SIZE }, ready);

  const names = useMemo(
    () => ({
      correspondents: new Map((meta.data?.correspondents ?? []).map((c) => [c.id, c])),
      types: new Map((meta.data?.documentTypes ?? []).map((c) => [c.id, c])),
      tags: new Map((meta.data?.tags ?? []).map((c) => [c.id, c])),
    }),
    [meta.data],
  );

  if (!open) return null;

  const toggle = (doc: PaperlessDocument) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(doc.id)) next.delete(doc.id);
      else next.set(doc.id, doc);
      return next;
    });

  const doAttach = (docs: PaperlessDocument[]) => {
    for (const doc of docs) {
      attach({ filename: attachName(doc, original), contentType: original ? doc.mimeType ?? undefined : 'application/pdf' }, () =>
        api<UploadInfo>(`/paperless/documents/${doc.id}/attach`, { method: 'POST', body: { original } }),
      );
    }
    onClose();
  };

  const doLink = async () => {
    setLinking(true);
    try {
      for (const doc of selected.values()) {
        const link = await api<PaperlessShareLink>(`/paperless/documents/${doc.id}/share`, { method: 'POST', body: { expiresDays, original } });
        insertLink(doc.title, link.url);
      }
      onClose();
    } catch (err) {
      toast.error(`Freigabelink fehlgeschlagen: ${errorMessage(err)}`);
    } finally {
      setLinking(false);
    }
  };

  const count = selected.size;
  const total = result.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filterSelect = (label: string, items: PaperlessNamed[] | undefined, value: number | undefined, set: (v: number | undefined) => void) => (
    <Select className="w-44" value={value ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)} aria-label={label}>
      <option value="">{label}: alle</option>
      {(items ?? []).map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </Select>
  );

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      title="Aus Paperless"
      className="h-[85vh]"
      footer={
        config?.configured ? (
          <>
            <div className="mr-auto flex flex-wrap items-center gap-x-4 gap-y-2">
              <Checkbox checked={original} onChange={setOriginal} label="Original statt Archiv-PDF" />
              <label className="flex items-center gap-2 text-sm text-muted">
                Link gültig
                <Select className="w-32" value={expiresDays ?? ''} onChange={(e) => setExpiresDays(e.target.value ? Number(e.target.value) : null)}>
                  <option value={7}>7 Tage</option>
                  <option value={30}>30 Tage</option>
                  <option value={90}>90 Tage</option>
                  <option value="">unbegrenzt</option>
                </Select>
              </label>
            </div>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button icon={<Link2 className="h-4 w-4" />} disabled={count === 0} loading={linking} onClick={() => void doLink()}>
              {count > 1 ? `${count} Links einfügen` : 'Link einfügen'}
            </Button>
            <Button variant="primary" icon={<Paperclip className="h-4 w-4" />} disabled={count === 0 || linking} onClick={() => doAttach([...selected.values()])}>
              {count > 1 ? `${count} anhängen` : 'Anhängen'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      {!config ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !config.configured ? (
        <PaperlessSetup />
      ) : (
        <div className="-m-5 flex h-[calc(100%+2.5rem)] flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input autoFocus className="pl-8" placeholder="Volltext durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {filterSelect('Korrespondent', meta.data?.correspondents, correspondent, setCorrespondent)}
            {filterSelect('Typ', meta.data?.documentTypes, documentType, setDocumentType)}
            {filterSelect('Tag', meta.data?.tags, tag, setTag)}
          </div>
          <div className={cn('min-h-0 flex-1 overflow-auto', result.isPlaceholderData && 'opacity-60')}>
            {result.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : result.error ? (
              <EmptyState icon={<Leaf />} title="Paperless nicht erreichbar">
                {errorMessage(result.error)}
              </EmptyState>
            ) : !result.data?.results.length ? (
              <EmptyState icon={<Search />} title="Keine Dokumente gefunden">
                {debounced ? 'Anderen Suchbegriff oder weniger Filter versuchen.' : 'In Paperless sind (noch) keine Dokumente sichtbar.'}
              </EmptyState>
            ) : (
              result.data.results.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} names={names} selected={selected.has(doc.id)} onToggle={() => toggle(doc)} onPick={() => doAttach([doc])} />
              ))
            )}
          </div>
          {total > 0 && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-4 text-xs text-muted">
              <span className="mr-auto">
                {total.toLocaleString('de-DE')} {total === 1 ? 'Dokument' : 'Dokumente'}
                {count > 0 && ` · ${count} ausgewählt`}
              </span>
              {pages > 1 && (
                <>
                  <IconButton label="Vorherige Seite" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </IconButton>
                  <span>
                    Seite {page} von {pages}
                  </span>
                  <IconButton label="Nächste Seite" size="icon-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                    <ChevronRight className="h-4 w-4" />
                  </IconButton>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
