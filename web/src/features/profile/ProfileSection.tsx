import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Camera, Download, Mail, Trash2, UserRound } from 'lucide-react';
import type { ProfileInfo, User, UserProfile } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Avatar, Badge, Button, Card, Field, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui';
import { absoluteTime, relativeTime } from './format';

export const profileKey = ['profile'] as const;

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  }
}

export function ProfileSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: profileKey, queryFn: () => api<ProfileInfo>('/profile') });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [profile, setProfile] = useState<UserProfile>({});
  const tzList = useMemo(timezones, []);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.user.name);
    setEmail(data.user.email);
    setProfile(data.profile);
    setCurrentPassword('');
  }, [data]);

  const emailChanged = !!data && email.trim().toLowerCase() !== data.user.email.toLowerCase();
  const dirty =
    !!data && (name !== data.user.name || emailChanged || JSON.stringify(profile) !== JSON.stringify(data.profile));

  const save = useMutation({
    mutationFn: () =>
      api<ProfileInfo>('/profile', {
        method: 'PUT',
        body: { name, email: emailChanged ? email.trim() : undefined, currentPassword: emailChanged ? currentPassword : undefined, profile },
      }),
    onSuccess: (res) => {
      qc.setQueryData(profileKey, res);
      qc.invalidateQueries({ queryKey: qk.app });
      toast.success('Profil gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const avatar = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api<{ user: User }>('/profile/avatar', { method: 'DELETE' });
      const fd = new FormData();
      fd.append('file', file, file.name);
      return api<{ user: User }>('/profile/avatar', { method: 'POST', body: fd });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileKey });
      qc.invalidateQueries({ queryKey: qk.app });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const set = (k: keyof UserProfile) => (v: string) => setProfile((p) => ({ ...p, [k]: v || undefined }));

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<UserRound />}
        title="Profil"
        description="Deine persönlichen Angaben in Kuvert. Sie werden u. a. für Signatur-Platzhalter und die Anzeige im Team genutzt."
        actions={
          <Button icon={<Download className="h-4 w-4" />} onClick={() => (window.location.href = '/api/profile/export')}>
            Meine Daten exportieren
          </Button>
        }
      />

      {/* Kopf mit Avatar */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        <div className="brand-gradient h-24 opacity-90" />
        <div className="flex flex-col gap-4 px-6 pb-5 sm:flex-row sm:items-end">
          <div className="relative -mt-12 w-fit">
            <div className="rounded-full bg-surface p-1 shadow-card">
              <Avatar name={data.user.name} email={data.user.email} src={data.user.avatarUrl} size={88} />
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="absolute bottom-1 right-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface bg-primary text-primary-fg shadow-card transition-transform hover:scale-105"
              title="Profilbild ändern"
            >
              <Camera className="h-4 w-4" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 1024 * 1024) return toast.error('Bild ist größer als 1 MB');
                avatar.mutate(f);
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{data.user.name}</h2>
              {data.user.isAdmin && <Badge tone="primary">Administrator</Badge>}
              {data.user.twoFactorEnabled && <Badge tone="success">2FA aktiv</Badge>}
            </div>
            <div className="mt-0.5 text-sm text-muted">{data.user.email}</div>
            <div className="mt-1 text-xs text-subtle">
              Mitglied seit {absoluteTime(data.createdAt)} · letzte Anmeldung {relativeTime(data.lastLoginAt)}
            </div>
          </div>
          {data.user.avatarUrl && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => avatar.mutate(null)} loading={avatar.isPending}>
              Bild entfernen
            </Button>
          )}
        </div>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-5"
      >
        <Card title="Kontaktdaten" icon={<Mail />} description="Name und Anmelde-E-Mail für Kuvert.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="E-Mail (Anmeldung)" hint={emailChanged ? 'Zum Ändern bitte aktuelles Passwort angeben' : undefined}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            {emailChanged && (
              <Field label="Aktuelles Passwort" className="sm:col-span-2 sm:max-w-sm">
                <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
              </Field>
            )}
            <Field label="Telefon">
              <Input value={profile.phone ?? ''} onChange={(e) => set('phone')(e.target.value)} placeholder="+49 …" />
            </Field>
            <Field label="Mobil">
              <Input value={profile.mobile ?? ''} onChange={(e) => set('mobile')(e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Organisation" icon={<Building2 />}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Firma">
              <Input value={profile.company ?? ''} onChange={(e) => set('company')(e.target.value)} />
            </Field>
            <Field label="Abteilung">
              <Input value={profile.department ?? ''} onChange={(e) => set('department')(e.target.value)} />
            </Field>
            <Field label="Position">
              <Input value={profile.jobTitle ?? ''} onChange={(e) => set('jobTitle')(e.target.value)} />
            </Field>
            <Field label="Zeitzone">
              <Select value={profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(e) => set('timezone')(e.target.value)}>
                {tzList.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Über mich" className="sm:col-span-2">
              <Textarea value={profile.bio ?? ''} onChange={(e) => set('bio')(e.target.value)} rows={3} placeholder="Kurze Beschreibung (optional)" />
            </Field>
          </div>
        </Card>

        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 rounded-xl bg-bg/80 px-1 py-3 backdrop-blur">
          {dirty && <span className="text-xs text-muted">Ungespeicherte Änderungen</span>}
          <Button
            disabled={!dirty}
            onClick={() => {
              if (!data) return;
              setName(data.user.name);
              setEmail(data.user.email);
              setProfile(data.profile);
            }}
          >
            Verwerfen
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            Speichern
          </Button>
        </div>
      </form>
    </div>
  );
}
