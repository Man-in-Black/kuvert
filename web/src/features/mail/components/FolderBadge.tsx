import { Trash2 } from 'lucide-react';
import type { MailFolder } from '@kuvert/shared';
import { Badge } from '@/components/ui';
import { ROLE_LABELS } from '../api';

/** Herkunft einer Nachricht aus einem anderen Ordner (Gesendet, Archiv, Papierkorb …) */
export function FolderBadge({ folder, className }: { folder: MailFolder | undefined; className?: string }) {
  if (folder?.role === 'trash')
    return (
      <Badge tone="danger" className={className}>
        <Trash2 className="h-3 w-3" /> Gelöscht
      </Badge>
    );
  const label = folder ? (folder.role !== 'other' && ROLE_LABELS[folder.role]) || folder.name : 'Anderer Ordner';
  return (
    <Badge tone={folder?.role === 'sent' ? 'primary' : 'neutral'} className={className}>
      {label}
    </Badge>
  );
}
