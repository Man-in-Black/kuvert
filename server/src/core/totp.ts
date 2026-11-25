/**
 * TOTP (RFC 6238) für die Zwei-Faktor-Authentifizierung – kompatibel mit
 * Google Authenticator, Microsoft Authenticator, Aegis, 1Password, Bitwarden …
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentCounter(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP);
}

/**
 * Prüft einen Code (±1 Zeitfenster Toleranz). Liefert den verwendeten Zähler,
 * damit derselbe Code nicht zweimal verwendet werden kann (Replay-Schutz).
 */
export function verifyTotp(secretB32: string, code: string, lastUsedCounter = 0): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const now = currentCounter();
  for (const delta of [0, -1, 1]) {
    const counter = now + delta;
    if (counter <= lastUsedCounter) continue;
    const expected = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return counter;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Erzeugt Wiederherstellungscodes im Format xxxxx-xxxxx */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toLowerCase().replace(/\s/g, '')).digest('hex');
}
