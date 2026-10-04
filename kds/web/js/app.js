/* Core: state, helpers, router, home + login */
(function () {
  const K = window.KDS;
  let api;
  try { api = K.api = K.createAPI(); }
  catch (e) {
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('app').innerHTML = `<div class="page"><h2>Can't connect to the live system</h2><p>${String(e.message).replace(/</g, '&lt;')}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
    });
    throw e;
  }
  const st = (K.state = { cfg: null, orders: [], items: [], itemsByOrder: new Map(), connected: true, loaded: false });

  // ------------------------------------------------------------------ helpers
  K.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  K.$ = (sel, el = document) => el.querySelector(sel);
  K.$$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  K.mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };
  K.dur = (sec) => {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.round(sec); const m = Math.floor(sec / 60), s = sec % 60;
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  };
  K.time = (d) => d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  K.setting = (k, dflt) => (st.cfg?.settings?.[k] ?? dflt);
  K.stationById = (id) => st.cfg?.stations.find((s) => s.id === id);

  // timer colour thresholds (station overrides the global setting)
  K.thresholds = (station) => ({
    warn: (station?.warn_minutes || K.setting('timer_warn_minutes', 5)) * 60e3,
    late: (station?.late_minutes || K.setting('timer_late_minutes', 10)) * 60e3,
  });
  K.ageClass = (since, th) => { const a = Date.now() - new Date(since); return a >= th.late ? 'late' : a >= th.warn ? 'warn' : ''; };

  // ------------------------------------------------------------------ per-screen preferences
  K.prefs = function (key, defaults) {
    let v = {}; try { v = JSON.parse(localStorage.getItem('kds.prefs.' + key) || '{}'); } catch (_) {}
    return { ...defaults, ...v };
  };
  K.savePrefs = function (key, v) { try { localStorage.setItem('kds.prefs.' + key, JSON.stringify(v)); } catch (_) {} };
  K.applyTheme = function (p) {
    document.documentElement.dataset.theme = p?.theme || 'dark';
    document.documentElement.style.setProperty('--fs', p?.fs || 1);
  };

  // light / dark switch for the office pages (home, menu control, admin, reports)
  K.themeBtn = () => {
    const t = K.prefs('global', { theme: 'dark' }).theme;
    return `<button class="iconbtn" data-theme-toggle title="Switch light / dark">${t === 'light' ? '🌙 Dark' : '☀ Light'}</button>`;
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-toggle]'); if (!b) return;
    const p = K.prefs('global', { theme: 'dark' });
    p.theme = p.theme === 'light' ? 'dark' : 'light';
    K.savePrefs('global', p); K.applyTheme(p);
    K.$$('[data-theme-toggle]').forEach((x) => (x.outerHTML = K.themeBtn()));
  });

  // ------------------------------------------------------------------ toasts / modals / drawers
  K.toast = function (msg, opts = {}) {
    let box = K.$('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast' + (opts.error ? ' err' : '');
    t.innerHTML = `<div class="grow">${K.esc(msg)}</div>`;
    if (opts.undo) {
      const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = 'UNDO';
      b.onclick = async () => { t.remove(); try { await opts.undo(); K.reload(); } catch (e) { K.toast(e.message, { error: true }); } };
      t.appendChild(b);
    }
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), opts.ms || (opts.undo ? 6000 : 3500));
  };
  K.confirm = function (title, text, okLabel = 'Yes', danger = false) {
    return new Promise((res) => {
      const w = document.createElement('div'); w.className = 'modal-wrap';
      w.innerHTML = `<div class="modal"><h3>${K.esc(title)}</h3><div class="muted">${text}</div>
        <div class="actions"><button class="btn" data-x="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${K.esc(okLabel)}</button></div></div>`;
      w.onclick = (e) => { const x = e.target.dataset.x; if (x != null || e.target === w) { w.remove(); res(x === '1'); } };
      document.body.appendChild(w);
    });
  };
  K.modal = function (title, bodyHtml, onMount) {
    const w = document.createElement('div'); w.className = 'modal-wrap';
    w.innerHTML = `<div class="modal"><h3>${K.esc(title)}</h3>${bodyHtml}</div>`;
    w.addEventListener('click', (e) => { if (e.target === w) w.remove(); });
    document.body.appendChild(w); onMount && onMount(w, () => w.remove()); return w;
  };
  K.drawer = function (title, bodyHtml, onMount) {
    const w = document.createElement('div'); w.className = 'scrim';
    w.innerHTML = `<div class="drawer"><header><h3>${K.esc(title)}</h3><button class="iconbtn" data-close>✕</button></header><div class="body">${bodyHtml}</div></div>`;
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) w.remove(); });
    document.body.appendChild(w); onMount && onMount(w, () => w.remove()); return w;
  };

  // ------------------------------------------------------------------ sound + screen wake
  let actx = null;
  K.unlockAudio = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (_) {} };
  K.beep = function (kind = 'new') {
    if (!actx) return;
    const seq = kind === 'online' ? [880, 1175, 1568] : kind === 'late' ? [440, 330] : [988, 1319];
    seq.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.start(t); o.stop(t + 0.16);
    });
  };
  let wakeLock = null;
  K.keepAwake = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {} };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (wakeLock) K.keepAwake(); K.reload(); } });

  // ------------------------------------------------------------------ data loading
  function index() {
    st.itemsByOrder = new Map();
    st.items.forEach((i) => { if (!st.itemsByOrder.has(i.order_id)) st.itemsByOrder.set(i.order_id, []); st.itemsByOrder.get(i.order_id).push(i); });
    st.itemsByOrder.forEach((a) => a.sort((x, y) => x.sort - y.sort));
  }
  K.loadConfig = async () => { st.cfg = await api.loadConfig(); };
  let reloadTimer = null, reloading = false, again = false;
  K.reload = function (delay = 120) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (reloading) { again = true; return; }
      reloading = true;
      try {
        const d = await api.loadActive(Math.max(30, +K.setting('front_clear_minutes', 10) + 5));
        st.orders = d.orders; st.items = d.items; index(); st.loaded = true; setConn(true);
        K.render(true);
      } catch (e) { console.error(e); setConn(false); }
      reloading = false; if (again) { again = false; K.reload(); }
    }, delay);
  };
  function setConn(ok) { st.connected = ok; K.$$('.conn').forEach((c) => c.classList.toggle('off', !ok)); }

  // ------------------------------------------------------------------ router
  K.routes = {};
  K.route = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'home', arg: parts[1], q: new URLSearchParams(qs || '') };
  };
  K.render = function (dataOnly = false) {
    const r = K.route();
    const fn = K.routes[r.name] || K.routes.home;
    if (dataOnly && fn.onData) return fn.onData(r);
    if (dataOnly && fn.static) return;
    fn(r);
  };
  window.addEventListener('hashchange', () => { K.$$('.toast').forEach((t) => t.remove()); K.$$('.scrim,.modal-wrap').forEach((t) => t.remove()); K.render(); });

  // per-second ticker for timers and clock
  setInterval(() => {
    const t = Date.now();
    K.$$('[data-since]').forEach((el) => {
      const since = new Date(el.dataset.since).getTime();
      el.textContent = K.mmss(t - since);
      const warn = +el.dataset.warn, late = +el.dataset.late;
      if (warn) {
        const cls = t - since >= late ? 'late' : t - since >= warn ? 'warn' : '';
        if (el.dataset.cls !== cls) {
          el.dataset.cls = cls; el.classList.remove('warn', 'late'); if (cls) el.classList.add(cls);
          const card = el.closest('.ticket,.lrow,.chip,.mrow'); if (card) { card.classList.remove('st-warn', 'st-late', 'warn', 'late'); if (cls) card.classList.add(card.matches('.chip,.mrow') ? cls : 'st-' + cls); }
        }
      }
    });
    K.$$('.clock').forEach((c) => (c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
  }, 1000);

  // ------------------------------------------------------------------ home
  K.routes.home = function () {
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const s = st.cfg.stations.filter((x) => x.active);
    const isAdmin = api.role === 'admin';
    const unrouted = st.cfg.catalog.filter((c) => !c.is_deleted && !c.station_id && !c.no_prep && (() => {
      const cat = st.cfg.categories.find((k) => k.square_id === c.category_id); return !cat || (!cat.station_id && !cat.no_prep);
    })()).length;
    document.getElementById('app').innerHTML = `
      <div class="page">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap">
          <div><h1>Shayona Cafe · Kitchen Display</h1>
          <div class="muted">${api.mode === 'demo' ? `Demo mode — sample orders using your real menu. Nothing is sent to Square.<br><b>Why demo:</b> ${K.esc(K.demoReason || '')} <span class="faint">(site config URL: ${K.esc((window.KDS_CONFIG && window.KDS_CONFIG.supabaseUrl) || 'empty')})</span>` : `Signed in as ${K.esc(api.user?.email)} (${api.role})`}</div></div>
          <div class="row">${K.themeBtn()}${api.mode === 'live' ? '<button class="btn" id="signout">Sign out</button>' : ''}</div>
        </div>
        ${isAdmin && unrouted ? `<div class="banner" style="margin-top:12px;border-radius:10px"><b>${unrouted} menu item(s) have no station.</b> They will show on the Window screen marked "No station". <a href="#/admin?tab=routing">Fix routing →</a></div>` : ''}
        <h2>Kitchen stations</h2>
        <div class="tiles">
          ${s.map((x) => `<a class="tile" style="--c:${K.esc(x.colour)}" href="#/station/${x.id}"><b>${K.esc(x.name)}</b><span>Shows only items made at this station</span></a>`).join('') || '<div class="muted">No stations yet — add them in Admin.</div>'}
        </div>
        <h2>Pass &amp; front of house</h2>
        <div class="tiles">
          <a class="tile" style="--c:var(--ok)" href="#/window"><b>Order handling window</b><span>Finish, cut &amp; box — sees whole orders</span></a>
          <a class="tile" style="--c:var(--info)" href="#/front"><b>Front counter</b><span>All orders · call numbers · mark collected</span></a>
          <a class="tile" style="--c:var(--online)" href="#/board"><b>Customer pickup board</b><span>TV screen: Preparing / Ready numbers</span></a>
        </div>
        <h2>Menu &amp; TV screens</h2>
        <div class="tiles">
          <a class="tile" style="--c:var(--accent)" href="#/menu"><b>Menu control</b><span>Availability, NEW, Jain, wait times, presets, notices, photos</span></a>
          <a class="tile" href="menu-board.html" target="_blank" rel="noopener"><b>TV menu board ↗</b><span>Live menu for the café TV</span></a>
          <a class="tile" href="menu-slideshow.html" target="_blank" rel="noopener"><b>Photo slideshow ↗</b><span>Dish photos, videos &amp; promos</span></a>
        </div>
        <h2>Manage</h2>
        <div class="tiles">
          <a class="tile" href="#/availability"><b>Item availability</b><span>Quick on/off by station (updates Square)</span></a>
          ${isAdmin ? `<a class="tile" href="#/reports"><b>Reports</b><span>Prep times by order, item &amp; station</span></a>
          <a class="tile" href="#/admin"><b>Admin</b><span>Stations, routing, settings, Square sync</span></a>` : ''}
        </div>
      </div>${api.mode === 'demo' ? '<div class="demo-flag">DEMO</div>' : ''}`;
    const so = K.$('#signout'); if (so) so.onclick = async () => { await api.signOut(); location.hash = '#/'; boot(); };
  };
  K.routes.home.static = true;

  // ------------------------------------------------------------------ login
  function loginScreen() {
    K.applyTheme({ theme: 'dark' });
    document.getElementById('app').innerHTML = `
      <div class="login card"><h2 style="margin-top:0">Shayona Cafe KDS</h2>
        <p class="muted">Sign in with the kitchen or admin account.</p>
        <form id="lf"><div class="field"><label>Email</label><input name="e" type="email" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input name="p" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" style="width:100%">Sign in</button><div id="lerr" class="muted" style="margin-top:10px"></div></form></div>`;
    K.$('#lf').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api.signIn(f.e.value.trim(), f.p.value); boot(); } catch (err) { K.$('#lerr').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
    try {
      const ok = await api.init();
      if (!ok) return loginScreen();
      await K.loadConfig();
      api.subscribe((table) => {
        if (table === 'stations' || table === 'catalog_items') K.loadConfig().then(() => K.render(true));
        else K.reload();
      }, setConn);
      K.render();
      K.reload(0);
      setInterval(() => K.reload(0), 20000);            // safety net if live updates drop
      setInterval(() => K.loadConfig().catch(() => {}), 5 * 60e3);
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="page"><h2>Could not start</h2><p class="muted">${K.esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
    }
  }
  K.boot = boot;
  window.addEventListener('online', () => K.reload(0));
  document.addEventListener('DOMContentLoaded', boot);
})();
