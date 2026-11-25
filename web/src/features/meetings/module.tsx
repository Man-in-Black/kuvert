import type { WebModule } from '@/modules/types';
import { MeetingButton } from './MeetingButton';

/** Online-Meetings (Teams/Meet) – aktiv, sobald ein Konto Meetings unterstützt. */
const mod: WebModule = {
  id: 'meetings',
  isActive: ({ accounts }) => accounts.some((a) => a.enabled && a.capabilities.includes('meetings')),
  composerToolbar: [MeetingButton],
};

export default mod;
