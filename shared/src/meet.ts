/* ───────────────────────────── Anrufe (Modul meet, LiveKit) ───────────────────────────── */

/** Zugang zu einem Kuvert-Anruf: damit verbindet sich der Browser mit LiveKit */
export interface MeetJoinResult {
  callId: string;
  /** Anruf in einer Chat-Unterhaltung; null = Meeting (Kalender-Link) */
  conversationId: string | null;
  /** Anzeigename des Anrufs (Meeting-Titel); bei Unterhaltungen leer – der Titel kommt aus dem Chat */
  title: string;
  /** LiveKit-Raum */
  room: string;
  /** WebSocket-Adresse für den Browser (wss://… oder wss://<kuvert>/api/meet/lk) */
  url: string;
  /** Zugangs-Token (JWT) */
  token: string;
  /** Als Gast (ohne Kuvert-Konto) im Anruf */
  guest: boolean;
  /** Darf Gäste und weitere Personen einladen und Gäste zulassen (Kuvert-Benutzer im Anruf) */
  canInvite: boolean;
  /** Darf den Anruf für alle beenden (wer ihn gestartet bzw. das Meeting angelegt hat) */
  canEndForAll: boolean;
  /** Gäste sind erlaubt (Admin-Einstellung) */
  guestsAllowed: boolean;
  /** Bildschirmfreigabe erlaubt (Admin-Einstellung) */
  allowScreenShare: boolean;
  /** Whiteboard erlaubt (Admin-Einstellung) */
  allowWhiteboard: boolean;
  /** API-Pfad zum Verlassen (POST) */
  leavePath: string;
}

/** Wer im Wartebereich eines Anrufs anklopft */
export interface MeetLobbyEntry {
  id: string;
  name: string;
  /** ISO-Zeitpunkt des Anklopfens */
  at: string;
}

/** Gast im Anruf (zugelassen) */
export interface MeetGuest {
  /** LiveKit-Identität (guest:…) */
  identity: string;
  name: string;
}

/** Stand eines Anrufs für die Teilnehmenden aus Kuvert (Einladen-Bereich) */
export interface MeetCallState {
  callId: string;
  /** Gast-Link des Anrufs, falls angelegt (bei Meetings: der feste Meeting-Link) */
  guestLink: string | null;
  /** Gast-Link lässt sich widerrufen (nur der Link eines laufenden Anrufs, nicht der eines Meetings) */
  guestLinkRevocable: boolean;
  lobby: MeetLobbyEntry[];
  guests: MeetGuest[];
  /** Eingeladene Kuvert-Benutzer (noch nicht beigetreten) */
  invitedIds: string[];
}

/** Öffentliche Infos zu einem Einladungslink (Seite für Gäste) */
export interface MeetLinkInfo {
  kind: 'call' | 'meeting';
  title: string;
  /** Wer einlädt (Anruf: wer den Anruf begonnen hat; Meeting: wer es angelegt hat) */
  host: string;
  /** Läuft gerade ein Anruf? (Meeting ohne laufenden Anruf: Gäste warten, bis jemand beitritt) */
  active: boolean;
  guestsAllowed: boolean;
}

/** Antwort auf das Anklopfen eines Gastes */
export interface MeetKnockResult {
  requestId: string;
  /** Geheimnis des Gastes für Abfrage und Verlassen */
  secret: string;
}

/** Stand des Anklopfens (Gast fragt alle paar Sekunden nach) */
export interface MeetLobbyStatus {
  status: 'waiting' | 'admitted' | 'denied' | 'ended';
  /** Bei „admitted“: Zugang zum Anruf */
  join?: MeetJoinResult;
}

/** Meeting mit festem Link (z. B. für Kalendertermine) */
export interface MeetMeeting {
  id: string;
  title: string;
  /** Vollständiger Link zum Beitreten (/join/…) */
  url: string;
  createdAt: string;
}

/** Datenkanal-Themen im Anruf */
export const MEET_TOPIC_WHITEBOARD = 'kuvert.whiteboard';

/** Einstellungen der LiveKit-Anbindung im Admin-Bereich */
export interface MeetAdminConfig {
  enabled: boolean;
  /** Adresse, unter der Kuvert den LiveKit-Server erreicht (z. B. http://livekit:7880) */
  url: string;
  /**
   * Adresse für die Browser (wss://…). Leer = über Kuvert selbst (wss://<kuvert>/api/meet/lk),
   * dann braucht LiveKit keine eigene Domain und kein eigenes Zertifikat.
   */
  publicUrl: string;
  apiKey: string;
  secretConfigured: boolean;
  /** Bildschirmfreigabe erlauben */
  screenShare: boolean;
  /** Whiteboard im Anruf erlauben */
  whiteboard: boolean;
  /** Gäste ohne Kuvert-Konto per Link einladen erlauben */
  guests: boolean;
}

export interface MeetAdminConfigInput {
  enabled: boolean;
  url: string;
  publicUrl: string;
  apiKey: string;
  /** Leer/fehlt = unverändert */
  apiSecret?: string;
  screenShare: boolean;
  whiteboard: boolean;
  guests: boolean;
}

export interface MeetTestResult {
  ok: boolean;
  message: string;
}
