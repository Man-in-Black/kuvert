/* ───────────────────────────── Anrufe (Modul meet, LiveKit) ───────────────────────────── */

/** Zugang zu einem Kuvert-Anruf: damit verbindet sich der Browser mit LiveKit */
export interface MeetJoinResult {
  callId: string;
  conversationId: string;
  /** LiveKit-Raum */
  room: string;
  /** WebSocket-Adresse für den Browser (wss://… oder wss://<kuvert>/api/meet/lk) */
  url: string;
  /** Zugangs-Token (JWT), wenige Stunden gültig */
  token: string;
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
}

export interface MeetTestResult {
  ok: boolean;
  message: string;
}
