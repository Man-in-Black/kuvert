/** Gemeinsame Bausteine für Paperless-Seite und Auswahldialog im Editor. */
import { useMemo, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import type { PaperlessDocument, PaperlessMeta, PaperlessNamed } from '@kuvert/shared';
import { cn } from '@/lib/utils';
import { Badge, Checkbox, IconButton } from '@/components/ui';
import { previewUrl, thumbUrl } from './api';

export const formatDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${day}.${m}.${y}` : d;
};

export interface PaperlessNames {
  correspondents: Map<number, PaperlessNamed>;
  types: Map<number, PaperlessNamed>;
  tags: Map<number, PaperlessNamed>;
}

/** IDs von Korrespondenten, Dokumenttypen und Tags in Namen auflösen */
export function usePaperlessNames(meta: PaperlessMeta | undefined): PaperlessNames {
  return useMemo(
    () => ({
      correspondents: new Map((meta?.correspondents ?? []).map((c) => [c.id, c])),
      types: new Map((meta?.documentTypes ?? []).map((c) => [c.id, c])),
      tags: new Map((meta?.tags ?? []).map((c) => [c.id, c])),
    }),
    [meta],
  );
}

export function Thumb({ id, className }: { id: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-2', className)}>
      {failed ? (
        <FileText className="h-5 w-5 text-muted" />
      ) : (
        <img src={thumbUrl(id)} alt="" loading="lazy" className="h-full w-full object-cover object-top" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

export function TagBadges({ ids, names, max = 6 }: { ids: number[]; names: PaperlessNames; max?: number }) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.slice(0, max).map((t) => {
        const tag = names.tags.get(t);
        return tag ? (
          <Badge key={t} color={tag.color ?? undefined}>
            {tag.name}
          </Badge>
        ) : null;
      })}
    </div>
  );
}

/**
 * Eine Zeile der Trefferliste. Mit `checkable` (Auswahldialog) mit Checkbox und Vorschau-Knopf,
 * sonst (Paperless-Seite) als einfacher Listeneintrag mit Hervorhebung.
 */
export function DocumentRow({
  doc,
  names,
  selected,
  onSelect,
  onPick,
  checkable,
}: {
  doc: PaperlessDocument;
  names: PaperlessNames;
  selected: boolean;
  onSelect: () => void;
  onPick?: () => void;
  checkable?: boolean;
}) {
  const meta = [formatDate(doc.created), doc.correspondent ? names.correspondents.get(doc.correspondent)?.name : null, doc.documentType ? names.types.get(doc.documentType)?.name : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onPick}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'flex cursor-pointer items-start gap-3 outline-none transition-colors focus-visible:bg-hover',
        checkable ? 'border-b border-border px-4 py-2.5' : 'rounded-xl px-3 py-2.5',
        selected ? 'bg-primary-soft' : 'hover:bg-hover',
      )}
    >
      {checkable && (
        // Eigener Klick auf die Checkbox darf nicht zusätzlich die Zeile umschalten
        <span className="mt-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={onSelect} />
        </span>
      )}
      <Thumb id={doc.id} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={doc.title}>
          {doc.title}
        </div>
        {meta && <div className="truncate text-xs text-muted">{meta}</div>}
        {doc.tags.length > 0 && (
          <div className="mt-1">
            <TagBadges ids={doc.tags} names={names} />
          </div>
        )}
        {doc.snippet && <p className="mt-1 line-clamp-2 text-xs text-muted">{doc.snippet}</p>}
      </div>
      {checkable && (
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
      )}
    </div>
  );
}
