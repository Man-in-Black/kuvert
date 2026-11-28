/**
 * Bereich „Paperless“: Dokumente durchsuchen (Volltext, Korrespondent, Typ, Tag, Sortierung),
 * ansehen (PDF-Vorschau, erkannter Text) und direkt per Mail versenden – als Anhang oder Freigabelink.
 * Zustand steckt in der URL: /paperless?q=Rechnung&corr=5&type=2&tag=8&sort=created-asc&page=2&id=42
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Leaf, Link2, Mail, Paperclip, Search, SlidersHorizontal, X } from 'lucide-react';
import type { PaperlessDocumentDetail, PaperlessShareLink, PaperlessSort, UploadInfo } from '@kuvert/shared';
import { api, apiUrl, errorMessage } from '@/lib/api';
import { cn, escapeHtml } from '@/lib/utils';
import { Button, Card, Dropdown, EmptyState, IconButton, Input, Select, Skeleton, Tabs } from '@/components/ui';
import { openCompose } from '@/features/mail/compose-api';
import { documentLink, previewUrl, usePaperlessConfig, usePaperlessMeta, usePaperlessSearch, usePaperlessStatus } from './api';
import { DocumentRow, formatDate, TagBadges, usePaperlessNames, type PaperlessNames } from './components';
import { PaperlessSetup } from './PaperlessSettings';

const PAGE_SIZE = 25;

const SORTS: { value: PaperlessSort | ''; label: string }[] = [
  { value: '', label: 'Neueste zuerst' },
  { value: 'created-desc', label: 'Neueste zuerst' },
  { value: 'created-asc', label: 'Älteste zuerst' },
  { value: 'added-desc', label: 'Zuletzt hinzugefügt' },
  { value: 'title-asc', label: 'Titel A–Z' },
];

export function PaperlessPage() {
  const { data: config, isLoading } = usePaperlessConfig();
  if (isLoading) {
    return (
      <div className="p-8">
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!config?.enabled) {
    return <EmptyState icon={<Leaf />} title="Paperless nicht aktiviert">Die Anbindung an Paperless-ngx wurde vom Administrator deaktiviert.</EmptyState>;
  }
  if (!config.configured) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-6">
        <Card className="w-full max-w-lg animate-scale-in" bodyClassName="p-7">
          <PaperlessSetup />
        </Card>
      </div>
    );
  }
  return <PaperlessBrowser baseUrl={config.baseUrl} />;
}

/* ───────────────────────────── Browser ───────────────────────────── */

