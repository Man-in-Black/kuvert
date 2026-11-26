import { lazy, Suspense } from 'react';
import { MessagesSquare } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { Spinner } from '@/components/ui';
import { useUnreadTotal } from './api';
import { ChatService } from './ChatService';
import { ChatSettingsSection } from './ChatSettingsSection';

const ChatPage = lazy(() => import('./ChatPage'));
const ChatPanel = lazy(() => import('./ChatPanel'));

/** Team-Chat zwischen Kuvert-Benutzern (Server-Modul "chat"). */
const mod: WebModule = {
  id: 'chat',
  feature: 'chat',
  nav: [{ path: 'chat', label: 'Chat', icon: MessagesSquare, order: 15, useBadge: useUnreadTotal }],
  routes: [
    {
      path: 'chat/*',
      element: (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <ChatPage />
        </Suspense>
      ),
    },
  ],
  sidePanels: [
    {
      id: 'chat',
      label: 'Chat',
      icon: MessagesSquare,
      order: 30,
      component: ChatPanel,
      defaultWidth: 400,
      keywords: 'chat team nachrichten unterhaltung',
      useBadge: useUnreadTotal,
    },
  ],
  settings: [{ id: 'chat', label: 'Chat', icon: MessagesSquare, order: 27, component: ChatSettingsSection }],
  services: [ChatService],
};

export default mod;
