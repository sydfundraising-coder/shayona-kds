/* Data layer: LiveAPI (Supabase) and DemoAPI (in-browser simulation, same interface) */
(function () {
  const K = (window.KDS = window.KDS || {});
  const now = () => new Date();
  const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());

  // ------------------------------------------------------------------ shared: report rows
  // Same shape as the SQL view v_item_report
  K.buildReportRow = function (o, it, evs, stationName) {
    const live = evs.filter((e) => !e.undone && e.qty > 0);
    const sum = (st, f = () => true) => live.filter((e) => e.stage === st && f(e)).reduce((a, e) => a + e.qty, 0);
    const avg = (st) => {
      const xs = live.filter((e) => e.stage === st && !e.forced);
      const u = xs.reduce((a, e) => a + e.qty, 0);
      return u ? xs.reduce((a, e) => a + e.qty * (new Date(e.at) - new Date(o.received_at)) / 1000, 0) / u : null;
    };
    return {
      item_id: it.id, order_id: o.id, order_no: o.order_no, is_online: o.is_online, source_name: o.source_name,
      order_status: o.status, order_forced: o.forced, received_at: o.received_at,
      order_prepared_at: o.prepared_at, order_ready_at: o.ready_at, order_completed_at: o.completed_at,
      item_name: it.item_name, variation_name: it.variation_name, category_name: it.category_name,
      station_id: it.station_id, station_name: stationName || null, no_prep: it.no_prep, qty: it.qty, pack: it.pack,
      qty_prep: it.qty_prep, qty_window: it.qty_window, qty_front: it.qty_front,
      prep_units: sum('prep') || null, window_units: sum('window') || null, front_units: sum('front') || null,
      forced_units: sum('prep', (e) => e.forced) + sum('window', (e) => e.forced) + sum('front', (e) => e.forced) || null,
      avg_prep_sec: avg('prep'), avg_window_sec: avg('window'), avg_front_sec: avg('front'),
    };
  };

  // ================================================================== LIVE (Supabase)
  class LiveAPI {
    constructor(cfg) {
      this.mode = 'live';
      this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: window.localStorage },
        realtime: { params: { eventsPerSecond: 20 } },
      });
      this.user = null; this.role = 'staff';
    }
    // ---- staying signed in --------------------------------------------------------------
    // A device that has been signed in never shows the sign-in page because of the internet:
    // it keeps trying ("offline") until it can confirm the sign-in again. Only a real rejection
    // (wrong / changed password, revoked sign-in with no saved device sign-in) asks for a sign-in.
    _hasSaved() { try { return Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)); } catch (_) { return false; } }
    _isNetErr(e) {
      if (!e) return false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
      const t = `${e.name || ''} ${e.message || ''} ${e.code || ''}`;
      return e.status === 0 || e.status >= 500 || /fetch|network|timeout|timed out|load failed|offline|AuthRetryableFetchError|ECONN|ENOTFOUND/i.test(t);
    }
    // 'ok' = signed in · 'offline' = can't tell right now, keep going · 'invalid' = really signed out
    async _restore() {
      let netProblem = false;
      try {
        const { data, error } = await this.sb.auth.getSession();
        if (data && data.session) { await this._loadProfile(data.session.user); return 'ok'; }
        if (error && this._isNetErr(error)) netProblem = true;
      } catch (e) { if (this._isNetErr(e)) netProblem = true; }
      if (this._devCreds()) {
        const r = await this._silentSignIn();
        if (r === 'ok' || r === true) return 'ok';
        if (r === 'offline') return 'offline';
      }
      if (this._hasSaved()) {
        try {
          const { data, error } = await this.sb.auth.refreshSession();
          if (data && data.session) { await this._loadProfile(data.session.user); return 'ok'; }
          if (error && this._isNetErr(error)) return 'offline';
        } catch (e) { if (this._isNetErr(e)) return 'offline'; }
      }
      return netProblem && (this._hasSaved() || this._devCreds()) ? 'offline' : 'invalid';
    }
    async init() {
      let r = 'invalid';
      for (let i = 0; i < 3; i++) {                 // short retries cover a refresh clash with another tab
        r = await this._restore();
        if (r === 'ok' || (r === 'invalid' && !this._hasSaved())) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (!this._authHooked) {
        this._authHooked = true;
        this.sb.auth.onAuthStateChange((event, s2) => {
          if (s2) { this._lastSession = s2; return; }
          if (event === 'SIGNED_OUT' && !this._signingOut) {
            // signed out without pressing "Sign out": get the sign-in back quietly if we can
            this._restore().then((res) => { if (res === 'invalid') { this.user = null; window.KDS && KDS.boot && KDS.boot(); } });
            return;
          }
        });
      }
      if (r === 'offline') return 'offline';
      return !!this.user && r === 'ok';
    }
    async _loadProfile(user) {
      this.user = user;
      try {
        const { data, error } = await this.sb.from('profiles').select('role,display_name').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        this.role = data?.role || 'staff';
        try { localStorage.setItem('kds.role', this.role); } catch (_) {}
      } catch (_) {                                  // offline: use the role we saw last time
        try { this.role = localStorage.getItem('kds.role') || 'staff'; } catch (__) { this.role = 'staff'; }
      }
    }
    async signIn(email, password, keep = false) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await this._loadProfile(data.user);
      // "Keep this device signed in": kitchen / display devices sign themselves back in if the sign-in
      // is ever lost (wifi drop during a refresh, time limits). Never kept for admin accounts.
      try {
        if (keep && this.role !== 'admin') localStorage.setItem('kds.dev', btoa(unescape(encodeURIComponent(JSON.stringify({ e: email, p: password })))));
        else localStorage.removeItem('kds.dev');
      } catch (_) {}
    }
    _devCreds() { try { const v = localStorage.getItem('kds.dev'); return v ? JSON.parse(decodeURIComponent(escape(atob(v)))) : null; } catch (_) { return null; } }
    async _silentSignIn() {
      const c = this._devCreds(); if (!c) return 'invalid';
      if (this._silent) return this._silent;
      this._silent = (async () => {
        try {
          const { data, error } = await this.sb.auth.signInWithPassword({ email: c.e, password: c.p });
          if (error) {
            if (this._isNetErr(error)) return 'offline';
            if (/invalid login|invalid credentials|email not confirmed|banned/i.test(error.message)) { try { localStorage.removeItem('kds.dev'); } catch (_) {} return 'invalid'; }
            return 'offline';                         // anything else (rate limit, server hiccup): try again later
          }
          await this._loadProfile(data.user); console.info('KDS: signed back in automatically');
          return 'ok';
        } catch (e) { return this._isNetErr(e) ? 'offline' : 'offline'; } finally { setTimeout(() => { this._silent = null; }, 0); }
      })();
      return this._silent;
    }
    // called every minute by the app: 'ok' | 'offline' | 'invalid'
    async ensureSession() { return this._restore(); }
    async signOut() { this._signingOut = true; try { localStorage.removeItem('kds.dev'); } catch (_) {} try { await this.sb.auth.signOut(); } finally { this._signingOut = false; this.user = null; } }
    _chk({ data, error }) { if (error) throw new Error(error.message); return data; }

    async loadConfig() {
      const [settings, stations, categories, catalog] = await Promise.all([
        this.sb.from('kds_settings').select('key,value').then((r) => this._chk(r)),
        this.sb.from('stations').select('*').order('sort').then((r) => this._chk(r)),
        this.sb.from('categories').select('*').order('name').then((r) => this._chk(r)),
        this._all(() => this.sb.from('catalog_items').select('*').eq('is_deleted', false).order('item_name')),
      ]);
      const opt = async (q) => { try { return this._chk(await q); } catch (_) { return []; } }; // tables from 003 may not exist yet
      const [presets, media] = await Promise.all([
        opt(this.sb.from('menu_presets').select('*').order('name')),
        opt(this.sb.from('menu_media').select('*').order('sort')),
      ]);
      return { settings: Object.fromEntries(settings.map((r) => [r.key, r.value])), stations, categories, catalog, presets, media };
    }
    async _all(q) { // paginate past the 1000-row API limit
      const out = []; let from = 0;
      for (;;) {
        const rows = this._chk(await q().range(from, from + 999));
        out.push(...rows); if (rows.length < 1000) return out; from += 1000;
      }
    }
    async loadActive(recentMinutes = 30) {
      const since = iso(new Date(Date.now() - 36 * 3600e3));
      const recent = iso(new Date(Date.now() - recentMinutes * 60e3));
      const orders = this._chk(await this.sb.from('orders').select('*')
        .gte('received_at', since)
        .or(`status.in.(new,preparing,at_window,ready),updated_at.gte.${recent}`)
        .order('received_at').limit(500));
      const ids = orders.map((o) => o.id); const items = [];
      for (let i = 0; i < ids.length; i += 120) {
        items.push(...this._chk(await this.sb.from('order_items').select('*').in('order_id', ids.slice(i, i + 120)).order('sort')));
      }
      return { orders, items };
    }
    subscribe(onChange, onStatus) {
      this._sub = [onChange, onStatus];
      const old = this.channel; this.channel = null;
      if (old) this.sb.removeChannel(old);
      clearTimeout(this._retry);
      const ch = this.sb.channel('kds-live-' + Date.now());
      ['orders', 'order_items', 'catalog_items', 'stations', 'categories', 'kds_settings', 'menu_presets', 'menu_media'].forEach((t) =>
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => onChange(t, p)));
      ch.subscribe((status) => {
        if (ch !== this.channel) return;
        const ok = status === 'SUBSCRIBED';
        onStatus && onStatus(ok);
        // connection dropped (wifi blip, laptop asleep, token refresh) → join again by itself
        if (!ok && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          clearTimeout(this._retry);
          this._retry = setTimeout(() => this.subscribe(...this._sub), 3000);
        }
      });
      this.channel = ch;
    }
    async bump(itemId, stage, qty, screen, force = false) {
      return this._chk(await this.sb.rpc('kds_bump', { p_item: itemId, p_stage: stage, p_qty: qty, p_screen: screen, p_force: force }));
    }
    async bumpOrder(orderId, stage, stationId, screen, force = false) {
      return this._chk(await this.sb.rpc('kds_bump_order', { p_order: orderId, p_stage: stage, p_station: stationId || null, p_screen: screen, p_force: force }));
    }
    async recall(eventId, screen) { return this._chk(await this.sb.rpc('kds_recall', { p_event: eventId, p_screen: screen })); }
    async recentEvents(stage, stationId, minutes = 90) {
      let q = this.sb.from('item_events').select('id,qty,at,stage,forced,station_id,order_id,order_item_id,order_items(item_name,variation_name),orders(order_no)')
        .eq('stage', stage).eq('undone', false).gt('qty', 0)
        .gte('at', iso(new Date(Date.now() - minutes * 60e3))).order('at', { ascending: false }).limit(40);
      if (stationId) q = q.eq('station_id', stationId);
      return this._chk(await q).map((e) => ({
        id: e.id, qty: e.qty, at: e.at, forced: e.forced, order_id: e.order_id, order_item_id: e.order_item_id,
        item_name: e.order_items?.item_name, variation_name: e.order_items?.variation_name, order_no: e.orders?.order_no,
      }));
    }
    async _fn(name, body) {
      const { data, error } = await this.sb.functions.invoke(name, { body });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch (_) {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    }
    setAvailability(itemId, available) { return this._fn('square-availability', { item_id: itemId, available }); }
    setAvailabilityVariations(ids, available) { return this._fn('square-availability', { variation_ids: ids, available }); }
    setAvailabilityMany(changes) { return this._fn('square-availability', { changes }); }
    async setMenuFlags(variationIds, patch) { return this._chk(await this.sb.rpc('kds_set_menu_flags', { p_variation_ids: variationIds, p_patch: patch })); }
    async clearWaits() { return this._chk(await this.sb.rpc('kds_clear_waits')); }
    async setMenuSetting(key, value) { return this._chk(await this.sb.rpc('kds_set_menu_setting', { p_key: key, p_value: value })); }
    async savePreset(name, ids) { return this._chk(await this.sb.from('menu_presets').upsert({ name, variation_ids: ids, updated_at: iso(now()) })); }
    async deletePreset(name) { return this._chk(await this.sb.from('menu_presets').delete().eq('name', name)); }
    async liveWaits() { try { return this._chk(await this.sb.rpc('kds_menu_feed'))?.autoWaits || {}; } catch (_) { return {}; } }
    async uploadMedia(file, kind, itemName) {
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const base = (kind === 'item' ? itemName : file.name.replace(/\.[^.]+$/, '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const path = `${kind}s/${base}-${Date.now()}.${ext}`;
      const up = await this.sb.storage.from('menu-media').upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const url = this.sb.storage.from('menu-media').getPublicUrl(path).data.publicUrl;
      const isVideo = /^video\//.test(file.type) || /\.(mp4|webm|m4v)$/i.test(file.name);
      if (kind === 'item') { // one photo/video per item: replace the old one
        const old = this._chk(await this.sb.from('menu_media').select('id,path').eq('kind', 'item').ilike('item_name', itemName));
        for (const o of old) await this.deleteMedia(o.id, o.path);
      }
      this._chk(await this.sb.from('menu_media').insert({ kind, item_name: kind === 'item' ? itemName : null, path, url, is_video: isVideo, sort: kind === 'promo' ? file.name.toLowerCase() : null }));
    }
    async deleteMedia(id, path) {
      await this.sb.storage.from('menu-media').remove([path]);
      this._chk(await this.sb.from('menu_media').delete().eq('id', id));
    }
    syncCatalog() { return this._fn('square-sync', { action: 'catalog' }); }
    syncOrders(minutes = 60) { return this._fn('square-sync', { action: 'orders', minutes }); }
    testSquare() { return this._fn('square-sync', { action: 'test' }); }
    // ---- sales history (Reports → Sales & trends)
    importSales(from, to) { return this._fn('square-sync', { action: 'sales', from, to }); }
    async salesReport(from, to) { return this._chk(await this.sb.rpc('kds_sales_report', { p_from: from, p_to: to })); }
    async salesMonthly(from, to) { return this._chk(await this.sb.rpc('kds_sales_monthly', { p_from: from, p_to: to })); }
    async salesCoverage() { return this._chk(await this.sb.rpc('kds_sales_coverage')); }
    async closeOpenOrders(mins = 0) { return this._chk(await this.sb.rpc('kds_close_open_orders', { p_older_than_minutes: mins })); }
    async saveStation(s) {
      const row = { name: s.name, colour: s.colour, sort: +s.sort || 0, warn_minutes: s.warn_minutes || null, late_minutes: s.late_minutes || null, active: s.active !== false };
      if (s.id) return this._chk(await this.sb.from('stations').update(row).eq('id', s.id));
      return this._chk(await this.sb.from('stations').insert(row));
    }
    async deleteStation(id) { return this._chk(await this.sb.from('stations').delete().eq('id', id)); }
    async setCategoryRoute(catId, stationId, noPrep) {
      return this._chk(await this.sb.from('categories').update({ station_id: stationId || null, no_prep: !!noPrep }).eq('square_id', catId));
    }
    async setItemRoute(itemId, stationId, noPrep) { // null/null = follow category
      return this._chk(await this.sb.from('catalog_items').update({ station_id: stationId || null, no_prep: noPrep }).eq('item_id', itemId));
    }
    async setCategoryHold(catId, hold) { return this._chk(await this.sb.from('categories').update({ hold: !!hold }).eq('square_id', catId)); }
    async setItemHold(itemId, hold) { return this._chk(await this.sb.from('catalog_items').update({ hold }).eq('item_id', itemId)); }
    async setCategorySkipWindow(catId, v) { this._chk(await this.sb.from('categories').update({ skip_window: !!v }).eq('square_id', catId)); return this._applySkip(); }
    async setItemSkipWindow(itemId, v) { this._chk(await this.sb.from('catalog_items').update({ skip_window: v }).eq('item_id', itemId)); return this._applySkip(); }
    async _applySkip() { const { data, error } = await this.sb.rpc('kds_apply_skip_window'); if (error) console.warn(error.message); return data; }
    async saveSetting(key, value) {
      return this._chk(await this.sb.from('kds_settings').upsert({ key, value, updated_at: iso(now()) }));
    }
    async reportRows(fromIso, toIso) {
      return this._all(() => this.sb.from('v_item_report').select('*').gte('received_at', fromIso).lt('received_at', toIso).order('received_at'));
    }
  }

  // ================================================================== DEMO (in-browser)
  class DemoAPI {
    constructor() {
      this.mode = 'demo'; this.user = { email: 'demo@shayona.cafe' }; this.role = 'admin';
      this.listeners = []; this.seq = 100;
      this._seed();
    }
    async init() { return true; }
    async signIn() {} async signOut() {}

    _seed() {
      const S = (id, name, colour, sort) => ({ id, name, colour, sort, warn_minutes: null, late_minutes: null, active: true });
      this.stations = [
        S('st-pizza', 'Pizza', '#ef4444', 1),
        S('st-sandwich', 'Sandwich & Wraps', '#3b82f6', 2),
        S('st-chaat', 'Chaat & Street Food', '#22c55e', 3),
        S('st-hot', 'Hot Kitchen & Fryer', '#f97316', 4),
        S('st-drinks', 'Drinks & Dessert', '#a855f7', 5),
      ];
      const route = {
        'PIZZA': 'st-pizza', 'SANDWICH / WRAP': 'st-sandwich', 'CHAAT': 'st-chaat', 'STREET FOODS': 'st-chaat',
        'FASTING (UPVAS)': 'st-chaat', "TODAY'S SPECIALS": 'st-hot', 'FRENCH FRIES': 'st-hot', 'GRAB N GO': 'st-hot',
        'HOT BEVERAGES': 'st-drinks', 'BEVERAGES': 'st-drinks', 'DESSERT': 'st-drinks',
      };
      const catNames = [...new Set(window.KDS_DEMO_MENU.map((m) => m[1]))];
      this.categories = catNames.map((n) => ({
        square_id: 'cat-' + n.replace(/\W+/g, '-').toLowerCase(), name: n,
        station_id: route[n] || null, no_prep: n === 'BAKERY' || n === 'SWEETS & PACKAGED', hold: n === 'DESSERT',
      })).sort((a, b) => a.name.localeCompare(b.name));
      const catByName = Object.fromEntries(this.categories.map((c) => [c.name, c]));
      this.catalog = window.KDS_DEMO_MENU.map(([name, cat, ta, jain, coffee, itemId, varId, price]) => ({
        variation_id: varId, item_id: itemId, item_name: name, variation_name: null,
        category_id: catByName[cat].square_id, category_name: cat,
        station_id: null,
        no_prep: /\d+\s?ML\b/i.test(name) && !/LASSI|SHAKE/i.test(name) ? true : null, // bottled drinks
        available: true, _ta: ta, _jain: jain, _coffee: coffee,
        price_cents: price || null, description: null, category_ids: [catByName[cat].square_id], online_visible: true,
        board_category: null, jain: !!jain, is_new: false, wait_min: null, addon: null, hold: null,
        stock_qty: /SWEETS/.test(cat) ? null : 1000,
      }));
      this.catalog.find((c) => c.item_name === 'MARGHERITA PIZZA').is_new = true;
      this.catalog.find((c) => c.item_name === 'PAV BHAJI').wait_min = 15;
      this.presets = [{ name: 'Weekend Menu', variation_ids: this.catalog.filter((c) => !/SWEETS/.test(c.category_name)).map((c) => c.variation_id) }];
      this.media = [];
      this.catalog.find((c) => c.item_name === 'MASALA PUFF').available = false;
      this.settings = {
        square_location_id: 'LTK7KJ67PRKJW', timezone: 'Australia/Sydney',
        takeaway_keywords: ['take away', 'takeaway', 'take-away', 'box', 'to go'],
        plate_keywords: ['plate', 'dine in', 'eat in', 'for here'],
        default_pack: 'PLATE', online_pack: 'BOX',
        online_sources: ['square online', 'online', 'uber', 'doordash', 'menulog', 'website'],
        timer_warn_minutes: 5, auto_close_time: '23:00', timer_late_minutes: 10, front_clear_minutes: 10,
        availability_mode: 'inventory', available_stock: 999,
        pack_hidden_categories: ['HOT BEVERAGES', 'BEVERAGES'],
        menu_banner: '', menu_notice: { active: false, title: '', message: '', hours: false },
        auto_wait: { enabled: true, min_minutes: 10, lookback_minutes: 30 },
      };
      this.orders = []; this.items = []; this.events = []; this.evSeq = 1;
      this._history();
      // live orders at various ages
      const ages = [14, 11, 9, 7.5, 6, 4, 3, 2, 1.2, 0.5];
      ages.forEach((a, i) => this._newOrder(new Date(Date.now() - a * 60e3), { advance: a, i }));
      // one order that is part-ready, to show "Collect now"
      const pick = (n) => this.catalog.find((c) => c.item_name === n);
      const po = this._newOrder(new Date(Date.now() - 8 * 60e3), { lines: [
        { it: pick('PAV BHAJI'), qty: 2, mods: ['Take Away'], note: null },
        { it: pick('MANGO LASSI'), qty: 1, mods: [], note: null },
        { it: pick('MARGHERITA PIZZA'), qty: 1, mods: ['Extra Spicy'], note: null }] });
      this.items.filter((i) => i.order_id === po.id && i.item_name !== 'MARGHERITA PIZZA').forEach((i) => {
        this._bump(i.id, 'prep', null, 'seed', false, new Date(Date.now() - 4 * 60e3));
        if (i.item_name === 'PAV BHAJI') this._bump(i.id, 'window', null, 'seed', false, new Date(Date.now() - 3 * 60e3));
      });
    }
    _route(cat) {
      const c = this.categories.find((x) => x.square_id === cat.category_id);
      const noPrep = cat.no_prep ?? c?.no_prep ?? false;
      const skipWin = cat.skip_window ?? c?.skip_window ?? false;
      return { station_id: noPrep ? null : (cat.station_id || c?.station_id || null), no_prep: noPrep, skip_window: !!skipWin };
    }
    _pickLines(rand) {
      const food = this.catalog.filter((c) => c.available && !['SWEETS & PACKAGED'].includes(c.category_name));
      const hot = food.filter((c) => !['BAKERY', 'BEVERAGES'].includes(c.category_name));
      const n = 1 + Math.floor(rand() * 4);
      const lines = [];
      for (let k = 0; k < n; k++) {
        const pool = rand() < 0.7 ? hot : food;
        const it = pool[Math.floor(rand() * pool.length)];
        if (lines.some((l) => l.it === it)) continue;
        const qty = rand() < 0.7 ? 1 : rand() < 0.75 ? 2 : 3;
        const mods = [];
        if (it._ta && rand() < 0.5) mods.push('Take Away');
        if (it._jain && rand() < 0.2) mods.push('JAIN');
        if (it._ta && rand() < 0.15) mods.push(rand() < 0.5 ? 'Spicy' : 'Extra Spicy');
        if (it._coffee) mods.push(['Cappuccino', 'Latte', 'Flat White', 'Long Black'][Math.floor(rand() * 4)], ...(rand() < 0.3 ? ['Oat Milk'] : []));
        lines.push({ it, qty, mods, note: it._ta && rand() < 0.08 ? 'No onion please' : null });
      }
      return lines;
    }
    _newOrder(at, opts = {}) {
      const rand = Math.random;
      const online = rand() < 0.25;
      const names = ['Priya', 'Raj', 'Meera', 'Amit', 'Sarah', 'Jay', 'Nisha', 'Tom', 'Kavya', 'Dev'];
      this.seq++;
      const o = {
        id: uuid(), square_order_id: 'demo-' + this.seq, order_no: String(this.seq), kds_seq: this.seq,
        source_name: online ? 'Square Online' : 'POS', is_online: online,
        customer_name: online ? names[Math.floor(rand() * names.length)] : null,
        note: null, fulfillment_type: online ? 'PICKUP' : null,
        pickup_at: online && rand() < 0.3 ? iso(new Date(at.getTime() + 25 * 60e3)) : null,
        dining_mode: 'takeaway', table_name: null, status: 'new',
        placed_at: iso(at), received_at: iso(at), first_bump_at: null, prepared_at: null, ready_at: null,
        completed_at: null, cancelled_at: null, forced: false, updated_at: iso(at),
      };
      this.orders.push(o);
      (opts.lines || this._pickLines(rand)).forEach((l, idx) => {
        const r = this._route(l.it);
        const skip = (!r.station_id && !r.no_prep) || (r.no_prep && r.skip_window);   // straight to the front counter
        const skipWin = r.skip_window && !skip && !r.no_prep;
        const pack = l.mods.some((m) => /take ?away/i.test(m)) ? 'BOX' : online ? 'BOX' : 'PLATE';
        this.items.push({
          id: uuid(), order_id: o.id, square_uid: 'u' + idx, variation_id: l.it.variation_id, item_name: l.it.item_name,
          variation_name: null, category_name: l.it.category_name, station_id: r.station_id, no_prep: r.no_prep || skip, skip_window: skipWin,
          qty: l.qty, modifiers: l.mods, note: l.note, pack, qty_prep: r.no_prep || skip ? l.qty : 0, qty_window: skip ? l.qty : 0, qty_front: 0,
          removed: false, sort: idx, created_at: iso(at), prepared_at: r.no_prep || skip ? iso(at) : null, window_at: skip ? iso(at) : null, collected_at: null,
        });
      });
      // move older demo orders along a bit so every screen has something
      if (opts.advance) {
        const its = this.items.filter((i) => i.order_id === o.id);
        const a = opts.advance;
        its.forEach((it, k) => {
          if (a > 8 || (a > 5 && k === 0)) this._bump(it.id, 'prep', a > 6 ? null : 1, 'seed', false, new Date(at.getTime() + 4 * 60e3));
          if (a > 10 || (a > 8.5 && k === 0)) this._bump(it.id, 'window', null, 'seed', false, new Date(at.getTime() + 7 * 60e3));
        });
      }
      this._refresh(o.id);
      return o;
    }
    _history() {
      // 7 days of completed orders for the reports
      let s = 1;
      const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
      const saveSeq = this.seq;
      for (let d = 7; d >= 1; d--) {
        const day = new Date(); day.setDate(day.getDate() - d); day.setHours(9, 0, 0, 0);
        const count = 45 + Math.floor(rnd() * 40);
        this.seq = 100;
        for (let k = 0; k < count; k++) {
          const hour = 9 + Math.floor(Math.pow(rnd(), 0.8) * 11);
          const at = new Date(day.getTime() + (hour - 9) * 3600e3 + rnd() * 3600e3);
          const r0 = Math.random; Math.random = rnd;
          const o = this._newOrder(at);
          Math.random = r0;
          const its = this.items.filter((i) => i.order_id === o.id);
          let readyMax = 0;
          its.forEach((it) => {
            const slow = it.station_id === 'st-pizza' ? 1.5 : it.station_id === 'st-drinks' ? 0.6 : 1;
            const pt = (3 + rnd() * 9) * slow;
            if (!it.no_prep) {
              if (it.qty > 1 && rnd() < 0.5) {
                this._bump(it.id, 'prep', 1, 'hist', false, new Date(at.getTime() + pt * 0.7 * 60e3));
                this._bump(it.id, 'prep', null, 'hist', false, new Date(at.getTime() + pt * 60e3));
              } else this._bump(it.id, 'prep', null, 'hist', false, new Date(at.getTime() + pt * 60e3));
            }
            readyMax = Math.max(readyMax, it.no_prep ? 1 : pt);
          });
          const wt = readyMax + 0.8 + rnd() * 2.5;
          its.forEach((it) => this._bump(it.id, 'window', null, 'hist', false, new Date(at.getTime() + wt * 60e3)));
          const ct = wt + 0.5 + rnd() * 5;
          its.forEach((it) => this._bump(it.id, 'front', null, 'hist', false, new Date(at.getTime() + ct * 60e3)));
        }
      }
      this.seq = saveSeq;
    }
    // ---- logic (mirror of the SQL functions) ----
    _refresh(orderId, when = now()) {
      const o = this.orders.find((x) => x.id === orderId);
      if (!o || o.status === 'cancelled') return;
      const its = this.items.filter((i) => i.order_id === orderId && !i.removed);
      if (!its.length) return;
      const allP = its.every((i) => i.qty_prep >= i.qty), allW = its.every((i) => i.qty_window >= i.qty), allF = its.every((i) => i.qty_front >= i.qty);
      const any = its.some((i) => (i.qty_prep > 0 && !i.no_prep) || (i.qty_window > 0 && !i.no_prep) || i.qty_front > 0);
      o.status = allF ? 'completed' : allW ? 'ready' : allP ? 'at_window' : any ? 'preparing' : 'new';
      const w = iso(when);
      o.first_bump_at = any ? o.first_bump_at || w : null;
      o.prepared_at = allP ? o.prepared_at || w : null;
      o.ready_at = allW ? o.ready_at || w : null;
      o.completed_at = allF ? o.completed_at || w : null;
      o.updated_at = w;
    }
    _bump(itemId, stage, qty, screen, force, when = now()) {
      const it = this.items.find((i) => i.id === itemId);
      if (!it) throw new Error('Item not found');
      const o = this.orders.find((x) => x.id === it.order_id);
      if (o.status === 'cancelled') throw new Error('Order was cancelled');
      const avail = stage === 'prep' ? it.qty - it.qty_prep
        : stage === 'window' ? (force ? it.qty - it.qty_window : it.qty_prep - it.qty_window)
        : (force ? it.qty - it.qty_front : it.qty_window - it.qty_front);
      const n = Math.min(qty == null ? avail : qty, avail);
      if (n <= 0) return 0;
      const w = iso(when);
      const ev = (st, q, f) => this.events.push({ id: this.evSeq++, order_id: it.order_id, order_item_id: it.id, station_id: it.station_id, stage: st, qty: q, screen, forced: f, undone: false, at: w });
      if (force && stage !== 'prep') {
        const need = (stage === 'front' ? it.qty_front : it.qty_window) + n - it.qty_prep;
        if (need > 0) { it.qty_prep += need; if (it.qty_prep >= it.qty) it.prepared_at = it.prepared_at || w; ev('prep', need, true); }
        if (stage === 'front') {
          const needW = it.qty_front + n - it.qty_window;
          if (needW > 0) { it.qty_window += needW; if (it.qty_window >= it.qty) it.window_at = it.window_at || w; ev('window', needW, true); }
        }
      }
      if (stage === 'prep') {
        it.qty_prep += n; if (it.qty_prep >= it.qty) it.prepared_at = it.prepared_at || w;
        if (it.skip_window) { it.qty_window = Math.min(it.qty, it.qty_window + n); if (it.qty_window >= it.qty) it.window_at = it.window_at || w; }
      }
      else if (stage === 'window') { it.qty_window += n; if (it.qty_window >= it.qty) it.window_at = it.window_at || w; }
      else { it.qty_front += n; if (it.qty_front >= it.qty) it.collected_at = it.collected_at || w; }
      ev(stage, n, !!force);
      this._refresh(it.order_id, when);
      return n;
    }
    _emit(t) { setTimeout(() => this.listeners.forEach((f) => f(t || 'orders')), 30); }

    // ---- interface ----
    async loadConfig() {
      return { settings: { ...this.settings }, stations: this.stations.map((s) => ({ ...s })),
        categories: this.categories.map((c) => ({ ...c })), catalog: this.catalog.map((c) => ({ ...c })),
        presets: this.presets.map((p) => ({ ...p })), media: this.media.map((m) => ({ ...m })) };
    }
    async loadActive(recentMinutes = 30) {
      const recent = Date.now() - recentMinutes * 60e3;
      const orders = this.orders.filter((o) => ['new', 'preparing', 'at_window', 'ready'].includes(o.status) || new Date(o.updated_at) >= recent)
        .filter((o) => new Date(o.received_at) > Date.now() - 36 * 3600e3);
      const ids = new Set(orders.map((o) => o.id));
      return { orders: orders.map((o) => ({ ...o })), items: this.items.filter((i) => ids.has(i.order_id)).map((i) => ({ ...i, modifiers: [...i.modifiers] })) };
    }
    subscribe(onChange, onStatus) {
      this.listeners = [onChange]; onStatus && onStatus(true);
      clearInterval(this._gen);
      this._gen = setInterval(() => { if (Math.random() < 0.5) { this._newOrder(now()); this._emit('orders'); } }, 25000);
    }
    async bump(itemId, stage, qty, screen, force) { const n = this._bump(itemId, stage, qty, screen, force); this._emit(); return n; }
    async bumpOrder(orderId, stage, stationId, screen, force) {
      let t = 0;
      this.items.filter((i) => i.order_id === orderId && !i.removed && (!stationId || i.station_id === stationId) && (stage !== 'prep' || !i.no_prep))
        .sort((a, b) => a.sort - b.sort).forEach((i) => { t += this._bump(i.id, stage, null, screen, force); });
      this._emit(); return t;
    }
    async recall(eventId) {
      const e = this.events.find((x) => x.id === eventId);
      if (!e || e.undone || e.qty <= 0) throw new Error('Nothing to recall');
      const it = this.items.find((i) => i.id === e.order_item_id);
      if (e.stage === 'prep' && it.skip_window) { if (it.qty_window - e.qty < it.qty_front) throw new Error('Already collected — recall it on the front screen first'); it.qty_prep -= e.qty; it.qty_window = Math.max(0, it.qty_window - e.qty); it.prepared_at = null; it.window_at = null; }
      else if (e.stage === 'prep') { if (it.qty_prep - e.qty < it.qty_window) throw new Error('Already finished at the window — recall it there first'); it.qty_prep -= e.qty; it.prepared_at = null; }
      else if (e.stage === 'window') { if (it.qty_window - e.qty < it.qty_front) throw new Error('Already collected — recall it on the front screen first'); it.qty_window -= e.qty; it.window_at = null; }
      else { it.qty_front -= e.qty; it.collected_at = null; }
      e.undone = true;
      this.events.push({ ...e, id: this.evSeq++, qty: -e.qty, recall_of: e.id, undone: true, at: iso(now()) });
      this._refresh(e.order_id); this._emit();
    }
    async recentEvents(stage, stationId, minutes = 90) {
      const since = Date.now() - minutes * 60e3;
      return this.events.filter((e) => e.stage === stage && !e.undone && e.qty > 0 && new Date(e.at) >= since && (!stationId || e.station_id === stationId))
        .sort((a, b) => b.id - a.id).slice(0, 40).map((e) => {
          const it = this.items.find((i) => i.id === e.order_item_id); const o = this.orders.find((x) => x.id === e.order_id);
          return { id: e.id, qty: e.qty, at: e.at, forced: e.forced, order_id: e.order_id, order_item_id: e.order_item_id, item_name: it?.item_name, variation_name: it?.variation_name, order_no: o?.order_no };
        });
    }
    async setAvailability(itemId, available) {
      await new Promise((r) => setTimeout(r, 500));
      this.catalog.filter((c) => c.item_id === itemId).forEach((c) => (c.available = available));
      this._emit('catalog_items'); return { ok: true, demo: true };
    }
    async setAvailabilityVariations(ids, available) { return this.setAvailabilityMany(ids.map((id) => ({ variation_id: id, available }))); }
    async setAvailabilityMany(changes) {
      await new Promise((r) => setTimeout(r, 400)); let n = 0;
      changes.forEach((c) => { const row = this.catalog.find((x) => x.variation_id === c.variation_id); if (row && row.available !== c.available) { row.available = c.available; row.stock_qty = c.available ? 1000 : 0; n++; } });
      this._emit('catalog_items'); return { ok: true, applied: n, failed: [], demo: true };
    }
    async setMenuFlags(ids, patch) {
      this.catalog.filter((c) => ids.includes(c.variation_id)).forEach((c) => {
        if ('jain' in patch) c.jain = !!patch.jain; if ('is_new' in patch) c.is_new = !!patch.is_new;
        if ('wait_min' in patch) c.wait_min = patch.wait_min || null; if ('addon' in patch) c.addon = (patch.addon || '').trim() || null;
        if ('board_category' in patch) c.board_category = patch.board_category || null;
      }); return ids.length;
    }
    async clearWaits() { this.catalog.forEach((c) => (c.wait_min = null)); }
    async setMenuSetting(key, value) { this.settings[key] = value; }
    async savePreset(name, ids) { this.presets = this.presets.filter((p) => p.name !== name).concat([{ name, variation_ids: ids }]); }
    async deletePreset(name) { this.presets = this.presets.filter((p) => p.name !== name); }
    async liveWaits() { return {}; }
    async uploadMedia(file, kind, itemName) {
      const url = URL.createObjectURL(file);
      if (kind === 'item') this.media = this.media.filter((m) => !(m.kind === 'item' && m.item_name.toLowerCase() === itemName.toLowerCase()));
      this.media.push({ id: uuid(), kind, item_name: kind === 'item' ? itemName : null, path: file.name, url, is_video: /^video\//.test(file.type), sort: file.name.toLowerCase() });
    }
    async deleteMedia(id) { this.media = this.media.filter((m) => m.id !== id); }
    async syncCatalog() { await new Promise((r) => setTimeout(r, 600)); return { ok: true, categories: this.categories.length, variations: this.catalog.length, demo: true }; }
    async syncOrders() { return { ok: true, ingested: 0, demo: true }; }
    // ---- demo sales history: two years of made-up but realistic trading, built from the real menu
    _salesDay(day) {
      this._sd = this._sd || new Map();
      if (this._sd.has(day)) return this._sd.get(day);
      let h = 2166136261; for (const ch of day) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      let seed = h >>> 0; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const d = new Date(day + 'T12:00:00'), dow = d.getDay();
      const growth = Math.pow(1.11, (d - new Date('2024-10-01')) / (365 * 864e5));        // ~11% a year
      const season = 1 + 0.12 * Math.cos(((d.getMonth() + 1) - 1) / 12 * 2 * Math.PI);   // busier in summer
      const wk = [1.45, 0.8, 0.85, 0.9, 0.95, 1.2, 1.55][dow];
      const nOrders = Math.round(95 * growth * season * wk * (0.85 + rnd() * 0.3));
      if (!this._menu) this._menu = this.catalog.filter((c) => c.price_cents > 0 && !/SWEETS/.test(c.category_name || ''));
      const menu = this._menu, hourW = [0, 0, 0, 0, 0, 0, 0, 1, 3, 4, 5, 8, 14, 12, 7, 5, 5, 6, 9, 8, 4, 1, 0, 0];
      const hourSum = hourW.reduce((a, b) => a + b, 0);
      const orders = [];
      for (let i = 0; i < nOrders; i++) {
        let r = rnd() * hourSum, hour = 0; while (r > hourW[hour]) { r -= hourW[hour]; hour++; }
        const online = rnd() < 0.12 + 0.06 * (growth - 1) * 4;
        const lines = []; const n = 1 + Math.floor(rnd() * rnd() * 4);
        for (let k = 0; k < n; k++) {
          const it = menu[Math.floor(Math.pow(rnd(), 1.6) * menu.length)];
          const qty = rnd() < 0.85 ? 1 : 2;
          lines.push({ name: it.item_name, cat: it.category_name || 'Other', qty, net: it.price_cents * qty });
        }
        orders.push({ id: day + '-' + i, hour, ch: online ? 'Online' : 'Walk-in', lines });
      }
      this._sd.set(day, orders); return orders;
    }
    _days(from, to) { const out = []; const d = new Date(from + 'T12:00:00'), e = new Date(to + 'T12:00:00'); const today = new Date();
      for (; d <= e && d <= today; d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); return out; }
    async importSales(from, to) { await new Promise((r) => setTimeout(r, 150)); return { ok: true, orders: this._days(from, to).reduce((a, d) => a + this._salesDay(d).length, 0), lines: 0, demo: true }; }
    async salesCoverage() { return { first_day: '2024-10-01', last_day: this._days('2024-10-01', '2099-01-01').pop(), lines: 1, imported_at: iso(now()) }; }
    async salesMonthly(from, to) {
      const m = new Map();
      this._days(from, to).forEach((d) => { const k = d.slice(0, 7); if (!m.has(k)) m.set(k, { m: k, orders: 0, units: 0, sales: 0, days: 0 }); const x = m.get(k); x.days++;
        this._salesDay(d).forEach((o) => { x.orders++; o.lines.forEach((l) => { x.units += l.qty; x.sales += l.net; }); }); });
      return [...m.values()];
    }
    async salesReport(from, to) {
      const T = { orders: 0, units: 0, sales: 0 }, byDay = [], byHour = new Map(), byDow = new Map(), heat = new Map(), ch = new Map(), cat = new Map(), items = new Map();
      const add = (map, k, init) => { if (!map.has(k)) map.set(k, { ...init }); return map.get(k); };
      this._days(from, to).forEach((d) => {
        const dow = ((new Date(d + 'T12:00:00').getDay() + 6) % 7) + 1, D = { d, orders: 0, units: 0, sales: 0 };
        add(byDow, dow, { dow, orders: 0, sales: 0, days: 0 }).days++;
        const seenHours = new Set();
        this._salesDay(d).forEach((o) => {
          const net = o.lines.reduce((a, l) => a + l.net, 0), units = o.lines.reduce((a, l) => a + l.qty, 0);
          T.orders++; T.units += units; T.sales += net; D.orders++; D.units += units; D.sales += net;
          const H = add(byHour, o.hour, { h: o.hour, orders: 0, units: 0, sales: 0 }); H.orders++; H.units += units; H.sales += net;
          const W = byDow.get(dow); W.orders++; W.sales += net;
          const hk = dow + ':' + o.hour, X = add(heat, hk, { dow, h: o.hour, orders: 0, days: 0 }); X.orders++; if (!seenHours.has(hk)) { seenHours.add(hk); X.days++; }
          const C = add(ch, o.ch, { ch: o.ch, orders: 0, sales: 0 }); C.orders++; C.sales += net;
          o.lines.forEach((l) => { const c = add(cat, l.cat, { name: l.cat, units: 0, sales: 0 }); c.units += l.qty; c.sales += l.net;
            const it = add(items, l.name, { name: l.name, cat: l.cat, units: 0, sales: 0, orders: 0 }); it.units += l.qty; it.sales += l.net; it.orders++; });
        });
        if (D.orders) byDay.push(D);
      });
      const srt = (m, k) => [...m.values()].sort((a, b) => a[k] - b[k]);
      return { from, to, totals: T, discounts: 0, by_day: byDay, by_hour: srt(byHour, 'h'), by_weekday: srt(byDow, 'dow'), heat: [...heat.values()],
        by_channel: [...ch.values()], by_category: srt(cat, 'sales').reverse(), items: srt(items, 'sales').reverse().slice(0, 200) };
    }
    async testSquare() { return { ok: true, location: 'Shayona Cafe (demo)', business: 'BAPS Shayona Cafe', timezone: 'Australia/Sydney' }; }
    async closeOpenOrders() {
      let n = 0;
      this.orders.filter((o) => !['completed', 'cancelled'].includes(o.status)).forEach((o) => {
        this.items.filter((i) => i.order_id === o.id).forEach((i) => this._bump(i.id, 'front', null, 'close-day', true));
        o.forced = true; n++;
      });
      this._emit(); return n;
    }
    async saveStation(s) {
      if (s.id) Object.assign(this.stations.find((x) => x.id === s.id), s);
      else this.stations.push({ ...s, id: uuid(), active: true });
      this.stations.sort((a, b) => a.sort - b.sort); this._emit('stations');
    }
    async deleteStation(id) {
      this.stations = this.stations.filter((s) => s.id !== id);
      this.categories.forEach((c) => { if (c.station_id === id) c.station_id = null; });
      this.catalog.forEach((c) => { if (c.station_id === id) c.station_id = null; });
      this._emit('stations');
    }
    async setCategoryRoute(catId, stationId, noPrep) { Object.assign(this.categories.find((c) => c.square_id === catId), { station_id: stationId || null, no_prep: !!noPrep }); }
    async setItemRoute(itemId, stationId, noPrep) { this.catalog.filter((c) => c.item_id === itemId).forEach((c) => Object.assign(c, { station_id: stationId || null, no_prep: noPrep })); }
    async saveSetting(key, value) { this.settings[key] = value; }
    async setCategoryHold(catId, hold) { this.categories.find((c) => c.square_id === catId).hold = !!hold; }
    async setItemHold(itemId, hold) { this.catalog.filter((c) => c.item_id === itemId).forEach((c) => (c.hold = hold)); }
    async setCategorySkipWindow(catId, v) { this.categories.find((c) => c.square_id === catId).skip_window = !!v; }
    async setItemSkipWindow(itemId, v) { this.catalog.filter((c) => c.item_id === itemId).forEach((c) => (c.skip_window = v)); }
    async reportRows(fromIso, toIso) {
      const f = new Date(fromIso), t = new Date(toIso);
      const sName = Object.fromEntries(this.stations.map((s) => [s.id, s.name]));
      const out = [];
      this.orders.filter((o) => new Date(o.received_at) >= f && new Date(o.received_at) < t).forEach((o) => {
        this.items.filter((i) => i.order_id === o.id && !i.removed).forEach((it) => {
          out.push(K.buildReportRow(o, it, this.events.filter((e) => e.order_item_id === it.id), sName[it.station_id]));
        });
      });
      return out;
    }
  }

  K.createAPI = function () {
    const cfg = window.KDS_CONFIG || {};
    const forceDemo = /[?&]demo=1/.test(location.search) || cfg.demo === true;
    const hasCfg = !!(String(cfg.supabaseUrl || '').trim() && String(cfg.supabaseAnonKey || '').trim());
    if (!forceDemo && hasCfg) {
      // never fall back to demo silently once the site is configured
      if (!window.supabase) throw new Error('The Supabase library (js/vendor/supabase.js) did not load. Check that the file was uploaded to GitHub, then refresh.');
      return new LiveAPI(cfg);
    }
    K.demoReason = forceDemo ? 'Demo was requested in the address (?demo=1).'
      : !window.KDS_CONFIG ? 'config.js was not found on the website.'
      : 'config.js on the website has no Supabase URL / key.';
    return new DemoAPI();
  };
})();
