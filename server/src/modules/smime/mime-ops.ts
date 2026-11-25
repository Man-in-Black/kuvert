/**
 * S/MIME-Operationen auf MIME-Ebene: Signieren, Verschlüsseln, Prüfen, Entschlüsseln.
 */
import type { SecurityInfo } from '@kuvert/shared';
import { config } from '../../config.js';
import { BadRequestError } from '../../core/errors.js';
import { headerLines, splitHeaderBody } from '../../core/mime.js';
import { certDetails, openssl, OpenSslError, splitPem } from './openssl.js';
import { smimeStore } from './store.js';

/** Trennt eine Nachricht in äußere Header (From, To, …) und die innere MIME-Entität (Content-*). */
export function splitEntity(raw: Buffer): { outer: string[]; inner: Buffer } {
  const { headers, body } = splitHeaderBody(raw);
  const outer: string[] = [];
  const content: string[] = [];
  for (const line of headerLines(headers)) {
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    if (name.startsWith('content-')) content.push(line);
    else if (name !== 'mime-version') outer.push(line);
  }
  if (!content.length) content.push('Content-Type: text/plain; charset=utf-8');
  return { outer, inner: Buffer.concat([Buffer.from(content.join('\r\n') + '\r\n\r\n'), body]) };
}

function join(outer: string[], entity: Buffer): Buffer {
  return Buffer.concat([Buffer.from(outer.join('\r\n') + '\r\n'), entity]);
}

/**
 * Bringt alle Zeilenenden auf CRLF (kanonische Form nach RFC 8551 §3.1.1).
 * nodemailer übernimmt Zeilenumbrüche aus Text-/HTML-Inhalten unverändert in
 * quoted-printable-Teile – nackte LF würden mitsigniert, während jeder Prüfer
 * (OpenSSL, Outlook, Exchange) auf CRLF normalisiert: Die Prüfsumme passte nie.
 */
export function canonicalizeLineEndings(entity: Buffer): Buffer {
  return Buffer.from(entity.toString('latin1').replace(/\r\n|\r|\n/g, '\r\n'), 'latin1');
}

export async function signMessage(userId: string, raw: Buffer, fromAddress: string): Promise<Buffer> {
  const signer = smimeStore.signerFor(userId, fromAddress);
  if (!signer?.keyPem) throw new BadRequestError(`Kein gültiges S/MIME-Zertifikat mit privatem Schlüssel für ${fromAddress} hinterlegt`);
  const { outer, inner: entity } = splitEntity(raw);
  const inner = canonicalizeLineEndings(entity);
  const files: Record<string, string | Buffer> = { 'in.eml': inner, 'cert.pem': signer.certPem, 'key.pem': signer.keyPem };
  const args = ['cms', '-sign', '-in', '{in.eml}', '-signer', '{cert.pem}', '-inkey', '{key.pem}', '-md', 'sha256', '-outform', 'SMIME', '-binary', '-crlfeol'];
  if (signer.chainPem.trim()) {
    files['chain.pem'] = signer.chainPem;
    args.push('-certfile', '{chain.pem}');
  }
  const { stdout } = await openssl(args, files);
  return join(outer, stdout);
}

export async function encryptMessage(userId: string, raw: Buffer, recipients: string[], fromAddress: string): Promise<Buffer> {
  const all = [...new Set([...recipients, fromAddress].map((r) => r.toLowerCase()))];
  const certs: string[] = [];
  const missing: string[] = [];
  for (const r of all) {
    const pem = smimeStore.recipientCert(userId, r);
    if (pem) certs.push(pem);
    else if (r !== fromAddress.toLowerCase()) missing.push(r);
  }
  if (missing.length) {
    throw new BadRequestError(`Für folgende Empfänger liegt kein S/MIME-Zertifikat vor: ${missing.join(', ')}`, { missing });
  }
  const { outer, inner } = splitEntity(raw);
  const files: Record<string, string | Buffer> = { 'in.eml': inner };
  const certArgs = certs.map((pem, i) => {
    files[`r${i}.pem`] = pem;
    return `{r${i}.pem}`;
  });
  const { stdout } = await openssl(['cms', '-encrypt', '-aes-256-cbc', '-in', '{in.eml}', '-outform', 'SMIME', '-binary', '-crlfeol', ...certArgs], files);
  return join(outer, stdout);
}

