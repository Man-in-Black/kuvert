import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Cloud,
  Copy,
  Download,
  ExternalLink,
  LayoutGrid,
  Link2,
  List,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Search,
  Share2,
  Upload,
} from 'lucide-react';
import type { StorageItem } from '@kuvert/shared';
import { Button, ColorDot, Dropdown, EmptyState, Field, IconButton, Input, Modal, Select, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccountsWith } from '@/lib/queries';
import { cn, escapeHtml } from '@/lib/utils';
import { openCompose } from '@/features/mail/compose-api';
import { attachItem, downloadUrl, shareItem, uploadToStorage } from './api';
import { Breadcrumbs, StorageItemList, useStorageNav } from './browser';

interface UploadProgress {
  id: number;
  name: string;
  pct: number;
  error?: string;
}

function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function FilesPage() {
  const qc = useQueryClient();
  const accounts = useAccountsWith('storage');
  const nav = useStorageNav(accounts, 'kuvert.files.account');
  const [view, setView] = useState<'list' | 'grid'>(() => (localStorage.getItem('kuvert.files.view') === 'grid' ? 'grid' : 'list'));
  const [selected, setSelected] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [shareFor, setShareFor] = useState<StorageItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSeq = useRef(0);

  const changeView = (v: 'list' | 'grid') => {
    setView(v);
    try {
      localStorage.setItem('kuvert.files.view', v);
    } catch {
      /* egal */
    }
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ['files', 'items', nav.accountId ?? ''] });

  const upload = async (files: File[]) => {
    if (!nav.accountId || !files.length) return;
    const accountId = nav.accountId;
    const folderId = nav.folderId;
    let ok = 0;
    await Promise.all(
      files.map(async (file) => {
        const id = ++uploadSeq.current;
        setUploads((u) => [...u, { id, name: file.name, pct: 0 }]);
        try {
          await uploadToStorage(accountId, folderId, file, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
          ok++;
          setUploads((u) => u.filter((x) => x.id !== id));
        } catch (err) {
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: errorMessage(err) } : x)));
          toast.error(`${file.name}: ${errorMessage(err)}`);
          setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 6000);
        }
      }),
    );
    if (ok) toast.success(ok === 1 && files.length === 1 ? `„${files[0]!.name}“ hochgeladen` : `${ok} Datei(en) hochgeladen`);
    void qc.invalidateQueries({ queryKey: ['files', 'items', accountId] });
  };

  const sendByMail = async (item: StorageItem) => {
    if (!nav.accountId) return;
    const t = toast.loading(`„${item.name}“ wird vorbereitet …`);
    try {
      const u = await attachItem(nav.accountId, item.id);
      openCompose({ attachments: [{ uploadId: u.id, filename: u.filename, contentType: u.contentType }] });
      toast.success('Als Anhang übernommen', { id: t });
    } catch (err) {
      toast.error(errorMessage(err), { id: t });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (nav.debouncedSearch) {
      toast.error('Hochladen ist während der Suche nicht möglich');
      return;
    }
    void upload(Array.from(e.dataTransfer.files));
  };

  if (accounts.length === 0) {
    return (
      <EmptyState icon={<Cloud />} title="Kein Cloud-Speicher verbunden">
        Verbinde OneDrive, Google Drive oder Nextcloud in den{' '}
        <Link to="/settings/accounts" className="text-primary hover:underline">
          Kontoeinstellungen
        </Link>
        .
      </EmptyState>
    );
  }

  const actions = (item: StorageItem) =>
    item.isFolder ? (
      item.webUrl ? (
        <IconButton label="Im Browser öffnen" size="icon-sm" onClick={() => window.open(item.webUrl, '_blank', 'noopener,noreferrer')}>
          <ExternalLink className="h-4 w-4" />
        </IconButton>
      ) : null
    ) : (
      <>
        <IconButton label="Herunterladen" size="icon-sm" onClick={() => triggerDownload(downloadUrl(nav.accountId!, item.id))}>
          <Download className="h-4 w-4" />
        </IconButton>
        <IconButton label="Per Mail senden" size="icon-sm" onClick={() => void sendByMail(item)}>
          <Mail className="h-4 w-4" />
        </IconButton>
        <Dropdown
          align="right"
          trigger={
            <IconButton label="Mehr" size="icon-sm">
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          }
          items={[
            { label: 'Freigabelink erstellen', icon: <Share2 />, onClick: () => setShareFor(item) },
            ...(item.webUrl ? [{ label: 'Im Browser öffnen', icon: <ExternalLink />, onClick: () => window.open(item.webUrl, '_blank', 'noopener,noreferrer') }] : []),
          ]}
        />
      </>
    );

  return (
    <div
      className="relative flex h-full flex-col bg-surface"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        {accounts.length > 1 ? (
          <Select className="w-56" value={nav.accountId} onChange={(e) => nav.setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium">
            <ColorDot color={nav.account?.color} />
            {nav.account?.name}
          </div>
        )}
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Dateien suchen" value={nav.search} onChange={(e) => nav.setSearch(e.target.value)} />
        </div>
        <div className="flex-1" />
        <div className="inline-flex rounded-md border border-border">
          <IconButton label="Liste" size="icon-sm" className={cn(view === 'list' && 'bg-hover')} onClick={() => changeView('list')}>
            <List className="h-4 w-4" />
          </IconButton>
          <IconButton label="Kacheln" size="icon-sm" className={cn(view === 'grid' && 'bg-hover')} onClick={() => changeView('grid')}>
            <LayoutGrid className="h-4 w-4" />
          </IconButton>
        </div>
        <IconButton label="Aktualisieren" size="icon-sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4" />
        </IconButton>
        <Button variant="primary" icon={<Upload className="h-4 w-4" />} onClick={() => fileInput.current?.click()} disabled={!!nav.debouncedSearch}>
          Hochladen
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void upload(files);
          }}
        />
      </header>

      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <Breadcrumbs crumbs={nav.crumbs} onGo={nav.goTo} searching={!!nav.debouncedSearch} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <StorageItemList
          accountId={nav.accountId}
          folderId={nav.folderId}
          search={nav.debouncedSearch}
          view={view}
          selectedIds={selected ? new Set([selected]) : undefined}
          onItemClick={(item) => (item.isFolder ? nav.open(item) : setSelected(item.id))}
          onItemDoubleClick={(item) => !item.isFolder && triggerDownload(downloadUrl(nav.accountId!, item.id))}
          renderActions={actions}
          emptyHint="Dateien hierher ziehen, um sie hochzuladen."
        />
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary-soft/80">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-10 w-10" />
            <span className="font-medium">Hier ablegen zum Hochladen nach „{nav.crumbs[nav.crumbs.length - 1]?.name}“</span>
          </div>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="absolute bottom-4 right-4 z-30 w-80 space-y-2 rounded-xl border border-border bg-surface p-3 shadow-xl">
          <div className="text-xs font-semibold text-muted">Uploads</div>
          {uploads.map((u) => (
            <div key={u.id} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                {!u.error && <Spinner className="h-3 w-3" />}
                <span className={cn('min-w-0 flex-1 truncate', u.error && 'text-danger')}>{u.name}</span>
                <span className="text-muted">{u.error ? 'Fehler' : `${u.pct}%`}</span>
              </div>
              <div className="h-1 overflow-hidden rounded bg-surface-2">
                <div className={cn('h-full transition-all', u.error ? 'bg-danger' : 'bg-primary')} style={{ width: `${u.error ? 100 : u.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {shareFor && nav.accountId && <ShareDialog accountId={nav.accountId} item={shareFor} onClose={() => setShareFor(null)} />}
    </div>
  );
}

function ShareDialog({ accountId, item, onClose }: { accountId: string; item: StorageItem; onClose: () => void }) {
  const [expires, setExpires] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const res = await shareItem(accountId, item.id, { expiresDays: expires ? Number(expires) : undefined, password: password || undefined });
      setLink(res.url);
      try {
        await navigator.clipboard.writeText(res.url);
        toast.success('Link erstellt und kopiert');
      } catch {
        toast.success('Link erstellt');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title={`Freigabe: ${item.name}`}
      footer={
        link ? (
          <>
            <Button
              icon={<Mail className="h-4 w-4" />}
              onClick={() => {
                openCompose({ html: `<p><a href="${escapeHtml(link)}">${escapeHtml(item.name)}</a></p>` });
                onClose();
              }}
            >
              Link per Mail senden
            </Button>
            <Button variant="primary" onClick={onClose}>
              Fertig
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon={<Link2 className="h-4 w-4" />} loading={busy} onClick={create}>
              Link erstellen
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-2">
          <div className="text-sm text-muted">Jeder mit diesem Link kann die Datei öffnen.</div>
          <div className="flex gap-2">
            <Input readOnly value={link} onFocus={(e) => e.target.select()} />
            <IconButton
              label="Kopieren"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => toast.success('Kopiert'));
              }}
            >
              <Copy className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Ablauf">
            <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="">Kein Ablaufdatum</option>
              <option value="1">1 Tag</option>
              <option value="7">7 Tage</option>
              <option value="30">30 Tage</option>
              <option value="90">90 Tage</option>
            </Select>
          </Field>
          <Field label="Passwort (optional)" hint="Nicht von allen Anbietern unterstützt (z. B. Nextcloud ja).">
            <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
