import crypto from 'node:crypto';
import { config } from '../config.js';

/** Schlüssel für die Verschlüsselung von Zugangsdaten/Tokens in der Datenbank. */
const KEY = crypto.hkdfSync('sha256', Buffer.from(config.appSecret), Buffer.from('kuvert-salt'), Buffer.from('secrets-v1'), 32);

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Ungültiges Chiffrat');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value ?? {}));
}

export function decryptJson<T = Record<string, unknown>>(payload: string | null | undefined): T {
  if (!payload) return {} as T;
  return JSON.parse(decrypt(payload)) as T;
}

/* ─────────────────────────── Passwort-Hashing (scrypt) ─────────────────────────── */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(
      password,
      Buffer.from(saltB64, 'base64'),
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p) },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
  return crypto.timingSafeEqual(expected, actual);
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uuid(): string {
  return crypto.randomUUID();
}