function PaperlessBrowser({ baseUrl }: { baseUrl: string | null }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const num = (k: string) => (params.get(k) && /^\d+$/.test(params.get(k)!) ? Number(params.get(k)) : undefined);
  const correspondent = num('corr');
  const documentType = num('type');
  const tag = num('tag');
  const sort = (SORTS.some((s) => s.value === params.get('sort')) ? params.get('sort') : '') as PaperlessSort | '';
  const page = Math.max(1, num('page') ?? 1);
  const selected = num('id');
  const [showFilters, setShowFilters] = useState(false);

  const set = (patch: Record<string, string | number | undefined | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => set({ q: input.trim() || undefined }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const { data: status } = usePaperlessStatus(true);
  const meta = usePaperlessMeta(true);
  const names = usePaperlessNames(meta.data);
  const search = usePaperlessSearch({ q: q || undefined, sort: sort || undefined, correspondent, documentType, tag, page, pageSize: PAGE_SIZE }, true);
  const total = search.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIdx = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const endIdx = Math.min(page * PAGE_SIZE, total);
  const activeFilters = [correspondent, documentType, tag, sort || undefined].filter(Boolean).length;

  const filterSelect = (label: string, key: string, value: number | undefined, items: { id: number; name: string; documentCount?: number | null }[] | undefined) => (
    <section>
      <SectionLabel>{label}</SectionLabel>
      <div className="px-1">
        <Select value={value ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined })}>
          <option value="">Alle</option>
          {(items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.documentCount != null ? ` (${i.documentCount})` : ''}
            </option>
          ))}
        </Select>
      </div>
    </section>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* ── Filter ── */}
      <aside
        className={cn(
          'w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar',
          showFilters ? 'fixed inset-y-0 left-0 z-40 flex shadow-pop lg:static lg:shadow-none' : selected ? 'hidden 2xl:flex' : 'hidden lg:flex',
        )}
      >
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Leaf className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold tracking-tight">Paperless</div>
            <div className="text-xs text-muted">{status ? `${status.documents.toLocaleString('de-DE')} Dokumente` : 'Paperless-ngx'}</div>
          </div>
          {showFilters && (
            <IconButton label="Schließen" size="icon-sm" onClick={() => setShowFilters(false)}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>

        <div className="space-y-5 px-3 pb-6">
          {meta.error && <p className="px-2.5 text-xs text-danger">{errorMessage(meta.error)}</p>}
          {filterSelect('Korrespondent', 'corr', correspondent, meta.data?.correspondents)}
          {filterSelect('Dokumenttyp', 'type', documentType, meta.data?.documentTypes)}
          {filterSelect('Tag', 'tag', tag, meta.data?.tags)}
          <section>
            <SectionLabel>Sortierung</SectionLabel>
            <div className="px-1">
              <Select value={sort} onChange={(e) => set({ sort: e.target.value || undefined })}>
                {/* Ohne Auswahl: bei Suche nach Relevanz, sonst neueste zuerst */}
                {SORTS.filter((s) => (q ? true : s.value !== 'created-desc')).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.value === '' && q ? 'Relevanz' : s.label}
                  </option>
                ))}
              </Select>
            </div>
          </section>
          {activeFilters > 0 && (
            <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => set({ corr: undefined, type: undefined, tag: undefined, sort: undefined })}>
              Filter zurücksetzen
            </Button>
          )}
          {baseUrl && (
            <a href={baseUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 text-xs text-muted hover:text-fg">
              <ExternalLink className="h-3.5 w-3.5" /> Paperless öffnen
            </a>
          )}
        </div>
      </aside>
      {showFilters && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setShowFilters(false)} />}

      {/* ── Trefferliste ── */}
      <section className={cn('flex min-w-0 flex-col', selected ? 'hidden w-[400px] shrink-0 lg:flex' : 'flex-1')}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-3">
          <IconButton label="Filter" variant="outline" className={cn('relative', selected ? '2xl:hidden' : 'lg:hidden')} onClick={() => setShowFilters(true)}>
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilters > 0 && <span className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-fg">{activeFilters}</span>}
          </IconButton>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <Input
              className="h-10 pl-9 pr-9"
              placeholder="Dokumente durchsuchen (Volltext)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && set({ q: input.trim() || undefined })}
            />
            {input && (
              <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg" onClick={() => setInput('')} aria-label="Leeren">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center px-4 pt-3 text-xs text-muted">
          <span className="ml-auto tabular-nums">{search.isFetching ? 'Suche …' : total ? `${startIdx}–${endIdx} von ${total.toLocaleString('de-DE')}` : ''}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {search.isLoading ? (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : search.error ? (
            <EmptyState icon={<Leaf />} title="Suche fehlgeschlagen">
              {errorMessage(search.error)}
            </EmptyState>
          ) : !search.data?.results.length ? (
            <EmptyState icon={<Search />} title="Keine Dokumente gefunden">
              Passe Suchbegriff oder Filter an.
            </EmptyState>
          ) : (
            <div className={cn('space-y-0.5 transition-opacity', search.isPlaceholderData && 'opacity-60')}>
              {search.data.results.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} names={names} selected={selected === doc.id} onSelect={() => set({ id: doc.id }, false)} />
              ))}
            </div>
          )}
        </div>

        {pages > 1 && (
          <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2.5">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} disabled={page <= 1} onClick={() => set({ page: page - 1 }, false)}>
              Zurück
            </Button>
            <span className="text-xs tabular-nums text-muted">
              Seite {page} von {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => set({ page: page + 1 }, false)}>
              Weiter <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </section>

      {/* ── Detail ── */}
      {selected ? (
        <section className="min-w-0 flex-1 border-l border-border bg-surface animate-slide-in-right">
          <DocumentView key={selected} id={selected} names={names} baseUrl={baseUrl} onClose={() => set({ id: undefined }, false)} />
        </section>
      ) : (
        <section className="hidden min-w-0 flex-1 items-center justify-center border-l border-border bg-surface-2/30 2xl:flex">
          <EmptyState icon={<Leaf />} title="Dokument auswählen">
            Vorschau, erkannter Text und Versand per Mail – als Anhang oder Freigabelink.
            <div className="mt-3 text-xs">
              Token verwalten unter{' '}
              <Link className="text-primary hover:underline" to="/settings/paperless">
                Einstellungen → Paperless
              </Link>
            </div>
          </EmptyState>
        </section>
      )}
    </div>
  );
}

/* ───────────────────────────── Detailansicht ───────────────────────────── */

function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

