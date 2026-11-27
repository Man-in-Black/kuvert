/**
 * Anruf-Fenster (LiveKit): Videokacheln bzw. Bildschirmfreigabe im Fokus, Whiteboard,
 * Steuerleiste (Mikrofon, Kamera, Geräte, Bildschirm, Whiteboard, Auflegen).
 * Lässt sich verkleinern – der Anruf läuft dann in einer kleinen Karte unten rechts weiter,
 * während man Kuvert normal benutzt.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CarouselLayout,
  ConnectionStateToast,
  GridLayout,
  LayoutContextProvider,
  LiveKitRoom,
  MediaDeviceMenu,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  isTrackReference,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { ConnectionState, DisconnectReason, MediaDeviceFailure, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import '@livekit/components-styles';
import { toast } from 'sonner';
import { Maximize2, Mic, MicOff, Minimize2, MonitorUp, MonitorX, PenLine, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
import { useFeature } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { callState, leaveCall, type ActiveCall } from './store';
import { WhiteboardSync } from './whiteboard-sync';

const Whiteboard = lazy(() => import('./Whiteboard'));

/** Fehler beim Starten von Mikrofon/Kamera (getUserMedia) – kein Grund, den Anruf zu verlassen */
const DEVICE_ERRORS = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'NotFoundError',
  'DevicesNotFoundError',
  'NotReadableError',
  'TrackStartError',
  'OverconstrainedError',
  'DeviceUnsupportedError',
]);

export default function CallRoom({ call, title }: { call: ActiveCall; title: string }) {
  // Eigener Room je Beitritt: Optionen für Videoqualität und sparsame Übertragung
  const room = useMemo(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        publishDefaults: { simulcast: true },
      }),
    [call.token],
  );

  return (
    <LiveKitRoom
      room={room}
      serverUrl={call.url}
      token={call.token}
      connect
      audio
      video={call.video}
      data-lk-theme="default"
      onDisconnected={(reason) => {
        if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED && reason !== DisconnectReason.ROOM_DELETED) {
          toast.error('Verbindung zum Anruf verloren');
        }
        leaveCall();
      }}
      onError={(err) => {
        // Mikrofon/Kamera verweigert oder nicht vorhanden: im Anruf bleiben (zuhören, Whiteboard …);
        // die Meldung dazu kommt über onMediaDeviceFailure
        if (DEVICE_ERRORS.has(err.name)) return;
        toast.error(`Anruf: ${err.message || 'Verbindung fehlgeschlagen'}`, {
          description: 'Ist LiveKit erreichbar und leitet ein vorgeschalteter Proxy WebSockets weiter?',
        });
        leaveCall();
      }}
      onMediaDeviceFailure={(failure, kind) => {
        const what = kind === 'videoinput' ? 'Kamera' : kind === 'audioinput' ? 'Mikrofon' : 'Gerät';
        toast.error(
          failure === MediaDeviceFailure.PermissionDenied
            ? `Kein Zugriff auf ${what} – bitte im Browser erlauben`
            : failure === MediaDeviceFailure.NotFound
              ? `${what} nicht gefunden`
              : failure === MediaDeviceFailure.DeviceInUse
                ? `${what} wird von einem anderen Programm verwendet`
                : `${what} lässt sich nicht verwenden`,
        );
      }}
      className={cn(
        // „!“: das LiveKit-Stylesheet setzt .lk-room-container auf position: relative, 100 % Breite/Höhe
        'kuvert-call fixed! z-[70] flex flex-col overflow-hidden text-white shadow-2xl',
        call.minimized
          ? 'bottom-4 right-4 h-[210px]! w-[min(360px,calc(100vw-2rem))]! rounded-2xl ring-1 ring-white/10'
          : 'inset-0',
      )}
      style={{ background: '#0f1115' }}
    >
      <LayoutContextProvider>
        <CallContent call={call} title={title} />
      </LayoutContextProvider>
      <RoomAudioRenderer />
      <ConnectionStateToast />
    </LiveKitRoom>
  );
}

