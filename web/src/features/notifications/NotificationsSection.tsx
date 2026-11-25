import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, Send } from 'lucide-react';
import type { UserSettings } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { useAppInfo, useFeature, useSettings, useUpdateSettings } from '@/lib/queries';
import { Badge, Button, Switch } from '@/components/ui';
import { Card, HelpBox, SavedIndicator, SectionHeader, SettingRow } from '@/features/settings/ui';
import { currentSubscription, permission, playBeep, pushSupported, requestPermission, showSystemNotification, subscribePush, unsubscribePush } from './push';

const PERMISSION_LABEL: Record<string, { text: string; color: string }> = {
  granted: { text: 'Erlaubt', color: 'var(--k-success)' },
  denied: { text: 'Blockiert', color: 'var(--k-danger)' },
  default: { text: 'Noch nicht gefragt', color: 'var(--k-warning)' },
  unsupported: { text: 'Nicht unterstützt', color: 'var(--k-muted)' },
};

export function NotificationsSection() {
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const { data: app } = useAppInfo();
  const pushFeature = useFeature('push');
  const [perm, setPerm] = useState(permission());
  const [saved, setSaved] = useState(0);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (pushFeature && pushSupported())
      currentSubscription()
        .then((s) => setSubscribed(!!s))
        .catch(() => setSubscribed(false));
  }, [pushFeature]);

  const setNotif = (patch: Partial<UserSettings['notifications']>) =>
    update.mutate(
      { notifications: { ...settings.notifications, ...patch } },
      { onSuccess: () => setSaved((n) => n + 1), onError: (err) => toast.error(errorMessage(err)) },
    );

  const ask = async () => {
    const p = await requestPermission();
    setPerm(p);
    if (p === 'granted') {
      void showSystemNotification('Kuvert', { body: 'Benachrichtigungen sind aktiviert.' }, '/settings/notifications');
    }
  };

  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    try {
      if (on) {
        await subscribePush(app?.vapidPublicKey);
        setSubscribed(true);
        setPerm(permission());
        toast.success('Push-Benachrichtigungen für dieses Gerät aktiviert');
      } else {
        await unsubscribePush();
        setSubscribed(false);
        toast.success('Push-Benachrichtigungen für dieses Gerät deaktiviert');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPushBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api('/notifications/test', { method: 'POST' });
      toast.success('Testbenachrichtigung gesendet');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const pl = PERMISSION_LABEL[perm] ?? PERMISSION_LABEL.unsupported!;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Benachrichtigungen"
        description="Hinweise auf neue E-Mails und anstehende Termine."
        actions={<SavedIndicator trigger={saved} />}
      />

      <Card title="Browser">
        <SettingRow label="Berechtigung im Browser" hint={perm === 'denied' ? 'In den Website-Einstellungen des Browsers wieder freigeben.' : undefined}>
          <div className="flex items-center justify-end gap-2 sm:justify-start">
            <Badge color={pl.color}>{pl.text}</Badge>
            {perm === 'default' && (
              <Button size="sm" variant="primary" icon={<BellRing className="h-3.5 w-3.5" />} onClick={ask}>
                Erlauben
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Desktop-Benachrichtigungen" hint="Für neue E-Mails, wenn Kuvert im Hintergrund ist">
          <Switch checked={settings.notifications.desktop} onChange={(v) => setNotif({ desktop: v })} />
        </SettingRow>
        <SettingRow label="Ton abspielen">
          <div className="flex items-center gap-3">
            <Switch checked={settings.notifications.sound} onChange={(v) => setNotif({ sound: v })} />
            <Button size="sm" variant="ghost" onClick={playBeep}>
              Probehören
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="Terminerinnerungen" hint="Erinnerung vor Beginn eines Termins (gemäß Erinnerungszeit des Termins)">
          <Switch checked={settings.notifications.calendarReminders} onChange={(v) => setNotif({ calendarReminders: v })} />
        </SettingRow>
        <p className="pt-3 text-xs text-muted">Pro Konto lassen sich Mail-Benachrichtigungen unter „Konten → Bearbeiten" abschalten.</p>
      </Card>

      {pushFeature && (
        <Card title="Push auf diesem Gerät" description="Benachrichtigungen auch dann, wenn kein Kuvert-Tab geöffnet ist (z. B. als installierte App).">
          {!pushSupported() ? (
            <HelpBox tone="warning">
              Dieser Browser unterstützt kein Web Push. Hinweis: Push erfordert HTTPS (oder localhost); auf iOS nur für zum Home-Bildschirm
              hinzugefügte Web-Apps.
            </HelpBox>
          ) : (
            <>
              <SettingRow label="Push-Benachrichtigungen">
                <Switch checked={!!subscribed} disabled={pushBusy || subscribed === null} onChange={togglePush} />
              </SettingRow>
              <div className="pt-3">
                <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={testing} onClick={test}>
                  Test senden
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
