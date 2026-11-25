/**
 * Aktualisiert server/assets/smime-roots.pem aus der CCADB:
 * alle Wurzelzertifikate des Mozilla-Programms mit Vertrauensbit "E-Mail-Schutz".
 *
 *   npm run update-smime-roots --workspace server
 */
import fs from 'node:fs/promises';

const SOURCE = 'https://ccadb.my.salesforce-sites.com/mozilla/IncludedRootsPEMTxt?TrustBitsInclude=Email';
const target = new URL('../assets/smime-roots.pem', import.meta.url);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`CCADB antwortet mit ${res.status}`);
const certs = (await res.text()).replace(/\r/g, '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (certs.length < 20) throw new Error(`Nur ${certs.length} Zertifikate erhalten – Abbruch`);

const header = [
  '# Mozilla-Root-Zertifikate mit Vertrauensbit "E-Mail-Schutz" (S/MIME)',
  `# Quelle: ${SOURCE}`,
  `# Stand: ${new Date().toISOString().slice(0, 10)} – aktualisieren mit: npm run update-smime-roots --workspace server`,
  '# Ergänzt das Debian-Bundle /etc/ssl/certs/ca-certificates.crt, das nur TLS-Wurzeln enthält.',
  '',
  '',
].join('\n');
await fs.writeFile(target, header + certs.join('\n\n') + '\n');
console.log(`${certs.length} Wurzelzertifikate geschrieben → ${target.pathname}`);
