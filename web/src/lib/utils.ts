import clsx, { type ClassValue } from 'clsx';
import { format, isThisYear, isToday, isYesterday } from 'date-fns';
import { de } from 'date-fns/locale';
import type { EmailAddress } from '@kuvert/shared';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** Kompaktes Datum für Listen: heute → Uhrzeit, dieses Jahr → "12. Mär", sonst "12.03.2024" */
export function formatListDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'HH:mm', { locale: de });
  if (isYesterday(d)) return 'Gestern';
  if (isThisYear(d)) return format(d, 'd. MMM', { locale: de });
  return format(d, 'dd.MM.yyyy', { locale: de });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, "EEEE, d. MMMM yyyy 'um' HH:mm", { locale: de });
}

export function formatSize(bytes: number | undefined): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function displayAddress(a?: EmailAddress | null): string {
  if (!a) return '';
  return a.name || a.address;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Parst "Name <a@b.de>, c@d.de" in Adressen */
export function parseAddressList(input: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const part of input.split(/[,;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*)<([^>]+)>$/);
    if (m) out.push({ name: m[1]!.trim().replace(/^"|"$/g, '') || undefined, address: m[2]!.trim() });
    else out.push({ address: s });
  }
  return out;
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function initials(name: string): string {
  const parts = name.replace(/[<>"@.]/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

/** Deterministische Farbe aus einem String (für Avatare) */
export function colorFromString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
