/* Feeds the TV menu board + slideshow from the KDS (Supabase) instead of the old local Menu Manager.
 * The board/slideshow pages still call fetch('/api/board'), '/api/slideshow' and '/api/notice';
 * this file answers those calls with the same data shape the Menu Manager used to send. */
(function () {
  const cfg = window.KDS_CONFIG || {};
  const live = !!(String(cfg.supabaseUrl || '').trim() && String(cfg.supabaseAnonKey || '').trim() && window.supabase && !cfg.demo);
  const sb = live ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false } }) : null;
  let cache = null, cacheAt = 0;

  function demoFeed() {
    const cats = {};
    const items = (window.KDS_DEMO_MENU || []).map(([name, cat, ta, jain, coffee, itemId, varId, price]) => {
      const cid = 'cat-' + cat.replace(/\W+/g, '-').toLowerCase(); cats[cid] = cat;
      return { variation_id: varId, item_id: itemId, item_name: name, variation_name: null, category_id: cid, category_name: cat,
        category_ids: [cid], board_category: null, price_cents: price, description: '', available: name !== 'MASALA PUFF',
        jain: !!jain, is_new: name === 'MARGHERITA PIZZA', wait_min: name === 'PAV BHAJI' ? 15 : null, addon: null };
    });
    return { updatedAt: new Date().toISOString(), items, categories: cats, media: [], banner: '', notice: { active: false }, autoWaits: {} };
  }
  async function feed() {
    if (cache && Date.now() - cacheAt < 4000) return cache;
    if (sb) {
      const { data, error } = await sb.rpc('kds_menu_feed');
      if (error) throw new Error(error.message);
      cache = data;
    } else cache = demoFeed();
    cacheAt = Date.now();
    return cache;
  }
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // same shape as the Menu Manager's menuView()
  function menuView(f) {
    const byItem = new Map();
    (f.items || []).forEach((v) => {
      if (!byItem.has(v.item_id)) byItem.set(v.item_id, { id: v.item_id, name: v.item_name, rows: [] });
      byItem.get(v.item_id).rows.push(v);
    });
    return [...byItem.values()].map((it) => {
      const r0 = it.rows[0];
      const auto = r0.category_name || (f.categories || {})[r0.category_id] || 'UNCATEGORISED';
      return {
        id: it.id, name: it.name, category: r0.board_category || auto, categoryAuto: auto,
        description: r0.description || '', image_url: null, online_visible: r0.online_visible !== false,
        variations: it.rows.map((v) => ({
          id: v.variation_id, name: v.variation_name || '', price: v.price_cents == null ? null : v.price_cents / 100,
          available: !!v.available, jain: !!v.jain, addon: v.addon || '',
          wait: v.wait_min || (f.autoWaits || {})[v.variation_id] || 0, isNew: !!v.is_new,
        })),
      };
    });
  }
  function group(items) {
    const g = {};
    items.forEach((it) => (g[it.category] = g[it.category] || []).push(it));
    return Object.keys(g).sort().map((name) => ({ name, items: g[name].sort((a, b) => a.name.localeCompare(b.name)) }));
  }
  async function board() {
    const f = await feed();
    const items = menuView(f).filter((it) => it.variations.some((v) => v.available))
      .map((it) => ({ ...it, variations: it.variations.filter((v) => v.available) }));
    return { updatedAt: f.updatedAt || new Date().toISOString(), categories: group(items), banner: f.banner || '' };
  }
  async function slideshow() {
    const f = await feed();
    const media = f.media || [];
    const byName = {};
    media.filter((m) => m.kind === 'item').forEach((m) => {
      const k = normName(m.item_name);
      if (!byName[k] || (m.is_video && !byName[k].is_video)) byName[k] = m;   // a clip wins over a photo
    });
    const items = menuView(f).filter((it) => it.variations.some((v) => v.available));
    const slides = [];
    items.forEach((it) => {
      const m = byName[normName(it.name)]; if (!m) return;
      const v = it.variations.find((x) => x.available) || {};
      slides.push({ name: it.name, price: v.price, image: m.url, video: !!m.is_video, source: 'kds', isNew: !!v.isNew });
    });
    const promos = media.filter((m) => m.kind === 'promo').sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
    promos.forEach((p) => slides.push({ name: '', price: null, image: p.url, video: !!p.is_video, promo: true, isNew: false }));
    return { updatedAt: new Date().toISOString(), slides, localImages: Object.keys(byName).length, promos: promos.length, availableItems: items.length };
  }
  async function notice() { return (await feed()).notice || { active: false }; }

  const realFetch = window.fetch.bind(window);
  const reply = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function (url, opts) {
    const u = String(url && url.url ? url.url : url);
    try {
      if (u.startsWith('/api/board')) return reply(await board());
      if (u.startsWith('/api/slideshow')) return reply(await slideshow());
      if (u.startsWith('/api/notice')) return reply(await notice());
    } catch (e) {
      console.error('menu feed', e);
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 503 });
    }
    return realFetch(url, opts);
  };
  window.KDS_MENU_FEED = { feed, board, slideshow, notice, menuView };
})();
