import { BotMessageSquare, Sparkles } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { AiChatService } from './AiChatPanel';
import { AiComposerButton } from './AiComposerButton';
import { AiConversationActions } from './AiConversationActions';
import { AiMessageActions } from './AiMessageActions';
import { AiSettings } from './AiSettings';
import { toggleAiChat, useAiChat } from './chat-store';

/** KI-Assistent (Ollama): nur aktiv, wenn der Server das Feature "ai" meldet. */
const mod: WebModule = {
  id: 'ai',
  feature: 'ai',
  composerToolbar: [AiComposerButton],
  messageActions: [AiMessageActions],
  conversationActions: [AiConversationActions],
  actions: [
    {
      id: 'ai-chat',
      label: 'KI-Chat',
      icon: BotMessageSquare,
      order: 10,
      keywords: 'ki ai assistent fragen chat ollama llm',
      run: toggleAiChat,
      useActive: () => useAiChat().open,
    },
  ],
  services: [AiChatService],
  settings: [{ id: 'ai', label: 'KI-Assistent', icon: Sparkles, order: 70, component: AiSettings }],
};

export default mod;
