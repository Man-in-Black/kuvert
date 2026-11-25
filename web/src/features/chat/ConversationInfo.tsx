import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, LogOut, Mail, MoreHorizontal, Shield, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import type { ChatConversation } from '@kuvert/shared';
import { Badge, Button, Dropdown, Field, Input, Modal, Spinner, Textarea, useConfirm } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { openCompose } from '@/features/mail/compose-api';
import { chatApi, chatKeys, conversationTitle, otherMember, patchConversations, replaceConversation, useChatUsers, useMe, useParticipants, useUserMap } from './api';
import { ConversationAvatar, UserAvatar, UserPicker } from './components';

export function ConversationInfo({ conversation: c, onClose }: { conversation: ChatConversation; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={c.kind === 'group' ? 'Gruppendetails' : 'Kontakt'} size="md">
      {c.source ? <ExternalInfo c={c} /> : c.kind === 'group' ? <GroupInfo c={c} onClose={onClose} /> : <DirectInfo c={c} />}
    </Modal>
  );
}

/** Unterhaltung aus Mattermost/Talk: nur anzeigen, verwaltet wird im Dienst selbst */
function ExternalInfo({ c }: { c: ChatConversation }) {
  const me = useMe();
  const users = useUserMap();
  const source = c.source!;
  const { data: members, isLoading, error } = useParticipants(c.id, c.kind === 'group');
  const other = c.kind === 'direct' ? users.get(otherMember(c, me) ?? '') : undefined;
  const sorted = [...(members ?? [])].sort((a, b) => Number(b.id === me) - Number(a.id === me) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'de'));

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        {other ? <UserAvatar user={other} size={88} /> : <ConversationAvatar conversation={c} users={users} me={me} size={72} />}
        <div>
          <div className="text-lg font-semibold">{conversationTitle(c, me, users)}</div>
          {other?.email && <div className="text-sm text-muted">{other.email}</div>}
          {c.description && <div className="mt-1 max-w-sm whitespace-pre-wrap text-sm">{c.description}</div>}
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            <Badge tone="info">{[source.label, source.context].filter(Boolean).join(' · ')}</Badge>
            {other && (other.online ? <Badge tone="success">Online</Badge> : <Badge>Offline</Badge>)}
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {source.webUrl && (
            <Button icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.open(source.webUrl!, '_blank', 'noopener,noreferrer')}>
              Im Original öffnen
            </Button>
          )}
          {other?.email && (
            <Button icon={<Mail className="h-4 w-4" />} onClick={() => openCompose({ to: [{ name: other.name, address: other.email }] })}>
              E-Mail schreiben
            </Button>
          )}
        </div>
      </div>

      {c.kind === 'group' && (
        <div>
          <div className="mb-2 text-sm font-semibold">{c.memberCount ?? members?.length ?? ''} Mitglieder</div>
          {isLoading ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : error ? (
            <div className="text-sm text-danger">{errorMessage(error)}</div>
          ) : (
            <div className="max-h-[min(50vh,360px)] divide-y divide-border overflow-auto rounded-xl border border-border">
              {sorted.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                  <UserAvatar user={u} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {u.name}
                      {u.id === me && <span className="font-normal text-muted"> (du)</span>}
                    </span>
                    {(u.email || u.jobTitle) && <span className="block truncate text-xs text-muted">{u.jobTitle || u.email}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted">Mitglieder, Name und Beschreibung werden direkt in {source.label} verwaltet.</p>
    </div>
  );
}

function DirectInfo({ c }: { c: ChatConversation }) {
  const me = useMe();
  const users = useUserMap();
  const u = users.get(otherMember(c, me) ?? '');
  if (!u) return <p className="text-sm text-muted">Dieser Benutzer existiert nicht mehr.</p>;
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <UserAvatar user={u} size={88} />
      <div>
        <div className="text-lg font-semibold">{u.name}</div>
        <div className="text-sm text-muted">{u.email}</div>
        {(u.jobTitle || u.department) && <div className="mt-1 text-sm">{[u.jobTitle, u.department].filter(Boolean).join(' · ')}</div>}
        <div className="mt-2">
          {u.disabled ? <Badge tone="danger">Gesperrt</Badge> : u.online ? <Badge tone="success">Online</Badge> : <Badge>Offline</Badge>}
        </div>
      </div>
      <Button icon={<Mail className="h-4 w-4" />} onClick={() => openCompose({ to: [{ name: u.name, address: u.email }] })}>
        E-Mail schreiben
      </Button>
    </div>
  );
}

function GroupInfo({ c, onClose }: { c: ChatConversation; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const users = useUserMap();
  const { data: allUsers } = useChatUsers();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(c.name ?? '');
  const [description, setDescription] = useState(c.description ?? '');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);
  const isOwner = c.myRole === 'owner';
  const dirty = name.trim() !== (c.name ?? '') || description.trim() !== (c.description ?? '');

  const run = async (fn: () => Promise<ChatConversation | unknown>) => {
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'members' in res) replaceConversation(qc, res as ChatConversation);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const save = async () => {
    setSaving(true);
    await run(() => chatApi.update(c.id, { name: name.trim(), description: description.trim() || null }));
    setSaving(false);
  };

  const leave = async () => {
    if (!(await confirm('Möchtest du die Gruppe wirklich verlassen? Du erhältst danach keine Nachrichten mehr.', { danger: true }))) return;
    if (!me || !(await run(() => chatApi.removeMember(c.id, me)))) return;
    patchConversations(qc, (l) => l.filter((x) => x.id !== c.id));
    qc.removeQueries({ queryKey: chatKeys.messages(c.id) });
    onClose();
    navigate('/chat');
  };

  const members = [...c.members].sort(
    (a, b) => Number(b.userId === me) - Number(a.userId === me) || Number(b.role === 'owner') - Number(a.role === 'owner') || (users.get(a.userId)?.name ?? '').localeCompare(users.get(b.userId)?.name ?? '', 'de'),
  );

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Field label="Gruppenname">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Beschreibung">
          <Textarea value={description} maxLength={500} rows={2} className="min-h-0" placeholder="Worum geht es in dieser Gruppe?" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {dirty && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
              Speichern
            </Button>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">{c.members.length} Mitglieder</div>
          <Button size="sm" variant={adding ? 'ghost' : 'soft'} icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding((a) => !a)}>
            {adding ? 'Abbrechen' : 'Hinzufügen'}
          </Button>
        </div>

        {adding ? (
          <div className="space-y-2">
            <UserPicker
              users={allUsers ?? []}
              exclude={c.members.map((m) => m.userId)}
              selected={toAdd}
              multi
              autoFocus
              onToggle={(id) => setToAdd((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                disabled={!toAdd.length}
                onClick={async () => {
                  if (await run(() => chatApi.addMembers(c.id, toAdd))) {
                    setToAdd([]);
                    setAdding(false);
                  }
                }}
              >
                {toAdd.length ? `${toAdd.length} hinzufügen` : 'Hinzufügen'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-xl border border-border">
            {members.map((m) => {
              const u = users.get(m.userId);
              const self = m.userId === me;
              return (
                <div key={m.userId} className="flex items-center gap-3 px-3 py-2">
                  <UserAvatar user={u} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {u?.name ?? 'Ehemaliger Benutzer'}
                      {self && <span className="font-normal text-muted"> (du)</span>}
                    </span>
                    <span className="block truncate text-xs text-muted">{u?.email}</span>
                  </span>
                  {m.role === 'owner' && <Badge tone="primary">Admin</Badge>}
                  {isOwner && !self && (
                    <Dropdown
                      align="right"
                      trigger={
                        <button type="button" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Aktionen">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      }
                      items={[
                        m.role === 'owner'
                          ? { label: 'Admin-Rechte entziehen', icon: <ShieldOff />, onClick: () => void run(() => chatApi.setRole(c.id, m.userId, 'member')) }
                          : { label: 'Zum Admin machen', icon: <Shield />, onClick: () => void run(() => chatApi.setRole(c.id, m.userId, 'owner')) },
                        {
                          label: 'Aus Gruppe entfernen',
                          icon: <UserMinus />,
                          danger: true,
                          onClick: async () => {
                            if (await confirm(`${u?.name ?? 'Dieses Mitglied'} aus der Gruppe entfernen?`, { danger: true })) {
                              if (await run(() => chatApi.removeMember(c.id, m.userId))) void qc.invalidateQueries({ queryKey: chatKeys.conversations });
                            }
                          },
                        },
                      ]}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-between border-t border-border pt-4">
        <Button variant="ghost" className="text-danger hover:bg-danger/10" icon={<LogOut className="h-4 w-4" />} onClick={() => void leave()}>
          Gruppe verlassen
        </Button>
      </div>
      {dialog}
    </div>
  );
}
