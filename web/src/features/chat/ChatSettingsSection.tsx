import { useState } from 'react';
import { toast } from 'sonner';
import type { ChatSettings } from '@kuvert/shared';
import { Switch } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { Card, HelpBox, SavedIndicator, SectionHeader, SettingRow } from '@/features/settings/ui';
import { useFeature } from '@/lib/queries';
import { useChatSettings } from './api';
import { ChatConnections } from './ChatConnections';

export function ChatSettingsSection() {
  const { settings, update } = useChatSettings();
  const bridges = useFeature('chatBridges');
  const [saved, setSaved] = useState(0);

  const set = (patch: Partial<ChatSettings>) =>
    update(patch)
      .then(() => setSaved((n) => n + 1))
      .catch((err) => toast.error(errorMessage(err)));

  return (
    <div className="max-w-3xl">
      <SectionHeader title="Chat" description="Benachrichtigungen, Bedienung und verbundene Dienste des Team-Chats." actions={<SavedIndicator trigger={saved} />} />
      <div className="space-y-5">
        <Card title="Benachrichtigungen">
          <SettingRow label="Bei neuen Nachrichten benachrichtigen" hint="Hinweis im offenen Tab, Desktop-Benachrichtigung bei verborgenem oder nicht aktivem Fenster und Web Push bei geschlossenem Tab">
            <Switch checked={settings.notify} onChange={(v) => set({ notify: v })} />
          </SettingRow>
          <SettingRow label="Ton abspielen" hint="Kurzer Signalton bei neuen Nachrichten">
            <Switch checked={settings.sound} disabled={!settings.notify} onChange={(v) => set({ sound: v })} />
          </SettingRow>
          <div className="mt-3">
            <HelpBox>
              Einzelne Unterhaltungen lassen sich über das Glockensymbol im Chat stummschalten. Desktop- und Push-Benachrichtigungen
              müssen unter <strong>Einstellungen → Benachrichtigungen</strong> im Browser erlaubt sein.
            </HelpBox>
          </div>
        </Card>
        <Card title="Eingabe">
          <SettingRow label="Enter sendet die Nachricht" hint={settings.enterToSend ? 'Umschalt+Enter fügt eine neue Zeile ein' : 'Senden mit Strg/⌘+Enter, Enter fügt eine neue Zeile ein'}>
            <Switch checked={settings.enterToSend} onChange={(v) => set({ enterToSend: v })} />
          </SettingRow>
        </Card>
        {bridges && <ChatConnections />}
      </div>
    </div>
  );
}
