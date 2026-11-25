import { Archive, File, Folder, Inbox, Send, ShieldAlert, Trash2, Upload } from 'lucide-react';
import type { FolderRole } from '@kuvert/shared';

export function FolderIcon({ role, className }: { role: FolderRole; className?: string }) {
  switch (role) {
    case 'inbox':
      return <Inbox className={className} />;
    case 'sent':
      return <Send className={className} />;
    case 'drafts':
      return <File className={className} />;
    case 'trash':
      return <Trash2 className={className} />;
    case 'junk':
      return <ShieldAlert className={className} />;
    case 'archive':
      return <Archive className={className} />;
    case 'outbox':
      return <Upload className={className} />;
    default:
      return <Folder className={className} />;
  }
}
