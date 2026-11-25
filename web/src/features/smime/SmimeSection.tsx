import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, FileKey2, KeyRound, Trash2, Upload, UserRound } from 'lucide-react';
import type { SmimeCertInfo } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, Field, IconButton, Input, Spinner, useConfirm } from '@/components/ui';
import { Card, HelpBox, SectionHeader, formatDate } from '@/features/settings/ui';

interface RecipientCert {
  email: string;
  subject: string;
  notAfter: string;
}

const DAY = 86_400_000;

function ValidityBadge({ notAfter }: { notAfter: string }) {
  const t = new Date(notAfter).getTime();
  if (Number.isNaN(t)) return null;
  if (t < Date.now()) return <Badge color="var(--k-danger)">Abgelaufen</Badge>;
  if (t - Date.now() < 30 * DAY) return <Badge color="var(--k-warning)">Läuft bald ab</Badge>;
  return <Badge color="var(--k-success)">Gültig</Badge>;
}

export function SmimeSection() {
  return (
    <div className="space-y-5">
      <SectionHeader
        title="S/MIME"
        description="Signieren und Verschlüsseln von E-Mails mit X.509-Zertifikaten. Dein privater Schlüssel wird verschlüsselt auf dem Server gespeichert."
      />
      <OwnCertificates />
      <RecipientCertificates />
    </div>
  );
}

function OwnCertificates() {
  const qc = useQueryClient();
  const { data: certs = [], isLoading } = useQuery({ queryKey: ['smime', 'certs'], queryFn: () => api<SmimeCertInfo[]>('/smime/certs') });
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('password', password);
      fd.append('file', file, file.name);
      const info = await api<SmimeCertInfo>('/smime/certs', { method: 'POST', body: fd });
      toast.success(`Zertifikat für ${info.email} importiert`);
      setFile(null);
      setPassword('');
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['smime'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: SmimeCertInfo) => {
    if (!(await confirm(<>Zertifikat für <strong>{c.email}</strong> inklusive privatem Schlüssel löschen? Verschlüsselte Nachrichten an dieses Zertifikat können danach nicht mehr gelesen werden.</>, { danger: true })))
      return;
    try {
      await api(`/smime/certs/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['smime'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> Eigene Zertifikate
        </span>
      }
      description="Zum Signieren ausgehender und Entschlüsseln eingehender Nachrichten (PKCS#12-Datei: .p12 / .pfx)."
    >
      {isLoading && <Spinner />}
      {!isLoading && certs.length === 0 && <p className="mb-4 text-sm text-muted">Noch kein eigenes Zertifikat importiert.</p>}
      <div className="mb-5 space-y-2">
        {certs.map((c) => (
          <div key={c.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
            <BadgeCheck className={cn('mt-0.5 h-5 w-5 shrink-0', new Date(c.notAfter).getTime() < Date.now() ? 'text-danger' : 'text-success')} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {c.email}
                <ValidityBadge notAfter={c.notAfter} />
                {!c.hasPrivateKey && <Badge color="var(--k-warning)">Ohne privaten Schlüssel</Badge>}
              </div>
              <div className="truncate text-xs text-muted" title={c.subject}>
                {c.subject}
              </div>
              <div className="truncate text-xs text-muted" title={c.issuer}>
                Aussteller: {c.issuer}
              </div>
              <div className="text-xs text-muted">
                Gültig {formatDate(c.notBefore)} – {formatDate(c.notAfter)}
              </div>
              <div className="mt-0.5 break-all font-mono text-[10px] text-muted">{c.fingerprint}</div>
            </div>
            <IconButton label="Löschen" size="icon-sm" onClick={() => remove(c)} className="hover:text-danger">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        ))}
      </div>

      <form onSubmit={upload} className="grid grid-cols-1 items-end gap-3 rounded-lg bg-surface-2 p-4 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Zertifikatsdatei (.p12 / .pfx)">
          <input
            ref={fileRef}
            type="file"
            accept=".p12,.pfx,application/x-pkcs12"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-fg hover:file:bg-hover"
            required
          />
        </Field>
        <Field label="Passwort der Datei">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!file} icon={<Upload className="h-4 w-4" />}>
          Importieren
        </Button>
      </form>
      {dialog}
    </Card>
  );
}

function RecipientCertificates() {
  const qc = useQueryClient();
  const { data: contacts = [], isLoading } = useQuery({ queryKey: ['smime', 'contacts'], queryFn: () => api<RecipientCert[]>('/smime/contacts') });
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await api<RecipientCert>('/smime/contacts', { method: 'POST', body: fd });
      toast.success(`Zertifikat für ${r?.email ?? 'Empfänger'} gespeichert`);
      qc.invalidateQueries({ queryKey: ['smime', 'contacts'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (email: string) => {
    try {
      await api(`/smime/contacts/${encodeURIComponent(email)}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['smime', 'contacts'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const list = contacts.filter((c) => !filter || c.email.toLowerCase().includes(filter.toLowerCase()) || c.subject.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-primary" /> Zertifikate von Empfängern
        </span>
      }
      description="Öffentliche Zertifikate, mit denen Nachrichten an diese Empfänger verschlüsselt werden können."
      actions={
        <>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".pem,.cer,.crt,.der,application/x-x509-ca-cert,application/pkix-cert"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={busy} onClick={() => fileRef.current?.click()}>
            Zertifikat hinzufügen
          </Button>
        </>
      }
    >
      <div className="mb-3">
        <HelpBox>
          Sobald du eine signierte Nachricht erhältst, speichert Kuvert das Zertifikat des Absenders automatisch. Danach kannst du diesem Absender
          verschlüsselt antworten. Alternativ lassen sich Zertifikate (.pem, .cer, .crt) hier manuell importieren.
        </HelpBox>
      </div>
      {contacts.length > 8 && <Input className="mb-3" placeholder="Filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {isLoading && <Spinner />}
      {!isLoading && contacts.length === 0 && <EmptyState icon={<FileKey2 />} title="Noch keine Empfängerzertifikate" />}
      <div className="divide-y divide-border">
        {list.map((c) => {
          const expired = new Date(c.notAfter).getTime() < Date.now();
          return (
            <div key={c.email} className="flex items-center gap-3 py-2">
              {expired ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger" /> : <BadgeCheck className="h-4 w-4 shrink-0 text-success" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.email}</div>
                <div className="truncate text-xs text-muted" title={c.subject}>
                  {c.subject} · bis {formatDate(c.notAfter)}
                </div>
              </div>
              <ValidityBadge notAfter={c.notAfter} />
              <IconButton label="Entfernen" size="icon-sm" onClick={() => remove(c.email)} className="hover:text-danger">
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
