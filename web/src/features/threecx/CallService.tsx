/**
 * Unsichtbarer Dienst: meldet eingehende 3CX-Anrufe an der eigenen Nebenstelle (Ereignis
 * "threecx.call") als Hinweis, Systembenachrichtigung und Ton – und verpasste Anrufe mit
 * „Zurückrufen“ über Click-to-Call. Ob überhaupt gemeldet wird, entscheidet der Server
 * (Einstellungen → Telefonie).
 */
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ThreeCxIncomingCall } from '@kuvert/shared';
import { useServerEvent } from '@/lib/events';
import { useSettings } from '@/lib/queries';
import { playBeep, pushActiveHere, showSystemNotification } from '@/features/notifications/push';
import { bumpUnseen, registerUnseenCategory } from '@/features/notifications/unseen';
import { callViaThreeCx, tk } from './api';

registerUnseenCategory({ id: 'calls', label: 'Verpasste Anrufe (3CX)', feature: 'threecx', order: 25 });

/** Klingeln: alle 1,6 s ein Ton, bis angenommen, vorbei oder höchstens 30 s */
const ringing = new Map<string, number>();

function stopRinging(key: string) {
  const t = ringing.get(key);
  if (t !== undefined) window.clearInterval(t);
  ringing.delete(key);
}

function startRinging(key: string) {
  stopRinging(key);
  playBeep();
  const started = Date.now();
  const t = window.setInterval(() => {
    if (Date.now() - started > 30_000) stopRinging(key);
    else playBeep();
  }, 1600);
  ringing.set(key, t);
}

function who(c: ThreeCxIncomingCall): string {
  return c.name ?? c.number ?? 'Unbekannt';
}

/** Zweite Zeile: Nummer (wenn ein Name da ist), Firma, Warteschlange/Ringgruppe */
function details(c: ThreeCxIncomingCall): string {
  return [c.name ? c.number : null, c.company, c.internal ? 'intern' : null, c.via ? `über ${c.via}` : null].filter(Boolean).join(' · ');
}

export function CallService() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { settings } = useSettings();

  useServerEvent('threecx.call', (e) => {
    const c = e.call;
    const toastId = `threecx-${c.key}`;
    const url = '/phone';
    // Laufende Gespräche und Anrufliste im Bereich „Telefon“ auffrischen
    void qc.invalidateQueries({ queryKey: tk.active });

    if (c.state === 'answered' || c.state === 'ended') {
      stopRinging(c.key);
      toast.dismiss(toastId);
      if (c.state === 'ended') void qc.invalidateQueries({ queryKey: ['threecx', 'log'] });
      return;
    }

    const missed = c.state === 'missed';
    if (missed) {
      stopRinging(c.key);
      void qc.invalidateQueries({ queryKey: ['threecx', 'log'] });
      bumpUnseen('calls');
    }
    const title = missed ? `Verpasster Anruf von ${who(c)}` : `📞 ${who(c)} ruft an`;
    const body = details(c) || (missed ? 'Zum Zurückrufen öffnen' : 'Eingehender Anruf');

    // Systembenachrichtigung, wenn man das Fenster nicht im Blick hat; mit Web Push auf diesem
    // Gerät zeigt sie bei verborgenem Fenster der Service Worker (sonst doppelt)
    if (settings.notifications.desktop) {
      const opts = { body, tag: toastId, requireInteraction: !missed };
      if (document.hidden) {
        void pushActiveHere().then((push) => {
          if (!push) void showSystemNotification(title, opts, url, () => navigate(url));
        });
      } else if (!document.hasFocus()) void showSystemNotification(title, opts, url, () => navigate(url));
    }

    const callBack = c.number ? () => void callViaThreeCx(c.number!) : null;
    toast(title, {
      id: toastId,
      description: body,
      duration: missed ? 60_000 : 45_000,
      action: missed && callBack ? { label: 'Zurückrufen', onClick: callBack } : { label: 'Telefon', onClick: () => navigate(url) },
    });
    if (!missed && settings.notifications.sound) startRinging(c.key);
    else if (missed && settings.notifications.sound) playBeep();
  });

  return null;
}
