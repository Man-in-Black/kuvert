import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { BadRequestError } from '../core/errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new BadRequestError(`Ungültige Eingabe${first ? `: ${first.path.join('.')} – ${first.message}` : ''}`, r.error.issues);
  }
  return r.data;
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestError('Ungültiger Cursor');
  }
}

/** Liefert eine Datei aus. Nur unkritische Typen dürfen inline angezeigt werden. */
export function sendFile(reply: FastifyReply, file: { filename: string; contentType: string; data: Buffer }, inline = false) {
  const ct = (file.contentType || 'application/octet-stream').toLowerCase();
  const safeInline = inline && ((/^image\//.test(ct) && !ct.includes('svg')) || ct === 'application/pdf' || /^(audio|video)\//.test(ct));
  const encoded = encodeURIComponent(file.filename || 'datei');
  const ascii = (file.filename || 'datei').replace(/[^\x20-\x7e]|["\\]/g, '_');
  reply
    .header('Content-Type', safeInline ? ct : ct.startsWith('text/html') ? 'application/octet-stream' : ct)
    .header('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`)
    .header('X-Content-Type-Options', 'nosniff')
    // PDF-Viewer der Browser funktionieren nicht in einer CSP-Sandbox → für PDFs ohne sandbox
    .header(
      'Content-Security-Policy',
      safeInline && ct === 'application/pdf'
        ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"
        : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    )
    .header('Cache-Control', 'private, max-age=3600');
  return reply.send(file.data);
}

/** Führt Aufgaben parallel aus und sammelt Fehler pro Konto, statt komplett zu scheitern. */
export async function settleByAccount<T, A extends { id: string; name: string } = { id: string; name: string }>(
  accounts: A[],
  fn: (acc: A) => Promise<T>,
): Promise<{ results: { accountId: string; value: T }[]; errors: { accountId: string; account: string; message: string }[] }> {
  const settled = await Promise.allSettled(accounts.map((a) => fn(a)));
  const results: { accountId: string; value: T }[] = [];
  const errors: { accountId: string; account: string; message: string }[] = [];
  settled.forEach((s, i) => {
    const acc = accounts[i]!;
    if (s.status === 'fulfilled') results.push({ accountId: acc.id, value: s.value });
    else errors.push({ accountId: acc.id, account: acc.name, message: (s.reason as Error)?.message ?? String(s.reason) });
  });
  return { results, errors };
}
