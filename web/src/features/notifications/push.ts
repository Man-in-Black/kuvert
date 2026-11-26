/** Hilfsfunktionen für Desktop-Benachrichtigungen, Ton und Web Push. */
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.requestPermission();
}

/* ───────────── Systembenachrichtigung ───────────── */

/** Icons für Benachrichtigungen (Android kann dort kein SVG; das Badge erscheint einfarbig in der Statusleiste) */
export const NOTIFICATION_ICON = '/icon-192.png';
export const NOTIFICATION_BADGE = '/badge-96.png';

/**
 * Hat dieses Gerät Web Push abonniert? Dann schickt der Server zu neuen Mails, Chats und Terminen
 * ohnehin einen Push, und der Service Worker zeigt ihn an, sobald kein Kuvert-Fenster sichtbar ist –
 * ein verborgener Tab soll dann keine zweite Benachrichtigung erzeugen.
 */
export async function pushActiveHere(): Promise<boolean> {
  try {
    return !!(await currentSubscription());
  } catch {
    return false;
  }
}

/**
 * Systembenachrichtigung aus einem (verborgenen) Tab. Bevorzugt über den Service Worker – auf Android
 * gibt es den Notification-Konstruktor nicht; ein Klick öffnet dann `url` (siehe sw.js).
 */
export async function showSystemNotification(title: string, opts: NotificationOptions, url: string, onClick?: () => void): Promise<boolean> {
  // Desktop-App ab 1.1.0: native Benachrichtigung des Systems (zuverlässiger als die des Browsers in Electron);
  // der Klick kommt über desktop.onNavigate zurück (NotificationService)
  if (desktop?.notify) {
    desktop.notify({ title, body: opts.body, tag: opts.tag, url, requireInteraction: opts.requireInteraction });
    return true;
  }
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  const options: NotificationOptions = { icon: NOTIFICATION_ICON, badge: NOTIFICATION_BADGE, ...opts };
  try {
    // Desktop-App: direkt über den Notification-Konstruktor (Service-Worker-Benachrichtigungen kann Electron nicht)
    const reg = !desktop && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
    if (reg?.active) {
      await reg.showNotification(title, { ...options, data: { url } });
      return true;
    }
  } catch {
    /* Fallback unten */
  }
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      desktop?.show();
      window.focus();
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/* ───────────── Ton ───────────── */

let audioCtx: AudioContext | null = null;

/** Kurzer, dezenter Zwei-Ton-Hinweis per WebAudio (keine Audiodatei nötig) */
export function playBeep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      osc.connect(gain);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.18);
    });
  } catch {
    /* Ton ist optional */
  }
}

/* ───────────── Web Push ───────────── */

export function pushSupported(): boolean {
  // Desktop-App: kein Web Push (Electron kann sich nicht anmelden) – sie benachrichtigt, solange sie läuft
  if (desktop) return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && notificationsSupported();
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function subscribePush(fallbackKey?: string | null): Promise<PushSubscription> {
  const perm = await requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden im Browser nicht erlaubt');
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Service Worker wird nicht unterstützt');
  await navigator.serviceWorker.ready;
  let key = fallbackKey ?? '';
  try {
    const r = await api<{ publicKey: string }>('/notifications/vapid');
    if (r?.publicKey) key = r.publicKey;
  } catch {
    /* Fallback auf Schlüssel aus AppInfo */
  }
  if (!key) throw new Error('Server liefert keinen VAPID-Schlüssel');
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  await api('/notifications/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return sub;
}

export async function unsubscribePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await api('/notifications/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  } finally {
    await sub.unsubscribe();
  }
}
