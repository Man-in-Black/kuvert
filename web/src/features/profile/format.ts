import { formatDistanceToNow } from 'date-fns';
import { de } from 'date-fns/locale';

/** "vor 5 Minuten" – oder Strich bei fehlendem Datum */
export function relativeTime(iso?: string | null, empty = '–'): string {
  if (!iso) return empty;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return empty;
  return formatDistanceToNow(d, { addSuffix: true, locale: de });
}

export function absoluteTime(iso?: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} T ${h} Std`;
  if (h) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

export interface ParsedAgent {
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'api';
}

/** Grobe Erkennung von Browser, Betriebssystem und Gerätetyp aus dem User-Agent */
export function parseUserAgent(ua?: string | null): ParsedAgent {
  if (!ua) return { browser: 'Unbekannt', os: '', device: 'desktop' };
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|python|node|axios|okhttp/i.test(ua)
              ? 'API-Client'
              : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const device: ParsedAgent['device'] = browser === 'API-Client' ? 'api' : /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|iPhone|Android/.test(ua) ? 'mobile' : 'desktop';
  return { browser, os, device };
}
