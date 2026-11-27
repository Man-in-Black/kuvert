/**
 * Laufende Kuvert-Anrufe je Unterhaltung. Das Modul „meet“ (LiveKit) trägt sie hier ein,
 * der Chat liefert sie mit den Unterhaltungen aus (ChatConversation.call).
 * Liegt im Chat, damit der Chat nicht vom optionalen Anruf-Modul abhängt.
 */
import type { ChatCall } from '@kuvert/shared';

export const kuvertCalls = new Map<string, ChatCall>();
