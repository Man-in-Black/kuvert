/**
 * Zuordnung von Absendern über die Domain (z. B. zu Kunden oder Leads):
 * Freemail-Domains taugen dafür nicht – dort teilen sich fremde Personen eine Domain.
 */

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'outlook.com', 'outlook.de',
  'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com', 'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.de', 'freenet.de', 'mail.de', 'posteo.de', 'posteo.net', 'mailbox.org', 'protonmail.com', 'proton.me',
  'arcor.de', 'online.de', 'vodafone.de', 'email.de', 'kabelmail.de',
]);

export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Darf über die Domain zugeordnet werden? Nicht bei Freemailern und nicht bei der eigenen Domain */
export const domainMatchable = (domain: string, ownEmail: string) => !!domain && !FREEMAIL.has(domain) && domain !== domainOf(ownEmail);