function CallContent({ call, title }: { call: ActiveCall; title: string }) {
  const room = useRoomContext();
  const state = useConnectionState();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const allowScreen = useFeature('meetScreenShare');
  const allowWhiteboard = useFeature('meetWhiteboard');
  const [wbActivity, setWbActivity] = useState(false);
  const elapsed = useElapsed(call.joinedAt);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  const screens = tracks.filter((t) => isTrackReference(t) && t.source === Track.Source.ScreenShare);
  const cameras = tracks.filter((t) => t.source === Track.Source.Camera);

  // Whiteboard-Abgleich läuft, solange man im Anruf ist (auch bei geschlossenem Whiteboard)
  const sync = useMemo(() => new WhiteboardSync(room), [room]);
  useEffect(() => () => sync.dispose(), [sync]);
  useEffect(() => {
    if (state === ConnectionState.Connected) sync.requestState();
  }, [state, sync]);
  useEffect(
    () =>
      sync.onOpen((name) => {
        setWbActivity(true);
        if (callState.get()?.whiteboard) return;
        toast(`${name} hat das Whiteboard geöffnet`, {
          id: 'meet-wb-open',
          action: { label: 'Öffnen', onClick: () => callState.patch({ whiteboard: true, minimized: false }) },
        });
      }),
    [sync],
  );
  useEffect(() => sync.onScene(() => setWbActivity(true)), [sync]);

  const others = participants.filter((p) => p.identity !== localParticipant.identity).length;
  useEffect(() => {
    if (others > 0 && !callState.get()?.othersJoined) callState.patch({ othersJoined: true });
  }, [others]);

  const connecting = state === ConnectionState.Connecting || state === ConnectionState.Reconnecting;
  const waiting = state === ConnectionState.Connected && others === 0;

  /* ───────────── Klein (unten rechts) ───────────── */
  if (call.minimized) {
    const remote = screens[0] ?? cameras.find((t) => t.participant.identity !== localParticipant.identity) ?? cameras[0];
    return (
      <div className="relative flex h-full flex-col">
        <div className="relative min-h-0 flex-1">
          {remote ? <ParticipantTile trackRef={remote} className="h-full w-full" /> : <div className="h-full w-full" />}
          <button
            type="button"
            onClick={() => callState.patch({ minimized: false })}
            className="absolute inset-0 z-10 cursor-pointer"
            title="Anruf vergrößern"
            aria-label="Anruf vergrößern"
          />
        </div>
        <div className="flex items-center gap-1.5 bg-black/60 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs">
            <span className="font-medium">{title}</span>
            <span className="text-white/60"> · {waiting ? 'Klingelt …' : elapsed}</span>
          </span>
          <MicToggle small />
          <RoundButton small label="Vergrößern" onClick={() => callState.patch({ minimized: false })}>
            <Maximize2 className="h-4 w-4" />
          </RoundButton>
          <RoundButton small danger label="Auflegen" onClick={leaveCall}>
            <PhoneOff className="h-4 w-4" />
          </RoundButton>
        </div>
      </div>
    );
  }

  /* ───────────── Vollbild ───────────── */
  const strip = [...screens.slice(call.whiteboard ? 0 : 1), ...cameras];
  let stage: ReactNode;
  if (call.whiteboard) {
    stage = (
      // Kacheln erst ab xl daneben: Excalidraws Werkzeugleiste braucht in der Desktop-Ansicht rund 1000 px
      <div className="flex h-full min-h-0 flex-col gap-2 xl:flex-row">
        <div className="min-h-0 min-w-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-white/60">Whiteboard wird geladen …</div>}>
            <Whiteboard sync={sync} conversationId={call.conversationId} myName={localParticipant.name || 'Jemand'} />
          </Suspense>
        </div>
        <div className="h-28 shrink-0 xl:h-auto xl:w-56">
          <CarouselLayout tracks={strip} className="lk-carousel h-full">
            <ParticipantTile />
          </CarouselLayout>
        </div>
      </div>
    );
  } else if (screens.length) {
    stage = (
      <div className="flex h-full min-h-0 flex-col gap-2 md:flex-row">
        <div className="min-h-0 min-w-0 flex-1">
          <ParticipantTile trackRef={screens[0]} className="h-full w-full" />
        </div>
        {strip.length > 0 && (
          <div className="h-28 shrink-0 md:h-auto md:w-56">
            <CarouselLayout tracks={strip} className="lk-carousel h-full">
              <ParticipantTile />
            </CarouselLayout>
          </div>
        )}
      </div>
    );
  } else {
    stage = (
      <GridLayout tracks={cameras} className="h-full">
        <ParticipantTile />
      </GridLayout>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Kopf */}
      <header className="flex h-12 shrink-0 items-center gap-3 px-3 sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-white/60">
            {connecting ? 'Verbinde …' : waiting ? 'Klingelt … warte auf die anderen' : elapsed}
          </span>
        </span>
        <span className="flex items-center gap-1 text-xs text-white/70" title="Im Anruf">
          <Users className="h-4 w-4" />
          {participants.length}
        </span>
        <RoundButton label="Verkleinern – Kuvert weiter benutzen" onClick={() => callState.patch({ minimized: true })}>
          <Minimize2 className="h-4 w-4" />
        </RoundButton>
      </header>

      {/* Bühne */}
      <div className="min-h-0 flex-1 px-2 sm:px-3">{stage}</div>

      {/* Steuerleiste */}
      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-3">
        <MicToggle />
        <MediaDeviceMenu kind="audioinput" className="kuvert-call-device" title="Mikrofon wählen" />
        <TrackToggle
          source={Track.Source.Camera}
          showIcon={false}
          className={toggleClass}
          title="Kamera an/aus"
          onDeviceError={() => toast.error('Kamera lässt sich nicht starten')}
        >
          <CameraIcon />
        </TrackToggle>
        <MediaDeviceMenu kind="videoinput" className="kuvert-call-device" title="Kamera wählen" />
        {allowScreen && (
          <TrackToggle
            source={Track.Source.ScreenShare}
            showIcon={false}
            className={cn(toggleClass, 'data-[lk-enabled=true]:!bg-primary data-[lk-enabled=false]:!bg-white/10')}
            title="Bildschirm freigeben"
            captureOptions={{ audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' }}
            onDeviceError={(err) => {
              if (err?.name !== 'NotAllowedError') toast.error('Bildschirmfreigabe nicht möglich');
            }}
          >
            <ScreenIcon />
          </TrackToggle>
        )}
        {allowWhiteboard && (
          <RoundButton
            label={call.whiteboard ? 'Whiteboard schließen' : 'Whiteboard öffnen'}
            active={call.whiteboard}
            dot={!call.whiteboard && wbActivity}
            onClick={() => {
              setWbActivity(false);
              callState.patch({ whiteboard: !call.whiteboard });
            }}
          >
            <PenLine className="h-5 w-5" />
          </RoundButton>
        )}
        <RoundButton danger label="Auflegen" onClick={leaveCall} className="ml-2 w-16">
          <PhoneOff className="h-5 w-5" />
        </RoundButton>
        <StartAudio label="Ton aktivieren" className="ml-2 rounded-full bg-warning px-4 py-2 text-sm font-medium text-black" />
      </footer>
    </div>
  );
}

/* ───────────────────────────── Bausteine ───────────────────────────── */

const toggleClass =
  'flex h-11 w-11 items-center justify-center rounded-full transition-colors data-[lk-enabled=true]:bg-white/10 data-[lk-enabled=true]:hover:bg-white/20 data-[lk-enabled=false]:bg-danger data-[lk-enabled=false]:hover:brightness-110';

function MicToggle({ small }: { small?: boolean }) {
  const { isMicrophoneEnabled } = useLocalParticipant();
  return (
    <TrackToggle
      source={Track.Source.Microphone}
      showIcon={false}
      className={cn(toggleClass, small && '!h-8 !w-8')}
      title={isMicrophoneEnabled ? 'Stummschalten' : 'Stummschaltung aufheben'}
      onDeviceError={() => toast.error('Mikrofon lässt sich nicht starten')}
    >
      {isMicrophoneEnabled ? <Mic className={small ? 'h-4 w-4' : 'h-5 w-5'} /> : <MicOff className={small ? 'h-4 w-4' : 'h-5 w-5'} />}
    </TrackToggle>
  );
}

function CameraIcon() {
  const { isCameraEnabled } = useLocalParticipant();
  return isCameraEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />;
}

function ScreenIcon() {
  const { isScreenShareEnabled } = useLocalParticipant();
  return isScreenShareEnabled ? <MonitorX className="h-5 w-5" /> : <MonitorUp className="h-5 w-5" />;
}

function RoundButton({
  label,
  onClick,
  children,
  danger,
  active,
  dot,
  small,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  active?: boolean;
  dot?: boolean;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full transition-colors',
        small ? 'h-8 w-8' : 'h-11 w-11',
        danger ? 'bg-danger hover:brightness-110' : active ? 'bg-primary hover:brightness-110' : 'bg-white/10 hover:bg-white/20',
        className,
      )}
    >
      {children}
      {dot && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-[#0f1115]" />}
    </button>
  );
}

/** Laufzeit des Anrufs (mm:ss bzw. h:mm:ss) */
function useElapsed(since: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
