/**
 * Seiten für Einladungslinks /join/<token>:
 *  - GuestJoinPage: ohne Anmeldung. Name eingeben, anklopfen, im Wartebereich warten, bis jemand aus
 *    Kuvert zulässt – dann dasselbe Anruf-Fenster wie in Kuvert (ohne Chat und ohne Einladen).
 *  - MemberJoinPage: angemeldet. Direkt als Kuvert-Benutzer beitreten (z. B. Meeting aus dem Kalender).
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast, Toaster } from 'sonner';
import { Clock, Video } from 'lucide-react';
import type { MeetKnockResult, MeetLinkInfo, MeetLobbyStatus } from '@kuvert/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { Button, Checkbox, Field, Input, Spinner } from '@/components/ui';
import { BrandMark } from '@/pages/AuthLayout';
import { LoginPage } from '@/pages/Login';
import { joinByLink, startCall, useActiveCall } from './store';

const CallRoom = lazy(() => import('./CallRoom'));

const NAME_KEY = 'kuvert.guestName';

function useLinkInfo(token: string) {
  return useQuery({
    queryKey: ['meet', 'link', token],
    queryFn: () => api<MeetLinkInfo>(`/meet/links/${encodeURIComponent(token)}`),
    retry: false,
    refetchInterval: (q) => (q.state.data && !q.state.data.active ? 15_000 : false),
  });
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="auth-backdrop flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-lg font-semibold tracking-tight">Kuvert</span>
        </div>
        <div className="rounded-2xl border border-border/80 bg-surface/90 p-6 shadow-pop backdrop-blur-xl sm:p-7">{children}</div>
      </div>
    </div>
  );
}

function LinkHeader({ info }: { info: MeetLinkInfo }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Video className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">{info.title || 'Kuvert-Anruf'}</h1>
        <p className="text-sm text-muted">
          {info.kind === 'meeting' ? 'Meeting von' : 'Anruf von'} {info.host}
          {info.kind === 'meeting' && !info.active && ' · noch niemand da'}
        </p>
      </div>
    </div>
  );
}

function LinkError({ error }: { error: unknown }) {
  const gone = error instanceof ApiError && (error.status === 404 || error.status === 410);
  return (
    <Card>
      <h1 className="text-lg font-semibold">{gone ? 'Link ungültig' : 'Anruf nicht verfügbar'}</h1>
      <p className="mt-2 text-sm text-muted">
        {gone ? 'Der Link ist abgelaufen, wurde widerrufen oder ist falsch. Bitte um einen neuen Link.' : errorMessage(error)}
      </p>
    </Card>
  );
}

/* ───────────────────────────── Gäste ───────────────────────────── */

type GuestPhase =
  | { kind: 'form' }
  | { kind: 'waiting'; req: MeetKnockResult }
  | { kind: 'in-call' }
  | { kind: 'left'; ended: boolean }
  | { kind: 'denied' };

