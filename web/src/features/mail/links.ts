/**
 * Öffentliche Helfer für Links in den Mail-Bereich (Benachrichtigungen, Befehlspalette, Suche …).
 * Format: /mail/f/<kontoId>/<b64url(ordnerId)>?m=<b64url(konto)>.<b64url(ordner)>.<b64url(nachricht)>
 */
export function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): string {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

export interface MessageLinkRef {
  accountId: string;
  folderId: string;
  id: string;
}

export function encodeMessageRef(r: MessageLinkRef): string {
  return [r.accountId, r.folderId, r.id].map(b64url).join('.');
}

export function decodeMessageRef(s: string | null): MessageLinkRef | null {
  if (!s) return null;
  const [a, f, i] = s.split('.').map(fromB64url);
  return a && f && i ? { accountId: a, folderId: f, id: i } : null;
}

export function folderUrl(accountId: string, folderId: string): string {
  return `/mail/f/${accountId}/${b64url(folderId)}`;
}

/** Link, der den Ordner öffnet und die Nachricht anzeigt */
export function messageUrl(r: MessageLinkRef): string {
  return `${folderUrl(r.accountId, r.folderId)}?m=${encodeMessageRef(r)}`;
}
