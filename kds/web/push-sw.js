/* Service worker for the customer order tracker (/track): shows "your order is ready" notifications
 * that arrive by Web Push — they work with the screen off or the browser closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Shayona Cafe';
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || 'order', renotify: true,
      requireInteraction: d.kind !== 'part',                   // ready / still waiting: stays until tapped
      vibrate: [500, 150, 500, 150, 900, 300, 500, 150, 500],
      icon: '/icons/track-192.png', badge: '/icons/badge-96.png',
      data: { url: d.url || '/track' },
    });
    // if the tracker page is open, let it ring too
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'kds-push', kind: d.kind }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/track', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).pathname.startsWith('/track') || new URL(w.url).pathname.startsWith('/order'));
    if (open) { try { await open.navigate(url); } catch (_) {} return open.focus(); }
    return self.clients.openWindow(url);
  })());
});
