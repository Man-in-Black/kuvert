import { Code2, LockKeyhole, UserRound } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { ProfileSection } from './ProfileSection';
import { SecuritySection } from './SecuritySection';
import { ApiSection } from './ApiSection';

/**
 * Persönliches Profil: Stammdaten & Avatar, Sicherheit (Passwort, 2FA, Geräte)
 * sowie API-Tokens und Webhooks – als Abschnitte in den Einstellungen.
 */
const mod: WebModule = {
  id: 'profile',
  settings: [
    { id: 'profile', label: 'Profil', icon: UserRound, order: 5, component: ProfileSection },
    { id: 'security', label: 'Sicherheit', icon: LockKeyhole, order: 85, component: SecuritySection },
    { id: 'api', label: 'API & Webhooks', icon: Code2, order: 88, component: ApiSection },
  ],
};

export default mod;
