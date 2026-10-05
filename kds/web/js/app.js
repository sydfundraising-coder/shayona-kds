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

  // theme switch for the office pages (home, admin, reports: dark/light; menu control: Shayona warm/dark)
  const THEME_LABEL = { dark: '🌙 Dark', light: '☀ Light', warm: '☀ Shayona' };
  K.themeBtn = (key = 'global', themes = ['dark', 'light']) => {
    const t = K.prefs(key, { theme: themes[0] }).theme;
    const next = themes[(themes.indexOf(t) + 1) % themes.length] || themes[0];
    return `<button class="iconbtn" data-theme-toggle data-key="${key}" data-themes="${themes.join(',')}" title="Change colours">${THEME_LABEL[next]}</button>`;
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-toggle]'); if (!b) return;
    const key = b.dataset.key, themes = b.dataset.themes.split(',');
    const p = K.prefs(key, { theme: themes[0] });
    p.theme = themes[(themes.indexOf(p.theme) + 1) % themes.length] || themes[0];
    K.savePrefs(key, p); K.applyTheme(p);
    K.$$('[data-theme-toggle]').forEach((x) => (x.outerHTML = K.themeBtn(x.dataset.key, x.dataset.themes.split(','))));
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
  K.unlockAudio = () => {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state !== 'running') actx.resume().then(() => K.$$('.sound-off').forEach((x) => x.remove())); } catch (_) {}
  };
  K.audioOn = () => !!actx && actx.state === 'running';
  // any tap anywhere turns sound on (browsers only allow sound after a tap)
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => K.unlockAudio(), { capture: true, passive: true }));
  // clear kitchen bell: two notes with a soft ring-out; vol = low / med / high
  K.beep = function (kind = 'new', vol = 'high') {
    if (!actx) return;
    const level = { low: 0.25, med: 0.55, high: 1 }[vol] ?? 1;
    const seq = kind === 'online' ? [1047, 1319, 1568] : kind === 'late' ? [440, 330] : [1175, 1568];
    const master = actx.createGain(); master.gain.value = level;
    const comp = actx.createDynamicsCompressor ? actx.createDynamicsCompressor() : null;
    if (comp) { master.connect(comp); comp.connect(actx.destination); } else master.connect(actx.destination);
    seq.forEach((f, i) => {
      const t = actx.currentTime + i * 0.2;
      [[f, 'sine', 0.9], [f * 2, 'triangle', 0.25]].forEach(([freq, type, amp]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type; o.frequency.value = freq; o.connect(g); g.connect(master);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(amp, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.start(t); o.stop(t + 0.6);
      });
    });
  };
  let wakeLock = null;
  K.keepAwake = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {} };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (wakeLock) K.keepAwake(); K.reload(); if (st.cfg) K.configChanged(); } });

  // ------------------------------------------------------------------ data loading
  function index() {
    st.itemsByOrder = new Map();
    st.items.forEach((i) => { if (!st.itemsByOrder.has(i.order_id)) st.itemsByOrder.set(i.order_id, []); st.itemsByOrder.get(i.order_id).push(i); });
    st.itemsByOrder.forEach((a) => a.sort((x, y) => x.sort - y.sort));
  }
  K.VERSION = '6 Oct 2026 · staff access v20';
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
  // ---- short addresses: kds.shayona.com.au/pizza, /window, /front, /board, /2 (2nd station) …
  const slug = (t) => String(t || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const SHORT = { w: 'window', window: 'window', expo: 'window', pass: 'window', f: 'front', front: 'front', counter: 'front',
    board: 'board', pickup: 'board', menu: 'menu', avail: 'availability', '86': 'availability', admin: 'admin', reports: 'reports', home: 'home' };
  K.stationSlug = (s) => slug(s.name).split('-')[0];
  K.stationByShort = function (key) {
    const k = slug(key); if (!k || !st.cfg) return null;
    const list = st.cfg.stations.filter((s) => s.active).sort((a, b) => a.sort - b.sort);
    if (/^\d+$/.test(k)) return list[+k - 1] || null;
    return list.find((s) => slug(s.name) === k) || list.find((s) => K.stationSlug(s) === k) || list.find((s) => slug(s.name).startsWith(k)) || null;
  };
  (function pathToHash() {
    const p = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
    const h = location.hash.replace(/^#\/?/, '').split('?')[0];
    // TV pages never need a login — send them to their own page, whatever way they were typed
    const TV = { 'menu-board': '/menu-board.html', menuboard: '/menu-board.html', tv: '/menu-board.html', tvmenu: '/menu-board.html', 'tv-menu': '/menu-board.html',
      'menu-slideshow': '/menu-slideshow.html', slideshow: '/menu-slideshow.html', photos: '/menu-slideshow.html', track: '/track.html', order: '/track.html' };
    const key = (p && !/\.html?$/i.test(p) ? p : h).toLowerCase().replace(/\.html?$/, '');
    if (TV[key]) { const hq = location.hash.split('?')[1]; K.redirecting = true; location.replace(TV[key] + (location.search || (hq ? '?' + hq : ''))); return; }
    if (p && !/\.html?$/i.test(p) && !location.hash) location.replace('#/' + p);
  })();

  // ---- device lock: a kitchen tablet can be locked to its own screen. Staff (non-admin) accounts on a
  // locked device only ever see that screen — the back button shows just that station.
  K.lock = {
    get() { try { return JSON.parse(localStorage.getItem('kds.lock') || 'null'); } catch (_) { return null; } },
    set(name, arg, label) { try { localStorage.setItem('kds.lock', JSON.stringify({ name, arg: arg || null, label })); } catch (_) {} },
    clear() { try { localStorage.removeItem('kds.lock'); } catch (_) {} },
    active() { return api.mode === 'live' ? api.role !== 'admin' && !!this.get() : !!this.get() && !K.demoAdminUnlocked; },
    hash(l) { return '#/' + l.name + (l.arg ? '/' + l.arg : ''); },
  };
  K.render = function (dataOnly = false) {
    let r = K.route();
    if (!K.routes[r.name] && r.name) {
      const short = SHORT[slug(r.name)];
      if (short && K.routes[short]) { r = { ...r, name: short }; }
      else { const stn = K.stationByShort(r.name); if (stn) r = { ...r, name: 'station', arg: stn.id }; }
    }
    if (K.lock.active()) {
      const L = K.lock.get();
      const allowed = (r.name === L.name && (r.arg || null) === (L.arg || null)) || r.name === 'availability' || r.name === 'home' || r.name === 'locked';
      if (!allowed) { if (!dataOnly) location.replace('#/'); return; }
      if (r.name === 'home') r = { ...r, name: 'locked' };
    }
    const fn = K.routes[r.name] || K.routes.home;
    if (!dataOnly) { K.pageRefresh = null; hideBanner(); }
    if (dataOnly && fn.onData) return fn.onData(r);
    if (dataOnly && fn.static) return;
    fn(r);
  };
  window.addEventListener('hashchange', () => { if (!st.cfg) return; K.$$('.toast').forEach((t) => t.remove()); K.$$('.scrim,.modal-wrap,.start').forEach((t) => t.remove()); K.render(); });


  // ------------------------------------------------------------------ live changes, no refresh needed
  // Config (stations, routing, settings, menu, presets, photos) changed on another screen or by Square:
  // kitchen screens redraw, list pages redraw keeping search/filter, other pages redraw unless someone
  // is in the middle of typing — then a small banner offers to refresh.
  let lastTouch = Date.now();
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastTouch = Date.now(); }, true));
  const modalOpen = () => !!K.$('.modal-wrap,.scrim');
  const typing = () => { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('#app')); };
  const dirtyFields = () => K.$$('#app input, #app textarea, #app select').some((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') { const o = [...el.options]; return o.some((x) => x.defaultSelected) ? o.some((x) => x.selected !== x.defaultSelected) : el.selectedIndex > 0; }
    if (el.type === 'file') return !!el.value;
    return el.value !== el.defaultValue;
  });
  function resolved() {
    let r = K.route();
    if (!K.routes[r.name] && r.name) {
      const short = SHORT[slug(r.name)];
      if (short && K.routes[short]) r = { ...r, name: short };
      else { const stn = K.stationByShort(r.name); if (stn) r = { ...r, name: 'station', arg: stn.id }; }
    }
    return { r, fn: K.routes[r.name] || K.routes.home };
  }
  function showBanner(text, btn, onClick) {
    let b = K.$('#livebar');
    if (!b) { b = document.createElement('div'); b.id = 'livebar'; b.className = 'livebar'; document.body.appendChild(b); }
    b.innerHTML = `<span>${text}</span><button class="btn sm primary">${btn}</button>`;
    b.querySelector('button').onclick = () => { hideBanner(); onClick(); };
  }
  function hideBanner() { const b = K.$('#livebar'); if (b) b.remove(); }
  K.hideLiveBanner = hideBanner;
  let softWaiting = false;
  K.softRender = function () {
    const { r, fn } = resolved();
    if (fn.live && fn.onData) return fn.onData(r);
    if (K.pageRefresh) { try { K.pageRefresh(); } catch (e) { console.error(e); } return; }
    if (fn.noLive) return;
    if (modalOpen() || typing()) {                        // wait until they finish, then try again
      if (!softWaiting) { softWaiting = true; const t = setInterval(() => { if (!modalOpen() && !typing()) { clearInterval(t); softWaiting = false; K.softRender(); } }, 2000); }
      return;
    }
    if (dirtyFields()) return showBanner('Changes were made on another screen.', 'Refresh', () => K.render());
    const y = window.scrollY; fn(r); window.scrollTo(0, y);
  };
  let cfgTimer = null, cfgFirst = 0;
  K.configChanged = function () {                         // debounced: a Square sync can send hundreds of changes
    const now = Date.now(); if (!cfgTimer) cfgFirst = now;
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(async () => {
      cfgTimer = null;
      try { await K.loadConfig(); K.softRender(); } catch (e) { console.error(e); }
    }, now - cfgFirst > 3000 ? 0 : 700);
  };

  // A new version was uploaded: reload by itself at a safe moment (kitchen screens wait for a
  // 20-second pause in tapping; other pages wait until nobody is typing).
  window.KDS_ON_UPDATE = function () {
    const tryNow = () => {
      const { fn } = resolved();
      if (modalOpen() || typing()) return false;
      if (fn.live && Date.now() - lastTouch < 20000) return false;
      if (!fn.live && dirtyFields()) { showBanner('A new version of the KDS is ready.', 'Update now', () => location.reload()); return true; }
      try { sessionStorage.setItem('kds-autoreload', '1'); } catch (_) {}
      location.reload(); return true;
    };
    if (!tryNow()) { const t = setInterval(() => { if (tryNow()) clearInterval(t); }, 5000); }
  };

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
  K.routes.locked = function () {
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const L = K.lock.get();
    document.getElementById('app').innerHTML = `<div class="page lockpage">
      <div class="muted">This device is set to</div>
      <a class="locktile" href="${K.lock.hash(L)}"><b>${K.esc(L.label || 'Kitchen screen')}</b><span>Tap to open</span></a>
      <button class="btn sm" id="unlock">🔒 Unlock this device (admin)</button>
      <p class="faint" style="font-size:.8em;margin-top:24px">KDS version: ${K.esc(K.VERSION)}</p></div>`;
    K.$('#unlock').onclick = () => K.unlockDevice();
  };
  K.routes.locked.static = true;
  K.unlockDevice = function () {
    K.modal('Unlock this device', `<p class="muted" style="margin-top:0">An admin signs in here to unlock. The kitchen account stays signed in on this device.</p>
      <form id="ulf"><div class="field"><label>Admin email</label><input name="e" type="email" autocomplete="off" required></div>
      <div class="field"><label>Password</label><input name="p" type="password" autocomplete="off" required></div>
      <div id="ulerr" class="muted"></div>
      <div class="actions"><span class="grow"></span><button type="button" class="btn" id="ulx">Cancel</button><button class="btn primary">Unlock</button></div></form>`, (w, close) => {
      K.$('#ulx', w).onclick = close;
      K.$('#ulf', w).onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try {
          if (api.mode === 'live') {
            const cfg = window.KDS_CONFIG;
            const tmp = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'kds-unlock-check' } });
            const { data, error } = await tmp.auth.signInWithPassword({ email: f.e.value.trim(), password: f.p.value });
            if (error) throw error;
            const { data: prof } = await tmp.from('profiles').select('role').eq('user_id', data.user.id).maybeSingle();
            await tmp.auth.signOut().catch(() => {});
            if (prof?.role !== 'admin') throw new Error('That account is not an admin.');
          } else K.demoAdminUnlocked = true;
          K.lock.clear(); close(); K.toast('Device unlocked'); location.hash = '#/'; K.render();
        } catch (err) { K.$('#ulerr', w).textContent = err.message; }
      };
      K.$('input', w).focus();
    });
  };

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
        ${isAdmin && unrouted ? `<div class="banner" style="margin-top:12px;border-radius:10px"><b>${unrouted} menu item(s) have no station.</b> <a href="#/admin?tab=health">Run the health check →</a> They skip the kitchen and the window and are ready straight away at the front counter. <a href="#/admin?tab=routing">Check routing →</a></div>` : ''}
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
          <a class="tile" href="/menu-board.html" target="_blank" rel="noopener"><b>TV menu board ↗</b><span>Live menu for the café TV</span></a>
          <a class="tile" href="/menu-slideshow.html" target="_blank" rel="noopener"><b>Photo slideshow ↗</b><span>Dish photos, videos &amp; promos</span></a>
        </div>
        ${isAdmin ? `<h2>Manage</h2>
        <div class="tiles">
          <a class="tile" href="#/availability"><b>Item availability</b><span>Quick on/off by station (updates Square)</span></a>
          <a class="tile" href="#/reports"><b>Reports</b><span>Sales, trends &amp; prep times</span></a>
          <a class="tile" href="#/admin"><b>Admin</b><span>Stations, routing, settings, Square sync</span></a>
        </div>` : ''}
        <p class="faint" style="margin-top:28px;font-size:.8em">KDS version: ${K.esc(K.VERSION)}</p>
      </div>${api.mode === 'demo' ? '<div class="demo-flag">DEMO</div>' : ''}`;
    const so = K.$('#signout'); if (so) so.onclick = async () => { await api.signOut(); location.hash = '#/'; boot(); };
  };
  K.routes.home.static = true;

  // ------------------------------------------------------------------ login
  // signed in before, but the internet is down right now: wait and carry on by itself
  function reconnectScreen() {
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    document.getElementById('app').innerHTML = `<div class="page lockpage">
      <div class="big" style="font-size:3em">📶</div><h2 style="margin:0">Reconnecting…</h2>
      <p class="muted" style="max-width:460px">This screen is still signed in. It's waiting for the internet and will carry on by itself as soon as it's back — no need to sign in again.</p>
      <div class="muted" id="rc-n" style="font-size:.85em"></div>
      <button class="btn sm" id="rc-login" style="margin-top:18px">Sign in with a different account</button></div>`;
    K.$('#rc-login').onclick = () => { clearInterval(t); loginScreen(); };
    let n = 0;
    const t = setInterval(async () => {
      n++; const el = K.$('#rc-n'); if (!el) return clearInterval(t);
      el.textContent = `Tried ${n} time${n > 1 ? 's' : ''} · trying again every 10 seconds`;
      const r = await api.ensureSession();
      if (r === 'ok') { clearInterval(t); boot(); }
      else if (r === 'invalid') { clearInterval(t); loginScreen(); }
    }, 10e3);
    window.addEventListener('online', () => setTimeout(async () => { if (K.$('#rc-n') && (await api.ensureSession()) === 'ok') { clearInterval(t); boot(); } }, 1500), { once: true });
  }
  function loginScreen() {
    K.applyTheme({ theme: 'dark' });
    let why = '';
    try {
      const manual = localStorage.getItem('kds.signout') === 'manual';
      const r = api.lastReason;
      why = manual ? '' : r === 'badpass' ? 'This screen was signed out because the password for its account was changed. Sign in with the new password.'
        : r === 'nocreds' || r === 'expired' ? 'This screen was signed out and had no saved sign-in to fall back on. Sign in with “Keep this device signed in” ticked and it won’t ask again.' : '';
    } catch (_) {}
    document.getElementById('app').innerHTML = `
      <div class="login card"><h2 style="margin-top:0">Shayona Cafe KDS</h2>
        <p class="muted">Sign in with the kitchen or admin account.</p>
        ${why ? `<div class="banner" style="border-radius:10px;margin-bottom:12px">${K.esc(why)}</div>` : ''}
        <form id="lf"><div class="field"><label>Email</label><input name="e" type="email" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input name="p" type="password" autocomplete="current-password" required></div>
        <label class="row" style="margin:4px 0 14px;align-items:flex-start;gap:8px"><input type="checkbox" name="k" checked style="margin-top:3px">
          <span>Keep this device signed in — never ask again<br><span class="muted" style="font-size:.85em">For kitchen screens, the front counter and the customer display. Untick on a personal phone or a shared computer. Tip: use the kitchen account on kitchen screens, not the admin account.</span></span></label>
        <button class="btn primary" style="width:100%">Sign in</button><div id="lerr" class="muted" style="margin-top:10px"></div></form></div>`;
    K.$('#lf').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api.signIn(f.e.value.trim(), f.p.value, f.k.checked); boot(); } catch (err) { K.$('#lerr').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    if (K.redirecting) return;
    const app = document.getElementById('app');
    app.innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
    try {
      const ok = await api.init();
      if (ok === 'offline') return reconnectScreen();
      if (!ok) return loginScreen();
      await K.loadConfig();
      const CFG = ['stations', 'catalog_items', 'categories', 'kds_settings', 'menu_presets', 'menu_media'];
      api.subscribe((table) => { if (CFG.includes(table)) K.configChanged(); else K.reload(); },
        (ok) => { const was = st.connected; setConn(ok); if (ok && was === false) { K.reload(0); K.configChanged(); } });
      K.render();
      K.reload(0);
      setInterval(() => K.reload(0), 20000);            // safety net if live updates drop
      setInterval(() => K.configChanged(), 3 * 60e3);   // safety net for settings/menu
      if (api.mode === 'live' && !K._watch) K._watch = setInterval(async () => {  // stay signed in: fix a lost sign-in quietly
        const r = await api.ensureSession();
        if (r === 'invalid') boot();                      // really signed out (e.g. password changed) → sign-in page
        else if (r === 'offline') setConn(false);         // no internet: keep showing orders, try again next minute
        else if (!st.connected) { K.reload(0); K.configChanged(); }
      }, 60e3);
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="page"><h2>Could not start</h2><p class="muted">${K.esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
    }
  }
  K.boot = boot;
  window.addEventListener('online', () => { K.reload(0); K.configChanged(); });
  document.addEventListener('DOMContentLoaded', boot);
})();