function contentType(entity: Buffer): string {
  const { headers } = splitHeaderBody(entity);
  const line = headerLines(headers).find((l) => /^content-type\s*:/i.test(l)) ?? '';
  return line.replace(/\r?\n[ \t]+/g, ' ').toLowerCase();
}

/**
 * Verarbeitet eine eingehende S/MIME-Nachricht (auch verschachtelt: verschlüsselt + signiert).
 * Liefert die entschlüsselte/innere Nachricht inkl. äußerer Header und den Sicherheitsstatus.
 */
export async function processIncoming(userId: string, raw: Buffer, fromAddress?: string): Promise<{ message: Buffer; security: SecurityInfo }> {
  const security: SecurityInfo = {};
  const { outer } = splitEntity(raw);
  let current = raw;

  for (let depth = 0; depth < 4; depth++) {
    const ct = contentType(current);
    const isPkcs7Mime = ct.includes('pkcs7-mime');
    const isEnveloped = isPkcs7Mime && !ct.includes('signed-data');
    const isSigned = ct.includes('multipart/signed') || (isPkcs7Mime && ct.includes('signed-data'));

    if (isEnveloped) {
      security.encrypted = true;
      const own = smimeStore.ownWithKeys(userId);
      if (!own.length) {
        security.decrypted = false;
        security.error = 'Nachricht ist verschlüsselt, aber es ist kein eigenes S/MIME-Zertifikat hinterlegt';
        break;
      }
      let decrypted: Buffer | undefined;
      let lastError = '';
      for (const c of own) {
        try {
          decrypted = (
            await openssl(['cms', '-decrypt', '-in', '{msg.eml}', '-recip', '{cert.pem}', '-inkey', '{key.pem}'], {
              'msg.eml': current,
              'cert.pem': c.certPem,
              'key.pem': c.keyPem!,
            })
          ).stdout;
          break;
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      if (!decrypted) {
        security.decrypted = false;
        security.error = `Entschlüsselung fehlgeschlagen: ${lastError}`;
        break;
      }
      security.decrypted = true;
      current = decrypted;
      continue;
    }

    if (isSigned) {
      security.signed = true;
      const caPem = await trustAnchors(userId);
      const verify = (noVerify: boolean) =>
        openssl(
          ['cms', '-verify', '-in', '{msg.eml}', '-signer', '{signer.pem}', '-out', '{out.eml}', ...(noVerify ? ['-noverify'] : ['-CAfile', '{ca.pem}'])],
          noVerify ? { 'msg.eml': current } : { 'msg.eml': current, 'ca.pem': caPem },
          { outputs: ['signer.pem', 'out.eml'] },
        );
      let result: Awaited<ReturnType<typeof verify>> | undefined;
      let untrustedReason: string | undefined;
      try {
        result = await verify(false);
        security.signatureValid = true;
        security.trusted = true;
      } catch (err) {
        security.signatureValid = false;
        try {
          result = await verify(true);
          // Inhalt unverändert, aber Zertifikatskette nicht vertrauenswürdig
          security.trusted = false;
          untrustedReason = verifyFailureReason(err);
        } catch (err2) {
          // Auch ohne Kettenprüfung ungültig → Inhalt oder Signaturwert passt nicht
          security.error = `Signatur ungültig: ${verifyFailureReason(err2)}`;
          break;
        }
      }
      const signerPem = result?.outputs['signer.pem']?.toString('utf8');
      const first = signerPem ? splitPem(signerPem)[0] : undefined;
      const d = first ? certDetails(first) : undefined;
      if (untrustedReason) {
        const issuer = d?.issuer.match(/(?:^|, )CN=([^,]+)/)?.[1] ?? d?.issuer;
        security.error = `Signatur mathematisch gültig, aber Zertifikat nicht vertrauenswürdig: ${untrustedReason}${issuer ? ` (ausgestellt von ${issuer})` : ''}`;
      }
      if (first && d) {
        security.signer = d.emails[0] ?? fromAddress;
        security.signerCertSubject = d.subject;
        if (fromAddress && d.emails.length && !d.emails.includes(fromAddress.toLowerCase())) {
          security.signatureValid = false;
          delete security.trusted;
          security.error = `Zertifikat gehört zu ${d.emails.join(', ')}, nicht zum Absender ${fromAddress}`;
        }
        // Zertifikat für künftige verschlüsselte Antworten merken
        try {
          smimeStore.saveContact(userId, first, fromAddress);
        } catch {
          /* ignorieren */
        }
      }
      const out = result?.outputs['out.eml'];
      if (!out) break;
      current = out;
      continue;
    }
    break;
  }

  const { inner } = splitEntity(current);
  return { message: join([...outer, 'MIME-Version: 1.0'], inner), security };
}

const CERT_ERRORS: Record<string, string> = {
  'unable to get local issuer certificate': 'Ausstellende Zertifizierungsstelle unbekannt',
  'unable to get issuer certificate': 'Ausstellende Zertifizierungsstelle unbekannt',
  'self-signed certificate': 'selbst signiertes Zertifikat',
  'self signed certificate': 'selbst signiertes Zertifikat',
  'self-signed certificate in certificate chain': 'selbst signiertes Zertifikat in der Kette',
  'self signed certificate in certificate chain': 'selbst signiertes Zertifikat in der Kette',
  'certificate has expired': 'Zertifikat abgelaufen',
  'certificate is not yet valid': 'Zertifikat noch nicht gültig',
  'unsupported certificate purpose': 'Zertifikat ist nicht für E-Mail-Schutz zugelassen',
  'certificate revoked': 'Zertifikat widerrufen',
};

/**
 * Übersetzt die Ausgabe von "openssl cms -verify" in eine verständliche Ursache.
 * Die erste stderr-Zeile ("CMS Verification failure") sagt allein nichts aus.
 */
export function verifyFailureReason(err: unknown): string {
  const stderr = err instanceof OpenSslError ? err.stderr : String((err as Error)?.message ?? err);
  // Kettenfehler stehen am Zeilenende: "…:certificate verify error:<datei>:<zeile>:Verify error: <grund>"
  const certError = stderr.match(/:Verify error:\s*([^\n]+)/)?.[1]?.trim();
  if (certError) return CERT_ERRORS[certError.toLowerCase()] ?? certError;
  // Format: <tid>:error:<code>:<lib>:<funktion>:<grund>:<datei>:<zeile>:
  const errors = [...stderr.matchAll(/:error:[0-9A-F]+:[^:\n]*:([^:\n]*):([^:\n]*)/gi)].map((m) => ({ fn: m[1]!, reason: m[2]! }));
  if (errors.some((e) => /verify_content|digest/i.test(e.fn + e.reason))) {
    return 'Inhalt wurde nach dem Signieren verändert (Prüfsumme stimmt nicht überein)';
  }
  if (errors.some((e) => /SignerInfo_verify$/i.test(e.fn))) return 'Signaturwert passt nicht zum Zertifikat';
  const first = errors[0];
  if (first) return `${first.reason} (${first.fn})`;
  return stderr.split('\n').find((l) => l.trim()) ?? 'unbekannter Fehler';
}

let caCache: string | undefined;
/**
 * Globale Vertrauensanker: System-Bundle (TLS-Wurzeln) + Mozilla-Wurzeln mit E-Mail-Vertrauensbit
 * + optional eigene CAs aus SMIME_EXTRA_CA_FILE. Fehlende Dateien werden übersprungen.
 */
async function readCaBundle(): Promise<string> {
  if (caCache !== undefined) return caCache;
  const fs = await import('node:fs/promises');
  const parts: string[] = [];
  for (const file of [config.smime.caFile, config.smime.emailRootsFile, config.smime.extraCaFile]) {
    if (!file) continue;
    try {
      parts.push(...splitPem(await fs.readFile(file, 'utf8')));
    } catch {
      /* Datei fehlt – übrige Quellen genügen */
    }
  }
  if (!parts.length) {
    // Fallback: Node-eigene Root-Zertifikate
    const tls = await import('node:tls');
    parts.push(...tls.rootCertificates);
  }
  caCache = parts.join('\n') + '\n';
  return caCache;
}

/** Vertrauensanker für einen Benutzer: global + Wurzeln der eigenen importierten Zertifikatsketten. */
async function trustAnchors(userId: string): Promise<string> {
  const global = await readCaBundle();
  const own = smimeStore.ownChainRoots(userId);
  return own.length ? global + own.join('\n') + '\n' : global;
}