function DocumentView({ id, names, baseUrl, onClose }: { id: number; names: PaperlessNames; baseUrl: string | null; onClose: () => void }) {
  const doc = useQuery({
    queryKey: ['paperless', 'document', id],
    queryFn: () => api<PaperlessDocumentDetail>(`/paperless/documents/${id}`),
    retry: false,
  });
  const [tab, setTab] = useState<'preview' | 'text'>('preview');
  const [busy, setBusy] = useState(false);

  if (doc.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-[60vh] w-full rounded-xl" />
      </div>
    );
  }
  if (doc.error || !doc.data) {
    return (
      <div className="p-6">
        <IconButton label="Schließen" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <EmptyState icon={<Leaf />} title="Dokument nicht verfügbar">
          {errorMessage(doc.error)}
        </EmptyState>
      </div>
    );
  }
  const d = doc.data;
  const hasArchive = !!d.archivedFileName;
  const isPdfOriginal = (d.mimeType ?? '').toLowerCase() === 'application/pdf';

  /** Neue Mail mit dem Dokument als Anhang */
  const mailAttachment = async (original: boolean) => {
    setBusy(true);
    try {
      const up = await api<UploadInfo>(`/paperless/documents/${d.id}/attach`, { method: 'POST', body: { original } });
      openCompose({ subject: d.title, attachments: [{ uploadId: up.id, filename: up.filename, contentType: up.contentType }] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Neue Mail mit Freigabelink */
  const mailLink = async (expiresDays: number | null) => {
    setBusy(true);
    try {
      const link = await api<PaperlessShareLink>(`/paperless/documents/${d.id}/share`, { method: 'POST', body: { expiresDays } });
      const until = link.expires ? ` (gültig bis ${formatDate(link.expires)})` : '';
      openCompose({ subject: d.title, html: `<p></p><p>📎 <a href="${escapeHtml(link.url)}">${escapeHtml(d.title)}</a>${escapeHtml(until)}</p>` });
    } catch (err) {
      toast.error(`Freigabelink fehlgeschlagen: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const facts: [string, React.ReactNode][] = [
    ['Ausgestellt', formatDate(d.created) || '–'],
    ['Korrespondent', d.correspondent ? (names.correspondents.get(d.correspondent)?.name ?? `#${d.correspondent}`) : '–'],
    ['Dokumenttyp', d.documentType ? (names.types.get(d.documentType)?.name ?? `#${d.documentType}`) : '–'],
    ['Hinzugefügt', formatDate(d.added) || '–'],
    ...(d.archiveSerialNumber != null ? ([['ASN', d.archiveSerialNumber]] as [string, React.ReactNode][]) : []),
    ...(d.pageCount ? ([['Seiten', d.pageCount]] as [string, React.ReactNode][]) : []),
    ['Original', d.originalFileName ?? '–'],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
        <IconButton label="Schließen" size="icon-sm" className="mt-0.5" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-tight" title={d.title}>
            {d.title}
          </h2>
          {d.tags.length > 0 && (
            <div className="mt-1.5">
              <TagBadges ids={d.tags} names={names} max={20} />
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <Dropdown
          trigger={
            <Button variant="primary" size="sm" icon={<Mail className="h-4 w-4" />} loading={busy}>
              Per Mail senden <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          }
          items={[
            { label: hasArchive ? 'Als PDF anhängen' : 'Als Anhang', icon: <Paperclip />, onClick: () => void mailAttachment(false) },
            ...(hasArchive && !isPdfOriginal ? [{ label: 'Original anhängen', icon: <FileText />, onClick: () => void mailAttachment(true) }] : []),
            { divider: true, label: '' },
            { label: 'Link senden (7 Tage gültig)', icon: <Link2 />, onClick: () => void mailLink(7) },
            { label: 'Link senden (30 Tage gültig)', icon: <Link2 />, onClick: () => void mailLink(30) },
            { label: 'Link senden (unbegrenzt)', icon: <Link2 />, onClick: () => void mailLink(null) },
          ]}
        />
        <Dropdown
          trigger={
            <Button size="sm" icon={<Download className="h-4 w-4" />}>
              Herunterladen <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          }
          items={[
            { label: hasArchive ? 'Archiv-PDF' : 'Datei', icon: <Download />, onClick: () => triggerDownload(apiUrl(`/paperless/documents/${d.id}/download`)) },
            ...(hasArchive ? [{ label: 'Original', icon: <FileText />, onClick: () => triggerDownload(apiUrl(`/paperless/documents/${d.id}/download`, { original: 1 })) }] : []),
          ]}
        />
        {baseUrl && (
          <a
            href={documentLink(baseUrl, d.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-hover hover:text-fg"
          >
            <ExternalLink className="h-4 w-4" /> In Paperless öffnen
          </a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-5 py-4 text-sm sm:grid-cols-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-subtle">{k}</dt>
              <dd className="truncate" title={typeof v === 'string' ? v : undefined}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        <div className="px-5">
          <Tabs<'preview' | 'text'>
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'preview', label: 'Vorschau' },
              { value: 'text', label: 'Erkannter Text' },
            ]}
          />
        </div>
        <div className="p-5">
          {tab === 'preview' ? (
            hasArchive || isPdfOriginal ? (
              <object data={previewUrl(d.id)} type="application/pdf" className="h-[75vh] w-full rounded-lg border border-border">
                <p className="p-4 text-sm text-muted">
                  Der Browser kann das PDF nicht anzeigen –{' '}
                  <a className="text-primary hover:underline" href={previewUrl(d.id)} target="_blank" rel="noopener noreferrer">
                    in neuem Tab öffnen
                  </a>
                  .
                </p>
              </object>
            ) : (
              <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted">
                <img src={apiUrl(`/paperless/documents/${d.id}/thumb`)} alt="" className="max-h-96 rounded-lg border border-border" />
                Für dieses Dokument gibt es keine PDF-Fassung – über „Herunterladen“ das Original laden.
              </div>
            )
          ) : d.content ? (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-4 font-sans text-sm leading-relaxed">{d.content}</pre>
          ) : (
            <p className="text-sm text-muted">Kein erkannter Text vorhanden.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{children}</div>;
}
