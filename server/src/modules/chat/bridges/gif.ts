/**
 * GIFs der GIF-Auswahl von Teams, Mattermost und Nextcloud Talk (Giphy/Tenor).
 *
 * Die Bilder liegen beim Anbieter und stecken nur als Adresse in der Nachricht
 * (Teams: <img src="…">, Mattermost/Talk: Markdown ![Titel](…)). Kuvert macht daraus
 * Bild-Anhänge und lädt sie über den Server (kein Referrer/IP des Benutzers an den
 * Anbieter) – nur von diesen Hosts, weil die Datei-ID nicht signiert ist.
 */
import type { ChatAttachment } from '@kuvert/shared';
import { HttpError, NotFoundError } from '../../../core/errors.js';
import type { BinaryFile } from './common.js';

const GIF_HOSTS = /^(?:[a-z0-9-]+\.)*(?:giphy\.com|tenor\.com|tenor\.googleapis\.com)$/i;
const MAX_GIF_BYTES = 25 * 1024 * 1024;

/** Kennung im Datei-Verweis einer externen Datei-ID (Bridge-Dateien beginnen nie so) */
const GIF_REF = 'gif:';

export function isGifUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && GIF_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Bildtyp anhand der ersten Bytes (Anbieter liefern teils octet-stream) */
export function sniffImage(data: Buffer): string | null {
  if (data.length >= 6 && data.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (data.length >= 8 && data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Lädt ein GIF von einem erlaubten Anbieter; Weiterleitungen nur zu erlaubten Hosts */
export async function fetchGif(src: string): Promise<{ data: Buffer; contentType: string }> {
  let url = src;
  for (let hop = 0; hop < 4; hop++) {
    if (!isGifUrl(url)) break;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { Accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) break;
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(404, 'GIF nicht (mehr) verfügbar');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_GIF_BYTES) throw new HttpError(413, 'GIF zu groß');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_GIF_BYTES) throw new HttpError(413, 'GIF zu groß');
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const type = sniffImage(data) ?? (/^image\//.test(ct) && !ct.includes('svg') ? ct : null);
    if (!type) throw new HttpError(404, 'GIF nicht (mehr) verfügbar');
    return { data, contentType: type };
  }
  throw new NotFoundError('Datei');
}

/** Dateiname aus dem Titel des GIFs */
export function gifName(title: string | null | undefined): string {
  const t = (title ?? '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 80);
  return `${t || 'GIF'}.gif`;
}

/** Datei-Verweis für ein GIF – über fileId() der Bridge zur Datei-ID machen */
export const gifRef = (url: string, name: string) => GIF_REF + JSON.stringify({ u: url, n: name });

/** Datei-Verweis eines GIFs abrufen; null, wenn der Verweis keiner ist */
export async function gifFile(ref: string): Promise<BinaryFile | null> {
  if (!ref.startsWith(GIF_REF)) return null;
  let f: { u?: unknown; n?: unknown };
  try {
    f = JSON.parse(ref.slice(GIF_REF.length));
  } catch {
    throw new NotFoundError('Datei');
  }
  if (typeof f.u !== 'string') throw new NotFoundError('Datei');
  const { data, contentType } = await fetchGif(f.u);
  return { filename: typeof f.n === 'string' ? f.n : 'GIF.gif', contentType, data };
}

const MD_IMAGE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)/g;

/**
 * Markdown-Bilder ![Titel](https://…) aus dem Text holen: GIFs erlaubter Anbieter werden
 * Bild-Anhänge, andere Bilder normale Links (Kuvert lädt keine beliebigen fremden Bilder).
 * Codeblöcke bleiben unverändert.
 */
export function extractMarkdownImages(body: string, fileId: (ref: string) => string): { body: string; attachments: ChatAttachment[] } {
  if (!body.includes('![')) return { body, attachments: [] };
  const attachments: ChatAttachment[] = [];
  const parts = body.split(/(```[\s\S]*?```)/g);
  const out = parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(MD_IMAGE, (_, alt: string, url: string) => {
            if (isGifUrl(url)) {
              const name = gifName(alt);
              attachments.push({ id: fileId(gifRef(url, name)), filename: name, contentType: 'image/gif', size: 0 });
              return '';
            }
            return alt.trim() ? `[${alt.trim()}](${url})` : url;
          }),
    )
    .join('');
  if (!attachments.length) return { body: out, attachments };
  return {
    body: out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments,
  };
}

/**
 * Beim Bearbeiten aus Kuvert: GIFs der alten Nachricht stehen nicht im Editor (sie werden als
 * Anhang gezeigt) – ans Ende des neuen Texts hängen, damit sie nicht verloren gehen.
 */
export function keepMarkdownGifs(oldBody: string, newBody: string): string {
  const gifs = [...oldBody.matchAll(MD_IMAGE)].filter((m) => isGifUrl(m[2]!) && !newBody.includes(m[2]!)).map((m) => m[0]);
  return gifs.length ? [newBody.trimEnd(), ...gifs].filter(Boolean).join('\n') : newBody;
}
