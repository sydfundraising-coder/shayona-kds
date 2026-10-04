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
        auth: { persistSession: true, autoRefreshToken: true },
        realtime: { params: { eventsPerSecond: 20 } },
      });
      this.user = null; this.role = 'staff';
    }
    async init() {
      const { data } = await this.sb.auth.getSession();
      if (data.session) await this._loadProfile(data.session.user);
      this.sb.auth.onAuthStateChange((_e, session) => { if (!session) { this.user = null; } });
      return !!this.user;
    }
    async _loadProfile(user) {
      this.user = user;
      const { data } = await this.sb.from('profiles').select('role,display_name').eq('user_id', user.id).maybeSingle();
      this.role = data?.role || 'staff';
    }
    async signIn(email, password) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await this._loadProfile(data.user);
    }
    async signOut() { await this.sb.auth.signOut(); this.user = null; }
    _chk({ data, error }) { if (error) throw new Error(error.message); return data; }

    async loadConfig() {
      const [settings, stations, categories, catalog] = await Promise.all([
        this.sb.from('kds_settings').select('key,value').then((r) => this._chk(r)),
        this.sb.from('stations').select('*').order('sort').then((r) => this._chk(r)),
        this.sb.from('categories').select('*').order('name').then((r) => this._chk(r)),
        this._all(() => this.sb.from('catalog_items').select('*').eq('is_deleted', false).order('item_name')),
      ]);
      return { settings: Object.fromEntries(settings.map((r) => [r.key, r.value])), stations, categories, catalog };
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
      if (this.channel) this.sb.removeChannel(this.channel);
      const ch = this.sb.channel('kds-live');
      ['orders', 'order_items', 'catalog_items', 'stations'].forEach((t) =>
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => onChange(t, p)));
      ch.subscribe((status) => onStatus && onStatus(status === 'SUBSCRIBED'));
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
    syncCatalog() { return this._fn('square-sync', { action: 'catalog' }); }
    syncOrders(minutes = 60) { return this._fn('square-sync', { action: 'orders', minutes }); }
    testSquare() { return this._fn('square-sync', { action: 'test' }); }
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
        station_id: route[n] || null, no_prep: n === 'BAKERY' || n === 'SWEETS & PACKAGED',
      })).sort((a, b) => a.name.localeCompare(b.name));
      const catByName = Object.fromEntries(this.categories.map((c) => [c.name, c]));
      this.catalog = window.KDS_DEMO_MENU.map(([name, cat, ta, jain, coffee, itemId, varId]) => ({
        variation_id: varId, item_id: itemId, item_name: name, variation_name: null,
        category_id: catByName[cat].square_id, category_name: cat,
        station_id: null,
        no_prep: /\d+\s?ML\b/i.test(name) && !/LASSI|SHAKE/i.test(name) ? true : null, // bottled drinks
        available: true, _ta: ta, _jain: jain, _coffee: coffee,
      }));
      this.catalog.find((c) => c.item_name === 'MASALA PUFF').available = false;
      this.settings = {
        square_location_id: 'LTK7KJ67PRKJW', timezone: 'Australia/Sydney',
        takeaway_keywords: ['take away', 'takeaway', 'take-away', 'box', 'to go'],
        plate_keywords: ['plate', 'dine in', 'eat in', 'for here'],
        default_pack: 'PLATE', online_pack: 'BOX',
        online_sources: ['square online', 'online', 'uber', 'doordash', 'menulog', 'website'],
        timer_warn_minutes: 5, timer_late_minutes: 10, front_clear_minutes: 10,
        availability_mode: 'inventory', available_stock: 999,
        pack_hidden_categories: ['HOT BEVERAGES', 'BEVERAGES'],
      };
      this.orders = []; this.items = []; this.events = []; this.evSeq = 1;
      this._history();
      // live orders at various ages
      const ages = [14, 11, 9, 7.5, 6, 4, 3, 2, 1.2, 0.5];
      ages.forEach((a, i) => this._newOrder(new Date(Date.now() - a * 60e3), { advance: a, i }));
    }
    _route(cat) {
      const c = this.categories.find((x) => x.square_id === cat.category_id);
      const noPrep = cat.no_prep ?? c?.no_prep ?? false;
      return { station_id: noPrep ? null : (cat.station_id || c?.station_id || null), no_prep: noPrep };
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
      this._pickLines(rand).forEach((l, idx) => {
        const r = this._route(l.it);
        const pack = l.mods.some((m) => /take ?away/i.test(m)) ? 'BOX' : online ? 'BOX' : 'PLATE';
        this.items.push({
          id: uuid(), order_id: o.id, square_uid: 'u' + idx, variation_id: l.it.variation_id, item_name: l.it.item_name,
          variation_name: null, category_name: l.it.category_name, station_id: r.station_id, no_prep: r.no_prep,
          qty: l.qty, modifiers: l.mods, note: l.note, pack, qty_prep: r.no_prep ? l.qty : 0, qty_window: 0, qty_front: 0,
          removed: false, sort: idx, created_at: iso(at), prepared_at: r.no_prep ? iso(at) : null, window_at: null, collected_at: null,
        });
      });
      // move older demo orders along a bit so every screen has something
      if (opts.advance) {
        const its = this.items.filter((i) => i.order_id === o.id);
        const a = opts.advance;
        its.forEach((it, k) => {
          if (a > 8 || (a > 5 && k === 0)) this._bump(it.id, 'prep', a > 6 ? null : 1, 'seed', false, new Date(at.getTime() + 4 * 60e3));
          if (a > 10) this._bump(it.id, 'window', null, 'seed', false, new Date(at.getTime() + 7 * 60e3));
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
      const any = its.some((i) => (i.qty_prep > 0 && !i.no_prep) || i.qty_window > 0);
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
      if (stage === 'prep') { it.qty_prep += n; if (it.qty_prep >= it.qty) it.prepared_at = it.prepared_at || w; }
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
        categories: this.categories.map((c) => ({ ...c })), catalog: this.catalog.map((c) => ({ ...c })) };
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
      if (e.stage === 'prep') { if (it.qty_prep - e.qty < it.qty_window) throw new Error('Already finished at the window — recall it there first'); it.qty_prep -= e.qty; it.prepared_at = null; }
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
    async syncCatalog() { await new Promise((r) => setTimeout(r, 600)); return { ok: true, categories: this.categories.length, variations: this.catalog.length, demo: true }; }
    async syncOrders() { return { ok: true, ingested: 0, demo: true }; }
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
    if (!forceDemo && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) return new LiveAPI(cfg);
    return new DemoAPI();
  };
})();
