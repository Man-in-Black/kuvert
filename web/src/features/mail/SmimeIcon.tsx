import { Lock, Shield } from 'lucide-react';
import type { SmimeKind } from '@kuvert/shared';

/**
 * S/MIME-Hinweis für Listen: nur die Art laut MIME-Struktur – ob die Signatur gültig ist,
 * zeigt erst die geöffnete Nachricht.
 */
export function SmimeIcon({ kind }: { kind?: SmimeKind }) {
  if (kind === 'encrypted') {
    return (
      <span title="S/MIME-verschlüsselt" className="shrink-0 text-muted">
        <Lock className="h-3.5 w-3.5" aria-label="S/MIME-verschlüsselt" />
      </span>
    );
  }
  if (kind === 'signed') {
    return (
      <span title="S/MIME-signiert (Prüfung beim Öffnen)" className="shrink-0 text-muted">
        <Shield className="h-3.5 w-3.5" aria-label="S/MIME-signiert" />
      </span>
    );
  }
  return null;
}
