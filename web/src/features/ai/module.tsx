import { lazy } from 'react';
import { BotMessageSquare, Sparkles } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { AiComposerButton } from './AiComposerButton';
import { AiConversationActions } from './AiConversationActions';
import { AiMessageActions } from './AiMessageActions';
import { AiSettings } from './AiSettings';
import { AI_PANEL_ID } from './chat-store';

const AiChatPanel = lazy(() => import('./AiChatPanel'));

/** KI-Assistent (Ollama): nur aktiv, wenn der Server das Feature "ai" meldet. */
const mod: WebModule = {
  id: 'ai',
  feature: 'ai',
  composerToolbar: [AiComposerButton],
  messageActions: [AiMessageActions],
  conversationActions: [AiConversationActions],
  sidePanels: [
    {
      id: AI_PANEL_ID,
      label: 'KI-Chat',
      actionLabel: 'KI-Chat',
      icon: BotMessageSquare,
      order: 40,
      component: AiChatPanel,
      defaultWidth: 440,
      keywords: 'ki ai assistent fragen chat ollama llm',
    },
  ],
  settings: [{ id: 'ai', label: 'KI-Assistent', icon: Sparkles, order: 70, component: AiSettings }],
};

export default mod;
