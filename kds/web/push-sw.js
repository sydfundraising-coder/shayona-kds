/* One service worker for the whole site:
 *  - customer order tracker (/track): shows "your order is ready" notifications that arrive by Web Push
 *    (they work with the screen off or the browser closed)
 *  - KDS screens: keeps a copy of the app on the tablet so it opens even with no internet (network first,
 *    so new versions still arrive straight away). Orders, pushes and the relay always go to the network. */
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconnecting…</title><body style="margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#0f1720;color:#eef2f6;font-family:system-ui,sans-serif;text-align:center;padding:20px">
<div style="font-size:3em">📶</div><h2 style="margin:0">Reconnecting…</h2><p style="color:#9aa6b5;max-width:420px">No internet on this screen right now. It will open by itself as soon as the Wi-Fi is back.</p>
<script>setInterval(()=>{fetch('/',{cache:'no-store'}).then(r=>{if(r.ok)location.reload()}).catch(()=>{})},8000);addEventListener('online',()=>location.reload())</script>`;
// The KDS itself is kept on the tablet, so a tablet with NO internet can still open (or reload) the screens
// and carry on with the orders it has saved. Always tries the network first, so updates still arrive at once.
const SHELL = 'kds-shell-v1';
const SHELL_FILES = ['/', '/styles.css', '/config.js', '/manifest.webmanifest', '/track.html', '/js/vendor/qrcode.js', '/js/vendor/supabase.js',
  '/js/demo-menu.js', '/js/api.js', '/js/app.js', '/js/screens.js', '/js/pages.js', '/js/charts.js', '/js/reports-sales.js',
  '/js/pages-menu.js', '/js/auto-update.js', '/icons/kds-192.png', '/icons/track-192.png'];
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;   // data and the relay always go live
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (req.mode === 'navigate' || /\.(js|css|png|webmanifest|html)$/.test(url.pathname))) {
        const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req.mode === 'navigate' ? navKey(url) : url.pathname, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(SHELL);
      const hit = await c.match(req.mode === 'navigate' ? navKey(url) : url.pathname);
      if (hit) return hit;
      if (req.mode === 'navigate') return new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      throw err;
    }
  })());
});
function navKey(url) {
  const p = url.pathname;
  if (/^\/(track|order)\b/.test(p)) return '/track.html';
  if (/^\/(menu-board|menuboard|tv|tvmenu|tv-menu)\b/.test(p)) return '/menu-board.html';
  if (/^\/(menu-slideshow|slideshow|photos)\b/.test(p)) return '/menu-slideshow.html';
  return /\.html$/.test(p) ? p : '/';
}
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(SHELL_FILES.map((f) => fetch(f, { cache: 'no-store' }).then((r) => r.ok && c.put(f, r)).catch(() => {})))));
});
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
