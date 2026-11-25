import type { SmimeCertInfo } from '@kuvert/shared';
import { getDb } from '../../core/db.js';
import { decrypt, encrypt, uuid } from '../../core/crypto.js';
import { X509Certificate } from 'node:crypto';
import { certDetails, splitPem } from './openssl.js';

export const migrations = [
  {
    id: 'smime-001',
    sql: `
      CREATE TABLE smime_certs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL COLLATE NOCASE,
        emails_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        issuer TEXT NOT NULL,
        not_before TEXT NOT NULL,
        not_after TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        cert_pem TEXT NOT NULL,
        chain_pem TEXT NOT NULL DEFAULT '',
        key_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE smime_contacts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL COLLATE NOCASE,
        subject TEXT NOT NULL,
        not_after TEXT NOT NULL,
        cert_pem TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, email)
      );
    `,
  },
];

interface CertRow {
  id: string;
  email: string;
  emails_json: string;
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  fingerprint: string;
  cert_pem: string;
  chain_pem: string;
  key_enc: string | null;
}

export interface OwnCert {
  id: string;
  emails: string[];
  certPem: string;
  chainPem: string;
  keyPem?: string;
  notAfter: string;
}

const toInfo = (r: CertRow): SmimeCertInfo => ({
  id: r.id,
  email: r.email,
  subject: r.subject,
  issuer: r.issuer,
  notBefore: r.not_before,
  notAfter: r.not_after,
  fingerprint: r.fingerprint,
  hasPrivateKey: !!r.key_enc,
});

export const smimeStore = {
  list(userId: string): SmimeCertInfo[] {
    return (getDb().prepare('SELECT * FROM smime_certs WHERE user_id = ? ORDER BY not_after DESC').all(userId) as CertRow[]).map(toInfo);
  },

  add(userId: string, certPem: string, keyPem: string | null, chainPem: string): SmimeCertInfo {
    const d = certDetails(certPem);
    const id = uuid();
    getDb()
      .prepare(
        `INSERT INTO smime_certs (id, user_id, email, emails_json, subject, issuer, not_before, not_after, fingerprint, cert_pem, chain_pem, key_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, d.emails[0] ?? '', JSON.stringify(d.emails), d.subject, d.issuer, d.notBefore, d.notAfter, d.fingerprint, d.pem, chainPem, keyPem ? encrypt(keyPem) : null);
    return toInfo(getDb().prepare('SELECT * FROM smime_certs WHERE id = ?').get(id) as CertRow);
  },

  delete(userId: string, id: string) {
    getDb().prepare('DELETE FROM smime_certs WHERE id = ? AND user_id = ?').run(id, userId);
  },

  /** Eigene Zertifikate mit Schlüssel (für Signieren/Entschlüsseln) */
  ownWithKeys(userId: string): OwnCert[] {
    return (getDb().prepare('SELECT * FROM smime_certs WHERE user_id = ? AND key_enc IS NOT NULL ORDER BY not_after DESC').all(userId) as CertRow[]).map((r) => ({
      id: r.id,
      emails: JSON.parse(r.emails_json) as string[],
      certPem: r.cert_pem,
      chainPem: r.chain_pem,
      keyPem: r.key_enc ? decrypt(r.key_enc) : undefined,
      notAfter: r.not_after,
    }));
  },

  /**
   * Wurzelzertifikate aus den Ketten der eigenen, selbst importierten Zertifikate.
   * Gelten als Vertrauensanker für eingehende Signaturen – so werden z. B. Mails von
   * Kollegen mit Zertifikaten derselben (auch firmeninternen) CA als vertrauenswürdig erkannt.
   */
  ownChainRoots(userId: string): string[] {
    const rows = getDb().prepare('SELECT chain_pem FROM smime_certs WHERE user_id = ?').all(userId) as { chain_pem: string }[];
    const roots = new Map<string, string>();
    for (const pem of rows.flatMap((r) => splitPem(r.chain_pem))) {
      try {
        const x = new X509Certificate(pem);
        if (x.ca && x.checkIssued(x) && x.verify(x.publicKey)) roots.set(x.fingerprint256, x.toString());
      } catch {
        /* unlesbares Zertifikat überspringen */
      }
    }
    return [...roots.values()];
  },

  /** Passendes gültiges Signaturzertifikat für eine Absenderadresse */
  signerFor(userId: string, address: string): OwnCert | undefined {
    const now = new Date().toISOString();
    const a = address.toLowerCase();
    return this.ownWithKeys(userId).find((c) => c.notAfter > now && c.emails.includes(a));
  },

  /* ───────────── Empfänger-Zertifikate ───────────── */

  contacts(userId: string): { email: string; subject: string; notAfter: string }[] {
    return (
      getDb().prepare('SELECT email, subject, not_after FROM smime_contacts WHERE user_id = ? ORDER BY email').all(userId) as {
        email: string;
        subject: string;
        not_after: string;
      }[]
    ).map((r) => ({ email: r.email, subject: r.subject, notAfter: r.not_after }));
  },

  saveContact(userId: string, certPem: string, fallbackEmail?: string): string[] {
    const d = certDetails(certPem);
    const emails = d.emails.length ? d.emails : fallbackEmail ? [fallbackEmail.toLowerCase()] : [];
    const stmt = getDb().prepare(
      `INSERT INTO smime_contacts (user_id, email, subject, not_after, cert_pem) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, email) DO UPDATE SET subject = excluded.subject, not_after = excluded.not_after,
         cert_pem = excluded.cert_pem, updated_at = datetime('now')
       WHERE excluded.not_after >= smime_contacts.not_after`,
    );
    for (const e of emails) stmt.run(userId, e, d.subject, d.notAfter, d.pem);
    return emails;
  },

  deleteContact(userId: string, email: string) {
    getDb().prepare('DELETE FROM smime_contacts WHERE user_id = ? AND email = ?').run(userId, email);
  },

  /** Öffentliches Zertifikat für eine Empfängeradresse (eigene oder gesammelte) */
  recipientCert(userId: string, address: string): string | undefined {
    const now = new Date().toISOString();
    const row = getDb()
      .prepare('SELECT cert_pem FROM smime_contacts WHERE user_id = ? AND email = ? AND not_after > ?')
      .get(userId, address, now) as { cert_pem: string } | undefined;
    if (row) return row.cert_pem;
    const own = (getDb().prepare('SELECT cert_pem, emails_json, not_after FROM smime_certs WHERE user_id = ?').all(userId) as {
      cert_pem: string;
      emails_json: string;
      not_after: string;
    }[]).find((c) => c.not_after > now && (JSON.parse(c.emails_json) as string[]).includes(address.toLowerCase()));
    return own?.cert_pem;
  },
};
