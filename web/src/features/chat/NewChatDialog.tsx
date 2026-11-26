import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import type { ChatUser } from '@kuvert/shared';
import { Button, Field, Input, Modal, Select, Spinner, Tabs } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { chatApi, replaceConversation, useChatUsers, useConnections, useMe, useRemoteUsers, useUserMap } from './api';
import { UserPicker } from './components';

export type NewChatMode = 'direct' | 'group';

export function NewChatDialog({
  mode: initialMode,
  onClose,
  onCreated,
}: {
  mode: NewChatMode;
  onClose: () => void;
  /** Statt zur Chat-Seite zu wechseln (z. B. im Panel der Seitenleiste) */
  onCreated?: (conversationId: string) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const users = useUserMap();
  const { data: all, isLoading } = useChatUsers();
  const { data: connections } = useConnections();
  const [mode, setMode] = useState<NewChatMode>(initialMode);
  /** '' = Kuvert-Chat, sonst ID der Verbindung (Mattermost/Talk) */
  const [connectionId, setConnectionId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  /** Namen ausgewählter Personen eines Dienstes (stehen nicht im Kuvert-Verzeichnis) */
  const [picked, setPicked] = useState<Map<string, ChatUser>>(new Map());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const connection = connections?.find((c) => c.id === connectionId) ?? null;
  const [remoteQ, setRemoteQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(remoteQ.trim()), 300);
    return () => clearTimeout(t);
  }, [remoteQ]);
  const remote = useRemoteUsers(connection ? connection.id : null, debounced);

  const open = async (fn: () => ReturnType<typeof chatApi.openDirect>) => {
    setBusy(true);
    try {
      const conv = await fn();
      replaceConversation(qc, conv);
      onClose();
      if (onCreated) onCreated(conv.id);
      else navigate(`/chat/${conv.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSelected([]);
    setPicked(new Map());
  };

  const toggle = (u: ChatUser) => {
    if (mode === 'direct') {
      if (!busy) void open(() => chatApi.openDirect(u.id, connection?.id));
      return;
    }
    setPicked((m) => new Map(m).set(u.id, u));
    setSelected((s) => (s.includes(u.id) ? s.filter((x) => x !== u.id) : [...s, u.id]));
  };

  const nameOf = (id: string) => picked.get(id)?.name ?? users.get(id)?.name ?? id;

  return (
    <Modal
      open
      onClose={onClose}
      title="Neue Unterhaltung"
      size="md"
      footer={
        mode === 'group' ? (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !selected.length}
              onClick={() => void open(() => chatApi.createGroup(name.trim(), selected, undefined, connection?.id))}
            >
              Gruppe erstellen
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <Tabs
          value={mode}
          onChange={(m) => {
            setMode(m);
            reset();
          }}
          tabs={[
            { value: 'direct', label: 'Direktnachricht' },
            { value: 'group', label: 'Gruppe' },
          ]}
        />

        {!!connections?.length && (
          <Field label="Dienst">
            <Select
              value={connectionId}
              onChange={(e) => {
                setConnectionId(e.target.value);
                setRemoteQ('');
                reset();
              }}
            >
              <option value="">Kuvert-Chat</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'group' && (
          <>
            <Field
              label={connection?.type === 'mattermost' ? 'Kanalname' : 'Gruppenname'}
              hint={
                connection?.type === 'mattermost'
                  ? 'Wird als privater Kanal in deinem ersten Mattermost-Team angelegt'
                  : connection?.type === 'teams'
                    ? 'Teams-Gruppenchat mit mindestens zwei weiteren Personen'
                    : undefined
              }
            >
              <Input value={name} maxLength={80} placeholder="z. B. Projekt Phoenix" onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary">
                    {nameOf(id)}
                    <button type="button" className="rounded-full p-0.5 hover:bg-primary/15" onClick={() => setSelected((s) => s.filter((x) => x !== id))} aria-label="Entfernen">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {connection ? (
          <div className="space-y-2">
            <Input
              placeholder={`Personen in ${connection.label} suchen`}
              value={remoteQ}
              onChange={(e) => setRemoteQ(e.target.value)}
              autoFocus={mode === 'direct'}
            />
            {remote.isFetching && !remote.data ? (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            ) : remote.error ? (
              <div className="p-3 text-sm text-danger">{errorMessage(remote.error)}</div>
            ) : debounced ? (
              <UserPicker users={remote.data ?? []} selected={selected} multi={mode === 'group'} onToggle={(id) => toggle((remote.data ?? []).find((u) => u.id === id)!)} hideSearch />
            ) : (
              <div className="rounded-xl border border-border p-6 text-center text-sm text-muted">Namen eingeben, um Personen zu finden</div>
            )}
          </div>
        ) : isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <UserPicker
            users={all ?? []}
            exclude={me ? [me] : []}
            selected={selected}
            multi={mode === 'group'}
            autoFocus={mode === 'direct'}
            onToggle={(id) => {
              const u = (all ?? []).find((x) => x.id === id);
              if (u) toggle(u);
            }}
          />
        )}
      </div>
    </Modal>
  );
}
