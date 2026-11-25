import type { Contact } from '@kuvert/shared';

/** Escaping gemäß RFC 6350 */
function esc(s: string | undefined | null): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** Erzeugt eine vCard 3.0 (breiteste Kompatibilität). */
export function toVCard(c: Contact): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`N:${esc(c.lastName)};${esc(c.firstName)};;;`);
  lines.push(`FN:${esc(c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' '))}`);
  if (c.company || c.department) lines.push(`ORG:${esc(c.company)}${c.department ? `;${esc(c.department)}` : ''}`);
  if (c.jobTitle) lines.push(`TITLE:${esc(c.jobTitle)}`);
  for (const e of c.emails) lines.push(`EMAIL;TYPE=INTERNET${e.type ? `,${e.type.toUpperCase()}` : ''}:${esc(e.address)}`);
  for (const p of c.phones) {
    const t = p.type === 'mobile' ? 'CELL' : p.type?.toUpperCase();
    lines.push(`TEL${t ? `;TYPE=${t}` : ''}:${esc(p.number)}`);
  }
  for (const a of c.addresses ?? []) {
    lines.push(
      `ADR${a.type ? `;TYPE=${a.type.toUpperCase()}` : ''}:;;${esc(a.street)};${esc(a.city)};${esc(a.region)};${esc(a.postalCode)};${esc(a.country)}`,
    );
  }
  if (c.birthday) lines.push(`BDAY:${c.birthday.slice(0, 10)}`);
  if (c.website) lines.push(`URL:${esc(c.website)}`);
  if (c.notes) lines.push(`NOTE:${esc(c.notes)}`);
  lines.push('END:VCARD');
  // Zeilen > 75 Zeichen falten
  return (
    lines
      .map((l) => {
        if (l.length <= 75) return l;
        const out: string[] = [l.slice(0, 75)];
        for (let i = 75; i < l.length; i += 74) out.push(' ' + l.slice(i, i + 74));
        return out.join('\r\n');
      })
      .join('\r\n') + '\r\n'
  );
}

export function downloadVCard(c: Contact) {
  const blob = new Blob([toVCard(c)], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(c.displayName || 'kontakt').replace(/[^\p{L}\p{N} _.-]/gu, '_')}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
