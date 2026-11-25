/**
 * Dünne Hülle um das OpenSSL-CLI (cms/pkcs12). OpenSSL ist im Docker-Image
 * enthalten und deckt alle S/MIME-Varianten (inkl. Outlook-kompatibel) robust ab.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';

export class OpenSslError extends Error {
  constructor(
    message: string,
    public stderr: string,
    public code: number | null,
  ) {
    super(message);
  }
}

export function opensslAvailable(): boolean {
  try {
    return spawnSync(config.smime.opensslBin, ['version'], { timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

/** Führt openssl aus; `files` werden in ein temporäres Verzeichnis geschrieben ({name} im Argument ersetzt). */
export async function openssl(
  args: string[],
  files: Record<string, Buffer | string> = {},
  opts: { env?: Record<string, string>; outputs?: string[] } = {},
): Promise<{ stdout: Buffer; outputs: Record<string, Buffer>; stderr: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kuvert-smime-'));
  try {
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content, { mode: 0o600 });
    const resolved = args.map((a) => a.replace(/\{([\w.-]+)\}/g, (_, n: string) => path.join(dir, n)));
    const { stdout, stderr, code } = await new Promise<{ stdout: Buffer; stderr: string; code: number | null }>((resolve, reject) => {
      const p = spawn(config.smime.opensslBin, resolved, { env: { ...process.env, ...(opts.env ?? {}) } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on('data', (d: Buffer) => out.push(d));
      p.stderr.on('data', (d: Buffer) => err.push(d));
      p.on('error', reject);
      p.on('close', (c) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code: c }));
    });
    const outputs: Record<string, Buffer> = {};
    for (const name of opts.outputs ?? []) {
      try {
        outputs[name] = await fs.readFile(path.join(dir, name));
      } catch {
        /* nicht erzeugt */
      }
    }
    if (code !== 0) throw new OpenSslError(stderr.split('\n').find((l) => l.trim()) ?? `openssl Fehler (${code})`, stderr, code);
    return { stdout, outputs, stderr };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface CertDetails {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  emails: string[];
  pem: string;
}

/** Zerlegt eine PEM-Datei in einzelne Zertifikate. */
export function splitPem(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** Akzeptiert PEM oder DER und liefert PEM. */
export function toPem(data: Buffer): string {
  const text = data.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) return splitPem(text).join('\n') + '\n';
  return new X509Certificate(data).toString();
}

export function certDetails(pem: string): CertDetails {
  const x = new X509Certificate(pem);
  const emails = new Set<string>();
  for (const part of (x.subjectAltName ?? '').split(/,\s*/)) {
    const m = part.match(/^email:(.+)$/i);
    if (m) emails.add(m[1]!.trim().toLowerCase());
  }
  const subjMail = x.subject.match(/emailAddress=([^\n,]+)/i);
  if (subjMail) emails.add(subjMail[1]!.trim().toLowerCase());
  return {
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    fingerprint: x.fingerprint256,
    emails: [...emails],
    pem: x.toString(),
  };
}

/** Liest eine PKCS#12-Datei (.p12/.pfx) → Zertifikat, Schlüssel, Kette. */
export async function readPkcs12(p12: Buffer, password: string): Promise<{ certPem: string; keyPem: string; chainPem: string }> {
  const env = { KUVERT_P12_PASS: password };
  const run = async (extra: string[], legacy: boolean) =>
    (await openssl(['pkcs12', '-in', '{in.p12}', '-passin', 'env:KUVERT_P12_PASS', ...(legacy ? ['-legacy'] : []), ...extra], { 'in.p12': p12 }, { env }))
      .stdout.toString('utf8');
  let legacy = false;
  let keyPem: string;
  try {
    keyPem = await run(['-nocerts', '-nodes'], false);
  } catch (err) {
    // Ältere PFX-Dateien (RC2/3DES) benötigen unter OpenSSL 3 den Legacy-Provider
    legacy = true;
    try {
      keyPem = await run(['-nocerts', '-nodes'], true);
    } catch {
      throw new Error(`PKCS#12 konnte nicht gelesen werden (Passwort falsch?): ${(err as Error).message}`);
    }
  }
  const certPem = splitPem(await run(['-nokeys', '-clcerts'], legacy))[0];
  const chainPem = splitPem(await run(['-nokeys', '-cacerts'], legacy)).join('\n');
  const key = keyPem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/)?.[0];
  if (!certPem || !key) throw new Error('Die Datei enthält kein Zertifikat mit privatem Schlüssel');
  // Plausibilität: Schlüssel passt zum Zertifikat
  const pub = crypto.createPublicKey(certPem).export({ type: 'spki', format: 'der' });
  const fromKey = crypto.createPublicKey(crypto.createPrivateKey(key)).export({ type: 'spki', format: 'der' });
  if (!Buffer.from(pub).equals(Buffer.from(fromKey))) throw new Error('Privater Schlüssel passt nicht zum Zertifikat');
  return { certPem, keyPem: key + '\n', chainPem: chainPem ? chainPem + '\n' : '' };
}
