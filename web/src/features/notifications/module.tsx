import { Bell } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { NotificationService } from './NotificationService';
import { NotificationsSection } from './NotificationsSection';

/** Desktop-/Push-Benachrichtigungen für neue Mails, Termine und Kontoprobleme. */
const mod: WebModule = {
  id: 'notifications',
  services: [NotificationService],
  settings: [{ id: 'notifications', label: 'Benachrichtigungen', icon: Bell, order: 25, component: NotificationsSection }],
};

export default mod;