export default function GuestJoinPage({ token }: { token: string }) {
  const { data: info, error, isLoading } = useLinkInfo(token);
  const [showLogin, setShowLogin] = useState(false);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [video, setVideo] = useState(false);
  const [phase, setPhase] = useState<GuestPhase>({ kind: 'form' });
  const [sending, setSending] = useState(false);
  const call = useActiveCall();
  const wasInCall = useRef(false);

  // Anruf verlassen bzw. beendet → Abschlussseite
  useEffect(() => {
    if (call) wasInCall.current = true;
    else if (wasInCall.current && phase.kind === 'in-call') {
      wasInCall.current = false;
      setPhase({ kind: 'left', ended: false });
    }
  }, [call, phase.kind]);

  // Wartebereich: alle 2 s nachfragen
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const { requestId, secret } = phase.req;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api<MeetLobbyStatus>(`/meet/lobby/${requestId}`, { query: { secret } });
        if (stopped) return;
        if (s.status === 'admitted' && s.join) {
          startCall(s.join, { video });
          setPhase({ kind: 'in-call' });
          return;
        }
        if (s.status === 'denied') return setPhase({ kind: 'denied' });
        if (s.status === 'ended') return setPhase({ kind: 'left', ended: true });
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) return setPhase({ kind: 'left', ended: true });
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 2000);
    };
    let timer = window.setTimeout(() => void tick(), 1000);
    // Seite geschlossen: Anfrage zurückziehen
    const onHide = () => {
      try {
        void fetch(`/api/meet/lobby/${requestId}/leave?secret=${encodeURIComponent(secret)}`, {
          method: 'POST',
          keepalive: true,
          headers: { 'X-Requested-With': 'kuvert' },
        });
      } catch {
        /* egal */
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', onHide);
    };
  }, [phase, video]);

  if (showLogin) return <LoginPage setup={false} allowRegistration={false} />;

  const toaster = <Toaster richColors closeButton position="bottom-right" toastOptions={{ className: 'rounded-xl! shadow-pop! font-sans!' }} />;

  if (call) {
    return (
      <>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-[#0f1115]">
              <Spinner />
            </div>
          }
        >
          <CallRoom call={call} title={call.title || info?.title || 'Anruf'} />
        </Suspense>
        {toaster}
      </>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !info) return <LinkError error={error} />;

  const knock = async () => {
    const n = name.trim();
    if (!n) return;
    setSending(true);
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      /* egal */
    }
    try {
      const req = await api<MeetKnockResult>(`/meet/links/${encodeURIComponent(token)}/knock`, { method: 'POST', body: { name: n } });
      setPhase({ kind: 'waiting', req });
    } catch (err) {
      setPhase({ kind: 'form' });
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const cancelWaiting = (req: MeetKnockResult) => {
    void api(`/meet/lobby/${req.requestId}/leave`, { method: 'POST', query: { secret: req.secret } }).catch(() => undefined);
    setPhase({ kind: 'form' });
  };

  return (
    <Card>
      <LinkHeader info={info} />
      {!info.guestsAllowed ? (
        <p className="text-sm text-muted">Gäste ohne Kuvert-Konto sind für diesen Anruf nicht zugelassen.</p>
      ) : phase.kind === 'waiting' ? (
        <div className="space-y-4 text-center">
          <Spinner className="mx-auto h-6 w-6" />
          <div>
            <p className="font-medium">Du hast angeklopft</p>
            <p className="mt-1 text-sm text-muted">
              {info.active ? 'Gleich lässt dich jemand herein.' : 'Sobald jemand dem Meeting beitritt, kann er dich hereinlassen.'} Bitte lass
              diese Seite geöffnet.
            </p>
          </div>
          <Button onClick={() => cancelWaiting(phase.req)}>Abbrechen</Button>
        </div>
      ) : phase.kind === 'denied' ? (
        <div className="space-y-3">
          <p className="text-sm">Deine Anfrage wurde abgelehnt.</p>
          <Button onClick={() => setPhase({ kind: 'form' })}>Erneut anklopfen</Button>
        </div>
      ) : phase.kind === 'left' ? (
        <div className="space-y-3">
          <p className="text-sm">{phase.ended ? 'Der Anruf ist beendet.' : 'Du bist nicht mehr im Anruf.'}</p>
          <Button onClick={() => setPhase({ kind: 'form' })}>Erneut beitreten</Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void knock();
          }}
        >
          <Field label="Dein Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus autoComplete="name" required />
          </Field>
          <Checkbox checked={video} onChange={setVideo} label="Mit Kamera beitreten" />
          <Button variant="primary" type="submit" className="w-full" loading={sending} disabled={!name.trim()}>
            Beitreten
          </Button>
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Du kommst herein, sobald jemand aus dem Anruf dich zulässt. Der Browser fragt nach Mikrofon und Kamera.
          </p>
        </form>
      )}
      {phase.kind === 'form' && (
        <button type="button" onClick={() => setShowLogin(true)} className="mt-5 text-xs text-primary hover:underline">
          Ich habe ein Kuvert-Konto – anmelden
        </button>
      )}
      {toaster}
    </Card>
  );
}

/* ───────────────────────────── Angemeldet ───────────────────────────── */

export function MemberJoinPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { data: info, error, isLoading } = useLinkInfo(token);
  const [video, setVideo] = useState(false);
  const [joining, setJoining] = useState(false);
  const call = useActiveCall();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !info) return <LinkError error={error} />;

  return (
    <Card>
      <LinkHeader info={info} />
      {call ? (
        <p className="text-sm text-muted">Du bist gerade in einem Anruf.</p>
      ) : (
        <div className="space-y-4">
          <Checkbox checked={video} onChange={setVideo} label="Mit Kamera beitreten" />
          <Button
            variant="primary"
            className="w-full"
            loading={joining}
            onClick={async () => {
              setJoining(true);
              await joinByLink(token, { video });
              setJoining(false);
            }}
          >
            {info.active ? 'Beitreten' : 'Meeting starten'}
          </Button>
        </div>
      )}
    </Card>
  );
}
