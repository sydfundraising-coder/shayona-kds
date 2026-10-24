/* Auto-update: notices when a new version of the site has been uploaded (GitHub → Vercel) and
 * reloads the page by itself, so nobody has to refresh any screen after an update.
 * It checks the page's own files every minute (a tiny HEAD request — no download).
 * The KDS app sets window.KDS_ON_UPDATE to pick a safe moment; other pages (TV menu,
 * slideshow) just reload straight away. */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;             // not on a website (e.g. the demo preview)
  const EVERY = 60e3;
  const files = () => {
    const urls = [location.pathname || '/'];
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
      // ignore how the file was compressed (W/ prefixes, -gzip/-br suffixes) — only real changes count
      const tag = String(r.headers.get('etag') || '').replace(/^W\//, '').replace(/-(gzip|br|zstd|deflate)"?$/i, '').replace(/"/g, '');
      return u + '=' + (tag || r.headers.get('last-modified') || '');
    }));
    return parts.join('|');
  }
  let base = null, found = false, maybe = null;
  async function check() {
    if (found || !navigator.onLine) return;
    try {
      const sig = await signature();
      if (base == null) { base = sig; return; }
      if (sig === base) { maybe = null; return; }
      if (maybe !== sig) { maybe = sig; setTimeout(check, 20e3); return; }   // must see the same new version twice
      {
        found = true;
        if (typeof window.KDS_ON_UPDATE === 'function') window.KDS_ON_UPDATE();
        else location.reload();
      }
    } catch (_) { /* offline or blip — try again next time */ }
  }
  window.addEventListener('load', () => { check(); setInterval(check, EVERY); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();
