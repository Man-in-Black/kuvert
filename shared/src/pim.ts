import type { EmailAddress } from './common';

/* ───────────────────────────── Kalender ───────────────────────────── */

export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  color?: string;
  readOnly?: boolean;
  isDefault?: boolean;
  owner?: string;
  /** Unterstützt der Kalender das Anlegen von Online-Meetings (Teams/Meet)? */
  canOnlineMeeting?: boolean;
  onlineMeetingProvider?: 'teams' | 'meet' | string;
}

export type AttendeeStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction' | 'none';

export interface Attendee {
  name?: string;
  address: string;
  status?: AttendeeStatus;
  type?: 'required' | 'optional' | 'resource';
}

export type ShowAs = 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere';

export interface CalendarEvent {
  id: string;
  accountId: string;
  calendarId: string;
  title: string;
  description?: string;
  descriptionHtml?: string;
  location?: string;
  /** ISO-8601; bei ganztägigen Terminen YYYY-MM-DD */
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  /** RRULE (ohne "RRULE:"-Präfix) */
  recurrence?: string | null;
  /** ID der Serie, falls dies eine Instanz ist */
  recurringEventId?: string;
  /** Ursprünglicher Beginn einer Serien-Instanz laut Muster (auch wenn sie verschoben wurde) */
  originalStart?: string;
  /** Instanz einer Serie, die einzeln geändert wurde (Ausnahme) */
  isException?: boolean;
  attendees?: Attendee[];
  organizer?: EmailAddress;
  onlineMeetingUrl?: string;
  onlineMeetingProvider?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  showAs?: ShowAs;
  reminderMinutes?: number | null;
  myResponse?: AttendeeStatus;
  isOrganizer?: boolean;
  webLink?: string;
  color?: string;
  etag?: string;
}

export interface EventInput {
  title: string;
  description?: string;
  /** Beschreibung als HTML (falls vom Provider unterstützt) */
  descriptionHtml?: string;
  location?: string;
  start: string;
  end: string;
  allDay?: boolean;
  timeZone?: string;
  attendees?: Attendee[];
  recurrence?: string | null;
  reminderMinutes?: number | null;
  /** Teams- bzw. Google-Meet-Besprechung erzeugen */
  onlineMeeting?: boolean;
  showAs?: ShowAs;
}

export type EventResponse = 'accept' | 'tentative' | 'decline';

/** Vorschlag der Ortssuche (Google Places) im Termin-Dialog */
export interface PlaceSuggestion {
  placeId: string;
  /** Name des Orts bzw. erste Adresszeile, z. B. „il Mio“ */
  main: string;
  /** Rest, z. B. „Marienstraße 1, Neu-Ulm, Deutschland“ */
  secondary?: string;
  /** Unternehmen/Sehenswürdigkeit statt reiner Adresse */
  poi: boolean;
}

/** Aufgelöster Ort: fertiger Text für das Feld „Ort“ */
export interface PlaceDetails {
  placeId: string;
  location: string;
  address?: string;
}

export interface OnlineMeeting {
  joinUrl: string;
  subject?: string;
  start?: string;
  end?: string;
  /** Fertiger HTML-Block zum Einfügen in E-Mails */
  html?: string;
  provider: 'teams' | 'meet' | string;
}

/* ───────────────────────────── Kontakte ───────────────────────────── */

export interface AddressBook {
  id: string;
  accountId: string;
  name: string;
  readOnly?: boolean;
  /** Name und Farbe der Quelle, wenn sie kein Mailkonto ist (z. B. ein CRM) */
  sourceName?: string;
  sourceColor?: string;
}

export interface Contact {
  id: string;
  accountId: string;
  addressBookId: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  department?: string;
  jobTitle?: string;
  emails: { type?: string; address: string }[];
  phones: { type?: string; number: string }[];
  addresses?: { type?: string; street?: string; city?: string; postalCode?: string; region?: string; country?: string }[];
  birthday?: string | null;
  notes?: string;
  website?: string;
  photoUrl?: string;
  etag?: string;
  /** Nur bei Kontaktquellen (z. B. ein CRM): Merkmale wie Rollen, als Abzeichen angezeigt */
  tags?: string[];
  /** Nur bei Kontaktquellen: weiterführende Links; `url` mit „/“ am Anfang führt in Kuvert */
  links?: { label: string; url: string }[];
}

export type ContactInput = Omit<Contact, 'id' | 'accountId' | 'addressBookId' | 'etag' | 'tags' | 'links'>;

export interface AddressSuggestion {
  name?: string;
  address: string;
  source: 'contact' | 'recent' | 'directory';
  accountId?: string;
  /** Eigene Beschriftung der Quelle (statt „Kontakt“), z. B. „CRM“ */
  label?: string;
}

/* ───────────────────────────── Aufgaben ───────────────────────────── */

export interface TaskList {
  id: string;
  accountId: string;
  name: string;
  isDefault?: boolean;
  color?: string;
  /** Name und Farbe der Quelle, wenn sie kein Mailkonto ist (z. B. Kuvert-eigene Aufgaben) */
  sourceName?: string;
  sourceColor?: string;
  /** Listen dieser Quelle lassen sich in Kuvert anlegen, umbenennen und löschen */
  manageable?: boolean;
}

/** Verweis einer Aufgabe auf die E-Mail, aus der sie entstanden ist */
export interface TaskMailRef {
  accountId: string;
  folderId: string;
  messageId: string;
  subject?: string;
  from?: string;
}

export interface Task {
  id: string;
  accountId: string;
  listId: string;
  title: string;
  notes?: string;
  /** ISO-Datum/-Zeitpunkt */
  due?: string | null;
  completed: boolean;
  completedAt?: string | null;
  importance?: 'low' | 'normal' | 'high';
  createdAt?: string;
  updatedAt?: string;
  parentId?: string | null;
  etag?: string;
  /** Nur bei Kuvert-eigenen Aufgaben: Ursprungs-Mail */
  mailRef?: TaskMailRef | null;
}

export interface TaskInput {
  title?: string;
  notes?: string;
  due?: string | null;
  completed?: boolean;
  importance?: 'low' | 'normal' | 'high';
  /** Wird nur von Kuvert-eigenen Aufgaben gespeichert, andere Anbieter ignorieren es */
  mailRef?: TaskMailRef | null;
}

/* ───────────────────────────── Speicher ───────────────────────────── */

export interface StorageItem {
  id: string;
  accountId: string;
  name: string;
  path?: string;
  parentId?: string | null;
  isFolder: boolean;
  size?: number;
  modified?: string;
  contentType?: string;
  webUrl?: string;
}

export interface ShareLink {
  url: string;
  expires?: string | null;
}
