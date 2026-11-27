/**
 * Schnittstellen, über die andere Module den Mail-Bereich erweitern
 * (Editor-Werkzeugleiste, Composer-Optionen, Nachrichtenaktionen).
 */
import type { ComponentType, ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { AttachmentInfo, MessageDetail, MessageSummary, OutgoingMessage, UploadInfo } from '@kuvert/shared';
import type { MessageRef } from './api';

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

/** Dialog einer zusätzlichen Anhang-Quelle im Editor (z. B. Paperless) */
export interface AttachSourceDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Datei anhängen: erscheint sofort mit Fortschrittsanzeige in der Anhangliste,
   * load() stellt sie als Upload bereit (Fehler werden am Anhang angezeigt).
   */
  attach: (file: { filename: string; contentType?: string; size?: number }, load: () => Promise<UploadInfo>) => void;
  /** Link auf eine Datei an der Cursorposition einfügen (HTML bzw. Nur-Text) */
  insertLink: (name: string, url: string, size?: number) => void;
}

/** Zusätzlicher Eintrag im Menü „Anhängen“ des Editors */
export interface ComposerAttachSource {
  id: string;
  label: string;
  icon: ReactNode;
  dialog: ComponentType<AttachSourceDialogProps>;
}

/** Zusätzlicher Knopf an einem Anhang in der Nachrichtenansicht (z. B. „An Paperless senden“) */
export interface AttachmentExtensionProps {
  attachment: AttachmentInfo;
  msgRef: MessageRef;
}
