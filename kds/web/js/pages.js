/* Pages: item availability, admin, reports */
(function () {
  const K = window.KDS, st = K.state, api = K.api, esc = K.esc;
  const app = () => document.getElementById('app');
  const pageTop = (title, back = '#/') => `<div class="topbar"><a class="iconbtn" href="${back}">←</a><div class="title">${esc(title)}</div><span class="grow"></span>${K.themeBtn()}<span class="conn ${st.connected ? '' : 'off'}"></span><span class="clock"></span></div>`;
  const demoFlag = () => (api.mode === 'demo' ? '<div class="demo-flag">DEMO</div>' : '');

  // ================================================================== availability
  K.routes.availability = function (r) {
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const stationId = r.q.get('station') || '';
    const back = stationId ? `#/station/${stationId}` : '#/';
    app().innerHTML = pageTop('Item availability', back) + `
      <div class="page">
        <div class="row" style="flex-wrap:wrap">
          <input id="q" placeholder="Search items…" class="grow" style="min-width:200px">
          <select id="stf"><option value="">All stations</option>${st.cfg.stations.map((s) => `<option value="${s.id}" ${s.id === stationId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__none">No-prep items</option></select>
          <select id="vf"><option value="">All items</option><option value="off">Unavailable only</option></select>
        </div>
        <p class="muted" style="font-size:.88em">Switching an item off marks it <b>sold out in Square</b> at Shayona Cafe (POS &amp; online) and shows it as listed as “Sold out” on the kitchen screens. Switch it back on when it's available again.</p>
        <div id="alist"></div>
      </div>${demoFlag()}`;
    const draw = () => {
      const q = K.$('#q').value.trim().toLowerCase(), sf = K.$('#stf').value, vf = K.$('#vf').value;
      // one row per Square item (variations share availability)
      const byItem = new Map();
      st.cfg.catalog.filter((c) => !c.is_deleted).forEach((c) => { if (!byItem.has(c.item_id)) byItem.set(c.item_id, c); else if (!c.available) byItem.get(c.item_id).available = false; });
      let rows = [...byItem.values()];
      if (q) rows = rows.filter((c) => c.item_name.toLowerCase().includes(q));
      if (sf === '__none') rows = rows.filter((c) => !K.routeOf(c));
      else if (sf) rows = rows.filter((c) => K.routeOf(c) === sf);
      if (vf === 'off') rows = rows.filter((c) => !c.available);
      const groups = {};
      rows.forEach((c) => (groups[c.category_name || 'Other'] = groups[c.category_name || 'Other'] || []).push(c));
      K.$('#alist').innerHTML = Object.keys(groups).sort().map((g) => `<h2>${esc(g)}</h2><div class="avail-grid">${groups[g].map((c) => `
        <div class="avail ${c.available ? '' : 'off'}"><span class="nm">${esc(c.item_name)}</span>
        <span class="muted" style="font-size:.8em">${c.available ? 'Available' : 'SOLD OUT'}</span>
        <button class="switch ${c.available ? 'on' : ''}" data-item="${esc(c.item_id)}" data-on="${c.available ? 1 : 0}" aria-label="Toggle availability"></button></div>`).join('')}</div>`).join('') || '<div class="empty">No items match</div>';
    };
    ['q', 'stf', 'vf'].forEach((id) => K.$('#' + id).addEventListener('input', draw));
    K.pageRefresh = draw;                          // live: redraw when availability changes anywhere
    K.$('#alist').onclick = async (e) => {
      const b = e.target.closest('.switch'); if (!b || b.classList.contains('busy')) return;
      const turnOn = b.dataset.on !== '1';
      const name = b.closest('.avail').querySelector('.nm').textContent;
      b.classList.add('busy');
      try {
        const res = await api.setAvailability(b.dataset.item, turnOn);
        if (res && res.failed && res.failed.length) throw new Error(res.failed.map((f) => f.reason).join('; '));
        st.cfg.catalog.filter((c) => c.item_id === b.dataset.item).forEach((c) => (c.available = turnOn));
        K.toast(`${name} is now ${turnOn ? 'AVAILABLE' : 'SOLD OUT'}${api.mode === 'demo' ? ' (demo — Square not changed)' : ' in Square'}`);
        draw();
      } catch (err) { K.toast(`Couldn't update ${name}: ${err.message}`, { error: true }); b.classList.remove('busy'); }
    };
    draw();
  };
  K.routes.availability.onData = () => {}; // don't wipe search while live data refreshes

  // ================================================================== admin
  K.routes.admin = function (r) {
    if (api.role !== 'admin') { app().innerHTML = pageTop('Admin') + '<div class="page"><h2>Admins only</h2></div>'; return; }
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const tab = r.q.get('tab') || 'stations';
    const tabs = [['health', '✚ Health check'], ['stations', 'Stations'], ['routing', 'Item routing'], ['settings', 'Settings'], ['square', 'Square & data'], ['links', 'Screen links']];
    app().innerHTML = pageTop('Admin') + `<div class="page"><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tab"></div></div>${demoFlag()}`;
    K.$('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/admin?tab=' + b.dataset.tab; };
    ({ health: tabHealth, stations: tabStations, routing: tabRouting, settings: tabSettings, square: tabSquare, links: tabLinks })[tab]();
  };
  K.routes.admin.static = true;

  // ------------------------------------------------------------------ health check: why aren't orders showing?
  function tabHealth() {
    if (!st.loaded) { K.$('#tab').innerHTML = '<div class="muted">Loading orders…</div>'; setTimeout(() => { if (K.$('#tab') && /tab=health|#\/admin$/.test(location.hash)) tabHealth(); }, 1000); return; }
    K.pageRefresh = tabHealth;                       // re-check when routing changes elsewhere
    const stations = st.cfg.stations.filter((x) => x.active);
    const cat = st.cfg.catalog.filter((c) => !c.is_deleted);
    const onMenu = cat.filter((c) => !('stock_qty' in c) || c.stock_qty != null);
    const catOf = (c) => st.cfg.categories.find((k) => k.square_id === c.category_id);
    const routed = onMenu.filter((c) => K.routeOf(c));
    const noPrep = onMenu.filter((c) => !K.routeOf(c) && (c.no_prep === true || (c.no_prep == null && catOf(c)?.no_prep)));
    const unassigned = onMenu.filter((c) => !K.routeOf(c) && !noPrep.includes(c));
    const skipW = routed.filter((c) => (c.skip_window != null ? c.skip_window : !!catOf(c)?.skip_window));
    const usedCats = [...new Set(onMenu.map((c) => c.category_id))].map((id) => st.cfg.categories.find((k) => k.square_id === id)).filter(Boolean);
    const catsRouted = usedCats.filter((k) => k.station_id || k.no_prep);
    const deadStation = (id) => id && !st.cfg.stations.some((x) => x.id === id && x.active);
    const catsDead = usedCats.filter((k) => deadStation(k.station_id));
    const open = st.orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
    const its = st.items.filter((i) => !i.removed && open.some((o) => o.id === i.order_id));
    const atStation = its.filter((i) => i.station_id && i.qty_prep < i.qty);
    const atWindow = its.filter((i) => i.qty_prep > i.qty_window && !i.skip_window);
    const noStation = its.filter((i) => !i.station_id);
    const itSkip = its.filter((i) => i.skip_window);
    const last = [...st.orders].sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
    const row = (ok, title, detail, fix) => `<div class="hc ${ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'bad'}"><div class="hc-i">${ok === true ? '✓' : ok === 'warn' ? '!' : '✗'}</div><div><b>${title}</b><div class="muted">${detail}</div>${fix ? `<div class="hc-fix">${fix}</div>` : ''}</div></div>`;
    K.$('#tab').innerHTML = `<p class="muted">A quick check of everything that decides which screen an order appears on. Fix the red items first.</p>
      ${row(true, 'KDS version', esc(K.VERSION || 'unknown') + ` · ${api.mode === 'demo' ? 'DEMO mode' : 'live'}`)}
      ${row(st.connected ? true : 'warn', 'Live connection', st.connected ? 'Connected — screens update instantly.' : 'Not connected right now — screens still refresh every 20 seconds.')}
      ${row(stations.length ? true : false, `${stations.length} active kitchen station(s)`, stations.map((x) => esc(x.name)).join(', ') || 'None', stations.length ? '' : '<a href="#/admin?tab=stations">Add stations →</a>')}
      ${row(catsDead.length ? false : true, 'Categories point to existing stations', catsDead.length ? `${catsDead.length} categor${catsDead.length > 1 ? 'ies point' : 'y points'} to a station that was deleted or switched off: ${catsDead.map((k) => esc(k.name)).join(', ')}` : 'Yes')}
      ${row(pct(catsRouted.length, usedCats.length) >= 60 ? true : false, `${catsRouted.length} of ${usedCats.length} menu categories have a station (or No prep)`,
        usedCats.filter((k) => !k.station_id && !k.no_prep).map((k) => esc(k.name)).slice(0, 20).join(', ') || 'All set',
        catsRouted.length < usedCats.length ? '<a href="#/admin?tab=routing">Set a station for each category →</a> Items in a category with no station skip the kitchen AND the window and go straight to the front counter.' : '')}
      ${row(pct(routed.length, onMenu.length) >= 50 ? (unassigned.length ? 'warn' : true) : false, `${routed.length} of ${onMenu.length} menu items go to a kitchen station`,
        `${noPrep.length} no prep (straight to window) · <b>${unassigned.length} not assigned</b> (straight to front counter) · ${skipW.length} skip the window`,
        unassigned.length ? '<a href="#/admin?tab=routing">Open Item routing →</a> and use the filter “Not assigned”.' : '')}
      ${row(skipW.length > routed.length / 2 && routed.length ? false : true, 'Skip window setting', skipW.length ? `${skipW.length} item(s) go from the station straight to the front: ${skipW.slice(0, 12).map((c) => esc(c.item_name)).join(', ')}${skipW.length > 12 ? '…' : ''}` : 'No items skip the window.', skipW.length ? '<a href="#/admin?tab=routing">Check “Skip window”</a> on the categories and items.' : '')}
      <h2>Orders open right now</h2>
      ${row(last ? true : 'warn', 'Orders arriving from Square', last ? `${open.length} open · last order received ${esc(new Date(last.received_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}` : 'No orders in the last 36 hours.')}
      ${row(open.length && noStation.length === its.length ? false : noStation.length ? 'warn' : true, `${noStation.length} of ${its.length} items on open orders came in with no station`,
        noStation.length ? 'These were routed before a station was set, so they went straight to the front counter.' : 'All open items have a station (or are No prep).',
        noStation.length ? 'After fixing routing above, run <b>013_reapply_routing_open_orders.sql</b> in Supabase → SQL Editor to move today’s unstarted items back to their stations.' : '')}
      ${row(true, 'Where open items are now', `${atStation.length} at kitchen stations · ${atWindow.length} at the order window · ${itSkip.length} set to skip the window`)}`;
  }
  const refreshAdmin = async () => { await K.loadConfig(); K.render(); };

  function tabStations() {
    const s = st.cfg.stations;
    K.$('#tab').innerHTML = `
      <p class="muted">Prep stations in the kitchen. Each one gets its own screen showing only its items. The Window and Front screens are built in.</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>Colour</th><th>Name</th><th class="n">Order</th><th class="n">Amber after (min)</th><th class="n">Red after (min)</th><th>Active</th><th></th></tr></thead>
      <tbody>${s.map((x) => `<tr><td><span class="swatch" style="display:inline-block;width:22px;height:22px;border-radius:6px;background:${esc(x.colour)}"></span></td>
        <td><b>${esc(x.name)}</b></td><td class="n">${x.sort}</td><td class="n">${x.warn_minutes || `<span class="faint">${K.setting('timer_warn_minutes', 5)}</span>`}</td>
        <td class="n">${x.late_minutes || `<span class="faint">${K.setting('timer_late_minutes', 10)}</span>`}</td><td>${x.active ? 'Yes' : 'No'}</td>
        <td><button class="btn sm" data-edit="${x.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No stations yet</td></tr>'}</tbody></table></div>
      <div style="margin-top:12px"><button class="btn primary" data-edit="">+ Add station</button></div>`;
    K.$('#tab').onclick = (e) => {
      const b = e.target.closest('[data-edit]'); if (!b) return;
      const x = s.find((y) => y.id === b.dataset.edit) || { name: '', colour: '#3b82f6', sort: s.length + 1, active: true };
      K.modal(x.id ? 'Edit station' : 'Add station', `
        <div class="field"><label>Name</label><input id="sn" value="${esc(x.name)}" placeholder="e.g. Pizza"></div>
        <div class="row"><div class="field grow"><label>Colour</label><input id="sc" type="color" value="${esc(x.colour)}" style="height:44px;padding:4px"></div>
        <div class="field grow"><label>Display order</label><input id="so" type="number" value="${x.sort}"></div></div>
        <div class="row"><div class="field grow"><label>Amber after (min)</label><input id="sw" type="number" min="1" value="${x.warn_minutes || ''}" placeholder="${K.setting('timer_warn_minutes', 5)}"></div>
        <div class="field grow"><label>Red after (min)</label><input id="sl" type="number" min="1" value="${x.late_minutes || ''}" placeholder="${K.setting('timer_late_minutes', 10)}"></div></div>
        <label class="row" style="margin-bottom:8px"><input id="sa" type="checkbox" ${x.active ? 'checked' : ''}> Active</label>
        <div class="actions">${x.id ? '<button class="btn danger" id="sdel">Delete</button><span class="grow"></span>' : ''}<button class="btn" id="sx">Cancel</button><button class="btn primary" id="ss">Save</button></div>`, (w, close) => {
        K.$('#sx', w).onclick = close;
        K.$('#ss', w).onclick = async () => {
          const name = K.$('#sn', w).value.trim(); if (!name) return K.toast('Enter a name', { error: true });
          try {
            await api.saveStation({ id: x.id, name, colour: K.$('#sc', w).value, sort: +K.$('#so', w).value,
              warn_minutes: +K.$('#sw', w).value || null, late_minutes: +K.$('#sl', w).value || null, active: K.$('#sa', w).checked });
            close(); K.toast('Station saved'); refreshAdmin();
          } catch (err) { K.toast(err.message, { error: true }); }
        };
        const del = K.$('#sdel', w);
        if (del) del.onclick = async () => {
          if (!(await K.confirm('Delete station?', `Items routed to <b>${esc(x.name)}</b> will become unassigned (they'll show on the Window screen until re-routed).`, 'Delete', true))) return;
          try { await api.deleteStation(x.id); close(); refreshAdmin(); } catch (err) { K.toast(err.message, { error: true }); }
        };
      });
    };
  }

  function stationSelect(value, noPrep, extraFollow) {
    return `<select data-route>
      ${extraFollow ? `<option value="__follow" ${value === '__follow' ? 'selected' : ''}>↳ Same as category</option>` : ''}
      <option value="" ${!value && !noPrep ? 'selected' : ''}>— Not assigned —</option>
      ${st.cfg.stations.map((s) => `<option value="${s.id}" ${value === s.id && !noPrep ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      <option value="__noprep" ${noPrep ? 'selected' : ''}>No prep → straight to Window</option></select>`;
  }

  function tabRouting() {
    const cats = st.cfg.categories;
    const items = st.cfg.catalog.filter((c) => !c.is_deleted);
    const usedCats = new Set(items.map((c) => c.category_id));
    const byItem = new Map(); items.forEach((c) => { if (!byItem.has(c.item_id)) byItem.set(c.item_id, c); });
    K.$('#tab').innerHTML = `
      <p class="muted">Decide which station makes each item. Set it once per <b>category</b>, then override single items if needed (e.g. bottled drinks = no prep).
      "No prep" items skip the stations and go straight to the Window. <b>Skip window</b> = made at the station, then straight to the front counter (never on the order handling window). Items left <b>Not assigned</b> skip the kitchen <i>and</i> the Window — they're ready to hand over at the front counter straight away (e.g. bottled water).</p>
      <h2>By category</h2>
      <div class="tablewrap" style="max-height:none"><table class="t"><thead><tr><th>Square category</th><th class="n">Items</th><th>Station</th><th title="Ready items wait at the counter until the whole order is ready (e.g. ice cream, hot drinks)">Hold until order complete</th><th title="Made at the station, then straight to the front counter — never shows on the order handling window">Skip order window</th></tr></thead><tbody>
      ${cats.filter((c) => usedCats.has(c.square_id)).map((c) => `<tr data-cat="${esc(c.square_id)}" ${!c.station_id && !c.no_prep ? 'style="box-shadow:inset 4px 0 0 var(--late)"' : ''}><td><b>${esc(c.name)}</b></td>
        <td class="n">${items.filter((i) => i.category_id === c.square_id).length}</td><td>${stationSelect(c.station_id, c.no_prep, false)}</td>
        <td><label class="row"><input type="checkbox" data-hold ${c.hold ? 'checked' : ''}> Hold</label></td>
        <td><label class="row"><input type="checkbox" data-skipw ${c.skip_window ? 'checked' : ''}> Skip window</label></td></tr>`).join('')}
      </tbody></table></div>
      <h2>Item overrides</h2>
      <div class="row" style="margin-bottom:8px"><input id="iq" placeholder="Search items…" class="grow"><select id="if"><option value="">All items</option><option value="unrouted">Not assigned</option><option value="over">Overridden only</option><option value="skipw">Skips window</option><option value="window">Goes to window</option></select></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Item</th><th>Category</th><th>Route</th><th>Override</th><th>Hold until complete</th><th>Order window</th></tr></thead><tbody id="ibody"></tbody></table></div>`;
    const drawItems = () => {
      const q = K.$('#iq').value.toLowerCase(), f = K.$('#if').value;
      let rows = [...byItem.values()];
      if (q) rows = rows.filter((c) => c.item_name.toLowerCase().includes(q));
      if (f === 'unrouted') rows = rows.filter((c) => !K.routeOf(c) && !isNoPrep(c));
      if (f === 'over') rows = rows.filter((c) => c.station_id || c.no_prep != null || c.skip_window != null || c.hold != null);
      if (f === 'skipw') rows = rows.filter((c) => K.routeOf(c) && !isNoPrep(c) && (c.skip_window != null ? c.skip_window : catSkip(c)));
      if (f === 'window') rows = rows.filter((c) => isNoPrep(c) || (K.routeOf(c) && !(c.skip_window != null ? c.skip_window : catSkip(c))));
      K.$('#ibody').innerHTML = rows.map((c) => {
        const r = K.routeOf(c), np = isNoPrep(c);
        const sw = c.skip_window != null ? c.skip_window : catSkip(c);
        const arrow = '<span class="muted"> → </span>';
        const goes = np ? `<span class="pill badge-walkin">No prep</span>${arrow}<span class="pill badge-online">Window</span>${arrow}Front`
          : r ? `<span class="pill" style="background:${esc(K.stationById(r)?.colour)};color:#fff">${esc(K.stationById(r)?.name)}</span>${arrow}${sw ? `<span class="pill badge-cancel" title="${c.skip_window != null ? 'Item setting' : 'Category setting'}">skips window${c.skip_window != null ? '' : ' (category)'}</span>` : '<span class="pill badge-online">Window</span>'}${arrow}Front`
          : '<span class="pill badge-cancel">Not assigned</span><span class="muted"> → straight to Front</span>';
        const val = c.no_prep === true ? '__noprep' : c.station_id || (c.no_prep === false ? '' : '__follow');
        return `<tr data-item="${esc(c.item_id)}"><td><b>${esc(c.item_name)}</b></td><td class="muted">${esc(c.category_name || '')}</td><td>${goes}</td><td>${stationSelect(val, c.no_prep === true, true)}</td>
          <td><select data-ihold><option value="" ${c.hold == null ? 'selected' : ''}>Same as category</option><option value="1" ${c.hold === true ? 'selected' : ''}>Hold</option><option value="0" ${c.hold === false ? 'selected' : ''}>Don't hold</option></select></td>
          <td><select data-iskipw><option value="" ${c.skip_window == null ? 'selected' : ''}>Same as category${catSkip(c) ? ' (skip)' : ''}</option><option value="1" ${c.skip_window === true ? 'selected' : ''}>Skip window</option><option value="0" ${c.skip_window === false ? 'selected' : ''}>Goes to window</option></select></td></tr>`;
      }).join('');
    };
    function catSkip(c) { return !!cats.find((k) => k.square_id === c.category_id)?.skip_window; }
    function isNoPrep(c) { if (c.no_prep != null) return c.no_prep; const cat = cats.find((k) => k.square_id === c.category_id); return !!cat?.no_prep && !c.station_id; }
    K.$('#iq').oninput = drawItems; K.$('#if').onchange = drawItems;
    K.$('#tab').onchange = async (e) => {
      const sw = e.target.closest('[data-skipw],[data-iskipw]');
      if (sw) {
        const tr = sw.closest('tr');
        try {
          if (sw.matches('[data-skipw]') && sw.checked) {
            const cat = cats.find((k) => k.square_id === tr.dataset.cat), n = items.filter((i) => i.category_id === tr.dataset.cat).length;
            if (!(await K.confirm(`Skip the window for ALL ${n} items in ${esc(cat.name)}?`, 'Every item in this category will go from the station straight to the front counter. To skip only a few items, leave this off and set "Order window → Skip window" on those items in the list below.', 'Skip window for all'))) { sw.checked = false; return; }
          }
          if (sw.matches('[data-skipw]')) { await api.setCategorySkipWindow(tr.dataset.cat, sw.checked); cats.find((k) => k.square_id === tr.dataset.cat).skip_window = sw.checked; drawItems(); }
          else { const v = sw.value === '' ? null : sw.value === '1'; await api.setItemSkipWindow(tr.dataset.item, v); st.cfg.catalog.filter((c) => c.item_id === tr.dataset.item).forEach((c) => (c.skip_window = v)); }
          K.toast('Saved — applies to orders on screen now and new orders');
        } catch (err) { K.toast(/skip_window/.test(err.message) ? 'Run 010_skip_window.sql in Supabase first' : err.message, { error: true }); }
        return;
      }
      const hc = e.target.closest('[data-hold],[data-ihold]');
      if (hc) {
        const tr = hc.closest('tr');
        try {
          if (hc.matches('[data-hold]')) { await api.setCategoryHold(tr.dataset.cat, hc.checked); cats.find((k) => k.square_id === tr.dataset.cat).hold = hc.checked; }
          else { const v = hc.value === '' ? null : hc.value === '1'; await api.setItemHold(tr.dataset.item, v); st.cfg.catalog.filter((c) => c.item_id === tr.dataset.item).forEach((c) => (c.hold = v)); }
          K.toast('Saved');
        } catch (err) { K.toast(err.message, { error: true }); }
        return;
      }
      const sel = e.target.closest('[data-route]'); if (!sel) return;
      const v = sel.value; const tr = sel.closest('tr');
      try {
        if (tr.dataset.cat) {
          await api.setCategoryRoute(tr.dataset.cat, v.startsWith('__') ? null : v, v === '__noprep');
          const c = cats.find((k) => k.square_id === tr.dataset.cat); c.station_id = v.startsWith('__') ? null : v || null; c.no_prep = v === '__noprep';
          tr.style.boxShadow = !c.station_id && !c.no_prep ? 'inset 4px 0 0 var(--late)' : '';
        } else {
          const station = v.startsWith('__') ? null : v || null;
          const noPrep = v === '__noprep' ? true : v === '__follow' ? null : false;
          await api.setItemRoute(tr.dataset.item, station, noPrep);
          st.cfg.catalog.filter((c) => c.item_id === tr.dataset.item).forEach((c) => { c.station_id = station; c.no_prep = noPrep; });
        }
        drawItems(); K.toast('Routing saved — applies to new orders');
      } catch (err) { K.toast(err.message, { error: true }); }
    };
    drawItems();
  }

  function tabSettings() {
    const s = st.cfg.settings;
    const list = (k) => esc((s[k] || []).join(', '));
    K.$('#tab').innerHTML = `<div class="card" style="max-width:720px">
      <div class="field"><label>Square location ID (Shayona Cafe)</label><input data-k="square_location_id" data-type="str" value="${esc(s.square_location_id || '')}"></div>
      <h2>End of day</h2>
      <div class="field"><label>Push all outstanding orders through to picked up at (every night)</label>
        <input type="time" data-k="auto_close_time" data-type="str" value="${esc(s.auto_close_time || '')}" style="max-width:160px">
        <div class="muted" style="font-size:.85em;margin-top:4px">Checked every 15 minutes between this time and 5 am. Clear the time to turn it off.${s.last_auto_close ? ` Last run: ${esc(new Date(s.last_auto_close.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))} — ${s.last_auto_close.orders} order(s) closed.` : ''}</div></div>
      <h2>Pickup</h2>
      <div class="field"><label>Mark an order "not collected" after (minutes)</label>
        <input type="number" min="0" max="60" data-k="uncollected_minutes" data-type="num" value="${esc(s.uncollected_minutes ?? 5)}" style="max-width:120px">
        <div class="muted" style="font-size:.85em;margin-top:4px">Overdue orders move to the top of the front counter with a reminder tone, flash on the pickup board, and ring the customer's phone again if they're tracking it. 0 = off.</div></div>
      <h2>Take away or dine-in</h2>
      <div class="field"><label>Modifier/note words that mean TAKE AWAY (comma separated)</label><input data-k="takeaway_keywords" data-type="list" value="${list('takeaway_keywords')}"></div>
      <div class="field"><label>Words that mean DINE-IN</label><input data-k="plate_keywords" data-type="list" value="${list('plate_keywords')}"></div>
      <div class="row"><div class="field grow"><label>Walk-in item with no modifier</label><select data-k="default_pack" data-type="str"><option value="PLATE" ${s.default_pack === 'PLATE' ? 'selected' : ''}>DINE-IN</option><option value="BOX" ${s.default_pack === 'BOX' ? 'selected' : ''}>TAKE AWAY</option></select></div>
      <div class="field grow"><label>Online order item with no modifier</label><select data-k="online_pack" data-type="str"><option value="BOX" ${s.online_pack === 'BOX' ? 'selected' : ''}>TAKE AWAY</option><option value="PLATE" ${s.online_pack === 'PLATE' ? 'selected' : ''}>DINE-IN</option></select></div></div>
      <div class="field"><label>Don't show the DINE-IN badge for these categories (e.g. drinks) — TAKE AWAY still shows</label><input data-k="pack_hidden_categories" data-type="list" value="${list('pack_hidden_categories')}"></div>
      <h2>Online orders</h2>
      <div class="field"><label>Order sources treated as ONLINE (comma separated, matched in the Square source name)</label><input data-k="online_sources" data-type="list" value="${list('online_sources')}"></div>
      <h2>Timers</h2>
      <div class="row"><div class="field grow"><label>Amber after (minutes)</label><input type="number" data-k="timer_warn_minutes" data-type="num" value="${s.timer_warn_minutes}"></div>
      <div class="field grow"><label>Red / late after (minutes)</label><input type="number" data-k="timer_late_minutes" data-type="num" value="${s.timer_late_minutes}"></div>
      <div class="field grow"><label>Keep collected orders for undo (min)</label><input type="number" data-k="front_clear_minutes" data-type="num" value="${s.front_clear_minutes}"></div></div>
      <h2>Availability switch</h2>
      <div class="row"><div class="field grow"><label>How "unavailable" is set in Square</label><select data-k="availability_mode" data-type="str">
        <option value="inventory" ${s.availability_mode !== 'hide' ? 'selected' : ''}>Stock = 0 → shows Sold Out (recommended)</option>
        <option value="hide" ${s.availability_mode === 'hide' ? 'selected' : ''}>Hide item from the café location</option></select></div>
      <div class="field grow"><label>Stock to set when switched back on (untracked items)</label><input type="number" data-k="available_stock" data-type="num" value="${s.available_stock}"></div></div>
      <div class="actions"><button class="btn primary" id="saveset">Save settings</button></div></div>`;
    K.$('#saveset').onclick = async () => {
      try {
        for (const el of K.$$('[data-k]')) {
          const t = el.dataset.type; let v = el.value;
          if (t === 'list') v = v.split(',').map((x) => x.trim()).filter(Boolean);
          if (t === 'num') v = +v;
          if (JSON.stringify(v) !== JSON.stringify(s[el.dataset.k])) await api.saveSetting(el.dataset.k, v);
        }
        K.toast('Settings saved'); refreshAdmin();
      } catch (err) { K.toast(err.message, { error: true }); }
    };
  }

  function tabSquare() {
    K.$('#tab').innerHTML = `<div class="card" style="max-width:720px">
      <h2 style="margin-top:0">Square connection</h2>
      <div class="row" style="flex-wrap:wrap"><button class="btn" data-sq="test">Test connection</button>
      <button class="btn" data-sq="catalog">Sync menu from Square</button>
      <button class="btn" data-sq="orders">Pull last 60 min of orders</button>
      <button class="btn" data-sq="today">Pull all of today's orders</button></div>
      <p class="muted" style="font-size:.88em">Orders arrive automatically through the Square webhook. "Pull orders" is a safety net if the internet dropped. The menu re-syncs automatically when you change it in Square.</p>
      <div id="sqout" class="muted"></div>
      <h2>End of day</h2>
      <p class="muted" style="font-size:.88em">Closes every order still open on the screens (marked as "forced" in reports so they don't skew prep times).</p>
      <button class="btn danger" data-sq="close">Close all open orders</button></div>`;
    K.$('#tab').onclick = async (e) => {
      const b = e.target.closest('[data-sq]'); if (!b) return;
      const out = K.$('#sqout'); b.disabled = true; out.textContent = 'Working…';
      try {
        const a = b.dataset.sq; let res;
        if (a === 'test') { res = await api.testSquare(); out.innerHTML = `✓ Connected to <b>${esc(res.location)}</b> (${esc(res.business || '')}, ${esc(res.timezone || '')})`; }
        if (a === 'catalog') { res = await api.syncCatalog(); out.textContent = `✓ Synced ${res.variations} items in ${res.categories} categories` + (res.available != null ? ` — ${res.available} available, ${res.sold_out} sold out in Square` : ''); await K.loadConfig(); }
        if (a === 'orders') { res = await api.syncOrders(60); out.textContent = `✓ ${res.ingested} order(s) pulled in`; K.reload(0); }
        if (a === 'today') {
          const mid = new Date(); mid.setHours(0, 0, 0, 0);
          const mins = Math.max(1, Math.ceil((Date.now() - mid) / 60e3));
          if (!(await K.confirm("Pull all of today's orders?", `Brings in every Square order since midnight (about ${Math.round(mins / 60)} hours). <b>Orders already served will also appear on the kitchen screens</b> — use <b>Close all open orders</b> afterwards to clear the old ones.`, 'Pull orders'))) { out.textContent = ''; return; }
          res = await api.syncOrders(mins); out.textContent = `✓ ${res.ingested} order(s) pulled in since midnight`; K.reload(0);
        }
        if (a === 'close') {
          if (!(await K.confirm('Close all open orders?', 'Everything still on the kitchen, window and front screens will be cleared.', 'Close all', true))) { out.textContent = ''; return; }
          res = await api.closeOpenOrders(0); out.textContent = `✓ Closed ${res} order(s)`; K.reload(0);
        }
      } catch (err) { out.innerHTML = `<span style="color:var(--late)">✕ ${esc(err.message)}</span>`; }
      finally { b.disabled = false; }
    };
  }

  function tabLinks() {
    const TVL = ['tv', 'slideshow', 'track', 'track?poster=1'];
    const links = [
      ...st.cfg.stations.filter((s) => s.active).sort((a, b) => a.sort - b.sort).map((s) => [s.name + ' station', K.stationSlug(s)]),
      ['Order handling window', 'window'], ['Front counter', 'front'], ['Customer pickup board (TV)', 'board'],
      ['Item availability', 'avail'], ['Menu control', 'menu'], ['Reports', 'reports'],
      ['TV menu board (no login)', 'tv'], ['Photo slideshow (no login)', 'slideshow'],
      ['Customer order tracker (no login) — put the QR on the counter', 'track'], ['Printable QR sign for the counter', 'track?poster=1'],
    ];
    K.$('#tab').innerHTML = `<p class="muted">Open each link on the tablet/TV for that spot and add it to the home screen (or bookmark it). Each screen remembers its own layout.
      Short addresses also work by number: <code>/1</code>, <code>/2</code>… opens station 1, 2… in display order.</p>
      <div class="tablewrap" style="max-height:none"><table class="t"><tbody>${links.map(([n, h]) => { const u = location.origin + '/' + h; return `<tr><td><b>${esc(n)}</b></td><td><code style="font-size:.85em;word-break:break-all">${esc(u)}</code></td>
      <td><button class="btn sm" data-copy="${esc(u)}">Copy</button> <a class="btn sm" href="${TVL.includes(h) ? '/' + h : '#/' + h}" ${TVL.includes(h) ? 'target="_blank" rel="noopener"' : ''}>Open</a></td></tr>`; }).join('')}</tbody></table></div>`;
    K.$('#tab').onclick = (e) => { const b = e.target.closest('[data-copy]'); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => K.toast('Link copied')); };
  }

  // ================================================================== reports
  K.routes.reports = function (r) {
    if (api.role !== 'admin') { app().innerHTML = pageTop('Reports') + '<div class="page"><h2>Admins only</h2></div>'; return; }
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const tab0 = r.q.get('tab') || 'sales';
    const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    app().innerHTML = pageTop('Reports') + `<div class="page">
      <div class="row" style="flex-wrap:wrap">
        <div class="seg" id="rng"><button data-r="today" class="on">Today</button><button data-r="yesterday">Yesterday</button><button data-r="7">Last 7 days</button><button data-r="30">Last 30 days</button><button data-r="month">This month</button><button data-r="lastmonth">Last month</button></div>
        <input type="date" id="rf" value="${ymd(today)}"><span class="muted">to</span><input type="date" id="rt" value="${ymd(today)}">
        <span id="kfil" class="row" style="flex-wrap:wrap"><select id="rs"><option value="">All stations</option>${st.cfg.stations.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <select id="ro"><option value="">Walk-in + online</option><option value="online">Online only</option><option value="walkin">Walk-in only</option></select>
        <input id="ri" placeholder="Item contains…" style="width:160px"></span>
        <button class="btn primary" id="rgo">Run report</button>
      </div>
      <div class="tabs" id="rtabs">${[['sales', 'Sales & trends'], ['summary', 'Kitchen summary'], ['station', 'By station'], ['item', 'By item'], ['order', 'By order'], ['hour', 'By hour']].map(([k, l], i) => `<button data-t="${k}" class="${k === tab0 ? 'on' : ''}">${l}</button>`).join('')}
        <span class="grow"></span><button class="btn sm" id="csv">⬇ Download CSV</button></div>
      <div id="rout"><div class="muted">Loading…</div></div>
      <p class="faint" style="font-size:.82em" id="rfoot">Times are measured from when the order reached the kitchen. "Forced" bumps (finished without a station bump, or end-of-day close) are excluded from time averages.</p>
    </div>${demoFlag()}`;
    const R = { rows: [], tab: tab0, table: null, loaded: '' };
    K.$('#rng').onclick = (e) => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      K.$$('#rng button').forEach((x) => x.classList.toggle('on', x === b));
      const t = new Date(), f = new Date();
      if (b.dataset.r === 'yesterday') { f.setDate(f.getDate() - 1); t.setDate(t.getDate() - 1); }
      else if (b.dataset.r === 'month') f.setDate(1);
      else if (b.dataset.r === 'lastmonth') { f.setMonth(f.getMonth() - 1, 1); t.setDate(0); }
      else if (b.dataset.r !== 'today') f.setDate(f.getDate() - (+b.dataset.r - 1));
      K.$('#rf').value = ymd(f); K.$('#rt').value = ymd(t); R.loaded = ''; run();
    };
    K.$('#rtabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; K.$$('#rtabs [data-t]').forEach((x) => x.classList.toggle('on', x === b)); R.tab = b.dataset.t; history.replaceState(null, '', '#/reports?tab=' + R.tab); run(); };
    K.$('#rgo').onclick = () => { R.loaded = ''; run(); };
    ['rs', 'ro'].forEach((id) => (K.$('#' + id).onchange = draw)); K.$('#ri').oninput = draw;
    K.$('#csv').onclick = () => {
      if (!R.table) return;
      const csv = [R.table.head, ...R.table.rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `kds-${R.tab}-${K.$('#rf').value}_${K.$('#rt').value}.csv`; a.click();
    };

    async function run() {
      const sales = R.tab === 'sales';
      K.$('#kfil').style.display = sales ? 'none' : ''; K.$('#csv').style.display = sales ? 'none' : ''; K.$('#rfoot').style.display = sales ? 'none' : '';
      if (K.$('#rf').value > K.$('#rt').value) K.$('#rt').value = K.$('#rf').value;
      if (sales && !K.renderSales) { K.$('#rout').innerHTML = '<div class="banner">The new report files (js/charts.js and js/reports-sales.js) are missing on the website — upload the whole web folder again.</div>'; return; }
      if (sales) { R.table = null; return K.renderSales(K.$('#rout'), K.$('#rf').value, K.$('#rt').value); }
      const key = K.$('#rf').value + '|' + K.$('#rt').value;
      if (R.loaded === key) return draw();
      K.$('#rout').innerHTML = '<div class="muted">Loading…</div>';
      const f = new Date(K.$('#rf').value + 'T00:00:00'), t = new Date(K.$('#rt').value + 'T00:00:00'); t.setDate(t.getDate() + 1);
      try { R.rows = await api.reportRows(f.toISOString(), t.toISOString()); R.loaded = key; draw(); }
      catch (err) { K.$('#rout').innerHTML = `<div class="banner">${esc(err.message)}</div>`; }
    }

    const avgW = (pairs) => { let u = 0, s = 0; pairs.forEach(([v, w]) => { if (v != null && w) { s += v * w; u += w; } }); return u ? s / u : null; };
    const secs = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 1000 : null);
    const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

    function draw() {
      const sf = K.$('#rs').value, of = K.$('#ro').value, iq = K.$('#ri').value.trim().toLowerCase();
      let rows = R.rows.filter((r) => r.order_status !== 'cancelled');
      if (of) rows = rows.filter((r) => (of === 'online') === !!r.is_online);
      if (iq) rows = rows.filter((r) => r.item_name.toLowerCase().includes(iq));
      const stRows = sf ? rows.filter((r) => r.station_id === sf) : rows;
      // orders
      const om = new Map();
      rows.forEach((r) => {
        if (!om.has(r.order_id)) om.set(r.order_id, { ...r, items: [], units: 0 });
        const o = om.get(r.order_id); o.items.push(r); o.units += r.qty;
      });
      const orders = [...om.values()].filter((o) => !sf || o.items.some((i) => i.station_id === sf));
      const clean = orders.filter((o) => !o.order_forced && !o.items.some((i) => i.forced_units));
      const lateMin = +K.setting('timer_late_minutes', 10);
      const out = K.$('#rout');
      let table;

      if (R.tab === 'summary') {
        const kp = [
          ['Orders', orders.length], ['Items (units)', stRows.reduce((a, r) => a + r.qty, 0)],
          ['Online orders', `${orders.filter((o) => o.is_online).length} (${orders.length ? Math.round(orders.filter((o) => o.is_online).length / orders.length * 100) : 0}%)`],
          ['Avg time to all made', K.dur(mean(clean.map((o) => secs(o.received_at, o.order_prepared_at))))],
          ['Avg time to ready (window done)', K.dur(mean(clean.map((o) => secs(o.received_at, o.order_ready_at))))],
          ['Avg wait for collection', K.dur(mean(clean.map((o) => secs(o.order_ready_at, o.order_completed_at))))],
          ['Avg total (order → collected)', K.dur(mean(clean.map((o) => secs(o.received_at, o.order_completed_at))))],
          [`Late orders (ready > ${lateMin} min)`, clean.filter((o) => secs(o.received_at, o.order_ready_at) > lateMin * 60).length],
          ['Take away / Dine-in units', `${stRows.filter((r) => r.pack === 'BOX').reduce((a, r) => a + r.qty, 0)} / ${stRows.filter((r) => r.pack !== 'BOX').reduce((a, r) => a + r.qty, 0)}`],
          ['Forced / closed orders', orders.length - clean.length],
        ];
        out.innerHTML = `<div class="kpis">${kp.map(([l, v]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`;
        R.table = { head: ['Metric', 'Value'], rows: kp }; return;
      }
      if (R.tab === 'station') {
        const g = new Map();
        stRows.forEach((r) => {
          const k = r.no_prep ? '__noprep' : r.station_id || '__none';
          if (!g.has(k)) g.set(k, { name: r.no_prep ? 'No prep (straight to window)' : r.station_name || 'Not assigned', units: 0, lines: 0, orders: new Set(), prep: [], win: [], forced: 0 });
          const x = g.get(k); x.units += r.prep_units || 0; x.lines++; x.orders.add(r.order_id);
          x.prep.push([r.avg_prep_sec, r.prep_units - (r.forced_units || 0)]); x.win.push([r.avg_window_sec, r.window_units]); x.forced += r.forced_units || 0;
        });
        const win = { units: stRows.reduce((a, r) => a + (r.window_units || 0), 0), avg: avgW(stRows.map((r) => [r.avg_window_sec, r.window_units])) };
        const list = [...g.values()].sort((a, b) => b.units - a.units);
        const max = Math.max(1, ...list.map((x) => x.units));
        table = { head: ['Station', 'Units prepared', 'Order lines', 'Orders', 'Avg order → bumped', 'Forced units'],
          rows: [...list.map((x) => [x.name, x.units, x.lines, x.orders.size, K.dur(avgW(x.prep)), x.forced]), ['Order handling window', win.units, '', '', K.dur(win.avg), '']] };
        out.innerHTML = tableHtml(table, (r, i) => i < list.length ? `<div class="bar" style="width:${Math.round(list[i].units / max * 120)}px"></div>` : '');
        R.table = table; return;
      }
      if (R.tab === 'item') {
        const g = new Map();
        stRows.forEach((r) => {
          const k = r.item_name + '|' + (r.variation_name || '');
          if (!g.has(k)) g.set(k, { name: r.item_name + (r.variation_name ? ' · ' + r.variation_name : ''), station: r.no_prep ? 'No prep' : r.station_name || '—', units: 0, orders: new Set(), prep: [], win: [], box: 0 });
          const x = g.get(k); x.units += r.qty; x.orders.add(r.order_id); x.prep.push([r.avg_prep_sec, (r.prep_units || 0) - (r.forced_units || 0)]); x.win.push([r.avg_window_sec, r.window_units]); if (r.pack === 'BOX') x.box += r.qty;
        });
        table = { head: ['Item', 'Station', 'Units', 'Orders', 'Avg order → made', 'Avg order → finished', 'Take away %'],
          rows: [...g.values()].sort((a, b) => b.units - a.units).map((x) => [x.name, x.station, x.units, x.orders.size, K.dur(avgW(x.prep)), K.dur(avgW(x.win)), Math.round(x.box / x.units * 100) + '%']) };
        out.innerHTML = tableHtml(table); R.table = table; return;
      }
      if (R.tab === 'order') {
        table = { head: ['Order', 'Time', 'Type', 'Items', 'Units', 'To all made', 'Window', 'To ready', 'Wait to collect', 'Total', 'Status'],
          rows: orders.sort((a, b) => new Date(b.received_at) - new Date(a.received_at)).map((o) => [
            o.order_no, new Date(o.received_at).toLocaleString([], { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }), o.is_online ? 'Online' : 'Walk-in',
            o.items.map((i) => `${i.qty}× ${i.item_name}`).join(', '), o.units,
            K.dur(secs(o.received_at, o.order_prepared_at)), K.dur(secs(o.order_prepared_at, o.order_ready_at)), K.dur(secs(o.received_at, o.order_ready_at)),
            K.dur(secs(o.order_ready_at, o.order_completed_at)), K.dur(secs(o.received_at, o.order_completed_at)),
            (o.order_forced || o.items.some((i) => i.forced_units) ? 'forced · ' : '') + o.order_status]) };
        out.innerHTML = tableHtml(table); R.table = table; return;
      }
      if (R.tab === 'hour') {
        const g = Array.from({ length: 24 }, (_, h) => ({ h, orders: 0, units: 0, ready: [] }));
        orders.forEach((o) => { const x = g[new Date(o.received_at).getHours()]; x.orders++; x.units += o.units; if (!o.order_forced) x.ready.push(secs(o.received_at, o.order_ready_at)); });
        const used = g.filter((x) => x.orders); const max = Math.max(1, ...used.map((x) => x.orders));
        table = { head: ['Hour', 'Orders', 'Units', 'Avg to ready'],
          rows: used.map((x) => [`${String(x.h).padStart(2, '0')}:00`, x.orders, x.units, K.dur(mean(x.ready))]) };
        const wdt = Math.max(320, Math.floor(out.clientWidth / (out.clientWidth > 1100 ? 2 : 1)) - 40);
        const lbl = used.map((x) => `${x.h % 12 || 12}${x.h < 12 ? 'am' : 'pm'}`);
        out.innerHTML = `<div class="vz-grid2" style="margin-top:0">
          ${K.chart.bars({ title: 'Orders by hour', sub: 'kitchen load', width: wdt, height: 220, labels: lbl, fmt: (v) => v + ' orders', axisFmt: (v) => String(Math.round(v)), series: [{ name: 'Orders', color: '--s1', values: used.map((x) => x.orders) }] })}
          ${K.chart.line({ title: 'Average minutes to ready, by hour', sub: `late = over ${lateMin} min`, width: wdt, height: 220, labels: lbl, fmt: (v) => v.toFixed(1) + ' min', axisFmt: (v) => Math.round(v) + 'm', series: [{ name: 'Minutes to ready', color: '--s1', main: true, values: used.map((x) => { const m = mean(x.ready); return m == null ? null : m / 60; }) }] })}
        </div>` + tableHtml(table, (r, i) => `<div class="bar" style="width:${Math.round(used[i].orders / max * 160)}px"></div>`);
        R.table = table;
      }
    }
    function tableHtml(t, extra) {
      const num = (v) => typeof v === 'number' || /^\d+(\.\d+)?%?$|^\d+m|^—$|^\d+h/.test(String(v));
      return `<div class="tablewrap"><table class="t"><thead><tr>${t.head.map((h, i) => `<th class="${i && num(t.rows[0]?.[i]) ? 'n' : ''}">${esc(h)}</th>`).join('')}${extra ? '<th></th>' : ''}</tr></thead>
        <tbody>${t.rows.map((r, ri) => `<tr>${r.map((v, i) => `<td class="${i && num(v) ? 'n' : ''}">${esc(v)}</td>`).join('')}${extra ? `<td>${extra(r, ri)}</td>` : ''}</tr>`).join('') || `<tr><td colspan="${t.head.length}" class="muted">No data for this period</td></tr>`}</tbody></table></div>`;
    }
    run();
  };
  K.routes.reports.static = true;
  K.routes.reports.noLive = true;     // reports only change when you press Run
})();
