/* Screen notice for the TV menu board and slideshow, with optional timing set in Menu control:
 *   start_at  — when the counter closes (the full-screen notice appears then)
 *   warn_min  — minutes before start_at to show a "closing in N min" warning strip (default 10)
 *   end_at    — when it reopens (the notice disappears by itself, and the notice says "We reopen at …")
 * A notice without start_at shows straight away, as before. Uses the TV's own clock, ticking every second. */
(function () {
  let cur = null;
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function strip() {
    let s = document.getElementById('nWarn');
    if (!s) {
      const css = document.createElement('style');
      css.textContent = '#nWarn{position:fixed;left:0;right:0;bottom:0;z-index:60;background:#b3261e;color:#fff;font-weight:800;font-size:4.4vh;line-height:1.25;' +
        'padding:1.6vh 3vw;text-align:center;box-shadow:0 -1vh 3vh rgba(0,0,0,.35);font-family:inherit;animation:nwp 2.4s ease-in-out infinite}' +
        '#nWarn[hidden]{display:none}#nWarn b{background:#fff;color:#b3261e;border-radius:1vh;padding:0 1.2vh;margin:0 .4vh;white-space:nowrap}' +
        '#nWarn small{display:block;font-size:2.6vh;font-weight:600;opacity:.92;margin-top:.4vh}' +
        '@keyframes nwp{0%,100%{filter:brightness(1)}50%{filter:brightness(1.18)}}';
      document.head.appendChild(css);
      s = document.createElement('div'); s.id = 'nWarn'; s.hidden = true; document.body.appendChild(s);
    }
    return s;
  }
  function tick() {
    const n = cur, el = document.getElementById('notice'), s = strip();
    if (!el) return;
    if (!n || !n.active) { el.hidden = true; s.hidden = true; return; }
    const now = Date.now(), start = n.start_at ? Date.parse(n.start_at) : null, end = n.end_at ? Date.parse(n.end_at) : null;
    const warn = Math.max(0, Number(n.warn_min ?? 10)) * 60e3;
    let phase = 'on';
    if (start && now < start) phase = now >= start - warn ? 'warn' : 'off';
    if (end && now >= end) phase = 'off';
    if (phase === 'on') {
      document.getElementById('nTitle').textContent = n.title || 'We are closed';
      document.getElementById('nMsg').textContent = (n.message || '') + (end ? (n.message ? '\n' : '') + 'We reopen at ' + fmt(end) + '.' : '');
      document.getElementById('nHours').hidden = !n.hours;
      el.hidden = false;
    } else el.hidden = true;
    if (phase === 'warn') {
      const left = start - now, m = Math.ceil(left / 60e3);
      const when = left < 60e3 ? `in <b>${Math.ceil(left / 1000)} sec</b>` : `in <b>${m} min</b>`;
      s.innerHTML = `⚠ ${(n.warn_text || 'Counter closes').replace(/[<>&]/g, '')} ${when} — at ${fmt(start)}` +
        `<small>${end ? 'We reopen at ' + fmt(end) + ' · ' : ''}Please place your order now</small>`;
      s.hidden = false;
    } else s.hidden = true;
  }
  window.KDS_NOTICE = { apply(n) { cur = n; tick(); } };
  setInterval(tick, 1000);
})();
