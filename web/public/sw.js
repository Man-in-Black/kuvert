/* Kuvert Service Worker – nur für Web-Push-Benachrichtigungen (kein Offline-Caching der API). */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Ist auf diesem Gerät gerade ein Kuvert-Fenster sichtbar? Dann zeigt der Tab selbst einen Hinweis an. */
async function appVisible() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.some((c) => new URL(c.url).origin === self.location.origin && c.visibilityState === 'visible');
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Kuvert', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Kuvert';
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    requireInteraction: !!payload.requireInteraction,
    // Android: Benachrichtigungen können kein SVG; das Badge ist das einfarbige Symbol in der Statusleiste
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(
    (async () => {
      // Der Server schickt Push an alle Geräte; ist Kuvert hier sichtbar, übernimmt der Tab (Toast).
      // Browser erzwingen bei sichtbarer Seite keine Ersatz-Benachrichtigung.
      if (payload.tag !== 'test' && (await appVisible())) return;
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(target);
            } catch {
              /* z. B. nicht kontrollierter Client */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
