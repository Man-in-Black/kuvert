/**
 * Team-Chat als Panel der Seitenleiste rechts: Unterhaltungsliste und – nach Auswahl – die
 * Unterhaltung selbst (dieselben Bausteine wie die Chat-Seite). Die offene Unterhaltung
 * bleibt beim Wechsel der Reiter erhalten.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Maximize2 } from 'lucide-react';
import type { ChatConversation } from '@kuvert/shared';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { IconButton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/useIsMobile';
import { closeSidePanel, isSidebarPinned } from '@/layout/side-panel-store';
import { replaceConversation, useConversations } from './api';
import { ConversationList } from './ChatPage';
import { ConversationView } from './ConversationView';
import { NewChatDialog, type NewChatMode } from './NewChatDialog';

/** Zuletzt offene Unterhaltung im Panel (überlebt das Wechseln der Reiter) */
let lastOpen: string | null = null;

export default function ChatPanel() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const qc = useQueryClient();
  const [openId, setOpenIdState] = useState<string | null>(lastOpen);
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  const [newChat, setNewChat] = useState<NewChatMode | null>(null);
  const { data: list, isLoading, error } = useConversations();

  const setOpenId = (id: string | null, seq?: number) => {
    lastOpen = id;
    setOpenIdState(id);
    setJumpSeq(seq ?? null);
  };

  // Unterhaltung nicht in der Liste (z. B. leere Direktnachricht eines anderen) → einzeln laden
  const fromList = list?.find((c) => c.id === openId);
  const single = useQuery({
    queryKey: ['chat', 'conversation', openId],
    queryFn: () => api<ChatConversation>(`/chat/conversations/${openId}`),
    enabled: !!openId && !!list && !fromList,
    retry: false,
  });
  useEffect(() => {
    if (single.data && !fromList) replaceConversation(qc, single.data);
  }, [single.data, fromList, qc]);
  // Nicht mehr Mitglied o. Ä. → zurück zur Liste
  useEffect(() => {
    if (single.isError) setOpenId(null);
  }, [single.isError]);
  const conversation = fromList ?? single.data ?? null;

  const openFull = () => {
    navigate(openId ? `/chat/${openId}` : '/chat');
    if (mobile || !isSidebarPinned()) closeSidePanel();
  };

  return (
    <>
      <div className="min-h-0 flex-1">
        {conversation ? (
          <ErrorBoundary key={conversation.id} label="Unterhaltung">
            <ConversationView conversation={conversation} onBack={() => setOpenId(null)} jumpSeq={jumpSeq} onJumpDone={() => setJumpSeq(null)} />
          </ErrorBoundary>
        ) : openId && (isLoading || single.isLoading) ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <ConversationList
            list={list}
            loading={isLoading}
            error={error}
            activeId={openId}
            onNew={setNewChat}
            onOpen={(id, seq) => setOpenId(id, seq)}
            headerExtra={
              <IconButton label="Im Chat öffnen" onClick={openFull}>
                <Maximize2 className="h-4 w-4" />
              </IconButton>
            }
          />
        )}
      </div>
      {newChat && <NewChatDialog mode={newChat} onClose={() => setNewChat(null)} onCreated={(id) => setOpenId(id)} />}
    </>
  );
}
