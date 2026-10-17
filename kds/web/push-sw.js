/* One service worker for the whole site:
 *  - customer order tracker (/track): shows "your order is ready" notifications that arrive by Web Push
 *    (they work with the screen off or the browser closed)
 *  - installed KDS app: if a tablet starts up with no Wi-Fi, shows a "reconnecting" page that retries by
 *    itself instead of the browser's error page. Everything else goes straight to the network (always fresh). */
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconnecting…</title><body style="margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#0f1720;color:#eef2f6;font-family:system-ui,sans-serif;text-align:center;padding:20px">
<div style="font-size:3em">📶</div><h2 style="margin:0">Reconnecting…</h2><p style="color:#9aa6b5;max-width:420px">No internet on this screen right now. It will open by itself as soon as the Wi-Fi is back.</p>
<script>setInterval(()=>{fetch('/',{cache:'no-store'}).then(r=>{if(r.ok)location.reload()}).catch(()=>{})},8000);addEventListener('online',()=>location.reload())</script>`;
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;                     // only page loads; data and files untouched
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
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
