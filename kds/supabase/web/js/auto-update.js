/* Auto-update: notices when a new version of the site has been uploaded (GitHub → Vercel) and
 * reloads the page by itself, so nobody has to refresh any screen after an update.
 * It checks the page's own files every minute (a tiny HEAD request — no download).
 * The KDS app sets window.KDS_ON_UPDATE to pick a safe moment; other pages (TV menu,
 * slideshow) just reload straight away. */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;             // not on a website (e.g. the demo preview)
  const EVERY = 60e3;
  const files = () => {
    const urls = [location.pathname === '/' || !/\.html?$/.test(location.pathname) ? '/' : location.pathname];
    document.querySelectorAll('script[src],link[rel="stylesheet"][href]').forEach((el) => {
      const u = new URL(el.src || el.href, location.href);
      if (u.origin === location.origin) urls.push(u.pathname);
    });
    return [...new Set(urls)];
  };
  async function signature() {
    const parts = await Promise.all(files().map(async (u) => {
      const r = await fetch(u, { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) throw new Error('check failed');
      return u + '=' + (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || '');
    }));
    return parts.join('|');
  }
  let base = null, found = false;
  async function check() {
    if (found || !navigator.onLine) return;
    try {
      const sig = await signature();
      if (base == null) { base = sig; return; }
      if (sig !== base) {
        found = true;
        if (typeof window.KDS_ON_UPDATE === 'function') window.KDS_ON_UPDATE();
        else location.reload();
      }
    } catch (_) { /* offline or blip — try again next time */ }
  }
  window.addEventListener('load', () => { check(); setInterval(check, EVERY); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();
