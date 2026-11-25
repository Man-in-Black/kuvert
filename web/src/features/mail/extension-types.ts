/**
 * Schnittstellen, über die andere Module den Mail-Bereich erweitern
 * (Editor-Werkzeugleiste, Composer-Optionen, Nachrichtenaktionen).
 */
import type { Editor } from '@tiptap/react';
import type { MessageDetail, MessageSummary, OutgoingMessage } from '@kuvert/shared';

/** Zustand des Verfassen-Dialogs, den Erweiterungen lesen/ändern dürfen */
export interface ComposeDraft {
  accountId: string;
  message: OutgoingMessage;
  /** Ursprungsnachricht bei Antwort/Weiterleitung */
  original?: MessageDetail;
  mode: 'new' | 'reply' | 'replyAll' | 'forward' | 'edit';
}

export interface ComposerExtensionProps {
  editor: Editor | null;
  draft: ComposeDraft;
  updateMessage: (patch: Partial<OutgoingMessage>) => void;
  /** HTML an der Cursorposition einfügen */
  insertHtml: (html: string) => void;
  /** Markierter Text (oder leer) */
  getSelectedText: () => string;
  /** Kompletter Editorinhalt als Text/HTML */
  getText: () => string;
  getHtml: () => string;
  /** Editorinhalt (oder Markierung, falls vorhanden) ersetzen */
  replaceContent: (html: string, onlySelection?: boolean) => void;
}

export interface MessageExtensionProps {
  accountId: string;
  folderId: string;
  message: MessageDetail;
}

/** Aktionen für eine ganze Unterhaltung (Konversationsansicht) */
export interface ConversationExtensionProps {
  /** Alle Nachrichten der Unterhaltung, neueste zuerst (ggf. inkl. eigener aus „Gesendet“) */
  messages: MessageSummary[];
}
