/* Pages: item availability, admin, reports */
(function () {
  const K = window.KDS, st = K.state, api = K.api, esc = K.esc;
  const app = () => document.getElementById('app');
  const pageTop = (title, back = '#/') => `<div class="topbar"><a class="iconbtn" href="${back}">←</a><div class="title">${esc(title)}</div><span class="grow"></span><span class="conn ${st.connected ? '' : 'off'}"></span><span class="clock"></span></div>`;
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
        <p class="muted" style="font-size:.88em">Switching an item off marks it <b>sold out in Square</b> at Shayona Cafe (POS &amp; online) and shows it as 86'd on the kitchen screens. Switch it back on when it's available again.</p>
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
    K.$('#alist').onclick = async (e) => {
      const b = e.target.closest('.switch'); if (!b || b.classList.contains('busy')) return;
      const turnOn = b.dataset.on !== '1';
      const name = b.closest('.avail').querySelector('.nm').textContent;
      b.classList.add('busy');
      try {
        await api.setAvailability(b.dataset.item, turnOn);
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
    const tabs = [['stations', 'Stations'], ['routing', 'Item routing'], ['settings', 'Settings'], ['square', 'Square & data'], ['links', 'Screen links']];
    app().innerHTML = pageTop('Admin') + `<div class="page"><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tab"></div></div>${demoFlag()}`;
    K.$('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/admin?tab=' + b.dataset.tab; };
    ({ stations: tabStations, routing: tabRouting, settings: tabSettings, square: tabSquare, links: tabLinks })[tab]();
  };
  K.routes.admin.static = true;
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
      "No prep" items skip the stations and go straight to the Window.</p>
      <h2>By category</h2>
      <div class="tablewrap" style="max-height:none"><table class="t"><thead><tr><th>Square category</th><th class="n">Items</th><th>Station</th></tr></thead><tbody>
      ${cats.filter((c) => usedCats.has(c.square_id)).map((c) => `<tr data-cat="${esc(c.square_id)}" ${!c.station_id && !c.no_prep ? 'style="box-shadow:inset 4px 0 0 var(--late)"' : ''}><td><b>${esc(c.name)}</b></td>
        <td class="n">${items.filter((i) => i.category_id === c.square_id).length}</td><td>${stationSelect(c.station_id, c.no_prep, false)}</td></tr>`).join('')}
      </tbody></table></div>
      <h2>Item overrides</h2>
      <div class="row" style="margin-bottom:8px"><input id="iq" placeholder="Search items…" class="grow"><select id="if"><option value="">All items</option><option value="unrouted">Not assigned</option><option value="over">Overridden only</option></select></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Item</th><th>Category</th><th>Goes to</th><th>Override</th></tr></thead><tbody id="ibody"></tbody></table></div>`;
    const drawItems = () => {
      const q = K.$('#iq').value.toLowerCase(), f = K.$('#if').value;
      let rows = [...byItem.values()];
      if (q) rows = rows.filter((c) => c.item_name.toLowerCase().includes(q));
      if (f === 'unrouted') rows = rows.filter((c) => !K.routeOf(c) && !isNoPrep(c));
      if (f === 'over') rows = rows.filter((c) => c.station_id || c.no_prep != null);
      K.$('#ibody').innerHTML = rows.map((c) => {
        const r = K.routeOf(c), np = isNoPrep(c);
        const goes = np ? '<span class="pill badge-walkin">No prep</span>' : r ? `<span class="pill" style="background:${esc(K.stationById(r)?.colour)};color:#fff">${esc(K.stationById(r)?.name)}</span>` : '<span class="pill badge-cancel">Not assigned</span>';
        const val = c.no_prep === true ? '__noprep' : c.station_id || (c.no_prep === false ? '' : '__follow');
        return `<tr data-item="${esc(c.item_id)}"><td><b>${esc(c.item_name)}</b></td><td class="muted">${esc(c.category_name || '')}</td><td>${goes}</td><td>${stationSelect(val, c.no_prep === true, true)}</td></tr>`;
      }).join('');
    };
    function isNoPrep(c) { if (c.no_prep != null) return c.no_prep; const cat = cats.find((k) => k.square_id === c.category_id); return !!cat?.no_prep && !c.station_id; }
    K.$('#iq').oninput = drawItems; K.$('#if').onchange = drawItems;
    K.$('#tab').onchange = async (e) => {
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
      <h2>Box or plate</h2>
      <div class="field"><label>Modifier/note words that mean TAKEAWAY BOX (comma separated)</label><input data-k="takeaway_keywords" data-type="list" value="${list('takeaway_keywords')}"></div>
      <div class="field"><label>Words that mean PLATE / eat in</label><input data-k="plate_keywords" data-type="list" value="${list('plate_keywords')}"></div>
      <div class="row"><div class="field grow"><label>Walk-in item with no modifier</label><select data-k="default_pack" data-type="str"><option ${s.default_pack === 'PLATE' ? 'selected' : ''}>PLATE</option><option ${s.default_pack === 'BOX' ? 'selected' : ''}>BOX</option></select></div>
      <div class="field grow"><label>Online order item with no modifier</label><select data-k="online_pack" data-type="str"><option ${s.online_pack === 'BOX' ? 'selected' : ''}>BOX</option><option ${s.online_pack === 'PLATE' ? 'selected' : ''}>PLATE</option></select></div></div>
      <div class="field"><label>Don't show the PLATE badge for these categories (e.g. drinks) — BOX still shows</label><input data-k="pack_hidden_categories" data-type="list" value="${list('pack_hidden_categories')}"></div>
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
      <button class="btn" data-sq="orders">Pull last 60 min of orders</button></div>
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
        if (a === 'catalog') { res = await api.syncCatalog(); out.textContent = `✓ Synced ${res.variations} items in ${res.categories} categories`; await K.loadConfig(); }
        if (a === 'orders') { res = await api.syncOrders(60); out.textContent = `✓ ${res.ingested} order(s) pulled in`; K.reload(0); }
        if (a === 'close') {
          if (!(await K.confirm('Close all open orders?', 'Everything still on the kitchen, window and front screens will be cleared.', 'Close all', true))) { out.textContent = ''; return; }
          res = await api.closeOpenOrders(0); out.textContent = `✓ Closed ${res} order(s)`; K.reload(0);
        }
      } catch (err) { out.innerHTML = `<span style="color:var(--late)">✕ ${esc(err.message)}</span>`; }
      finally { b.disabled = false; }
    };
  }

  function tabLinks() {
    const base = location.href.split('#')[0];
    const links = [
      ...st.cfg.stations.filter((s) => s.active).map((s) => [s.name + ' station', '#/station/' + s.id]),
      ['Order handling window', '#/window'], ['Front counter', '#/front'], ['Customer pickup board (TV)', '#/board'],
      ['Item availability', '#/availability'], ['Reports', '#/reports'],
    ];
    K.$('#tab').innerHTML = `<p class="muted">Open each link on the tablet/TV for that spot and add it to the home screen (or bookmark it). Each screen remembers its own layout.</p>
      <div class="tablewrap" style="max-height:none"><table class="t"><tbody>${links.map(([n, h]) => `<tr><td><b>${esc(n)}</b></td><td><code style="font-size:.85em;word-break:break-all">${esc(base + h)}</code></td>
      <td><button class="btn sm" data-copy="${esc(base + h)}">Copy</button> <a class="btn sm" href="${h}">Open</a></td></tr>`).join('')}</tbody></table></div>`;
    K.$('#tab').onclick = (e) => { const b = e.target.closest('[data-copy]'); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => K.toast('Link copied')); };
  }

  // ================================================================== reports
  K.routes.reports = function (r) {
    if (api.role !== 'admin') { app().innerHTML = pageTop('Reports') + '<div class="page"><h2>Admins only</h2></div>'; return; }
    K.applyTheme(K.prefs('global', { theme: 'dark' }));
    const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    app().innerHTML = pageTop('Reports') + `<div class="page">
      <div class="row" style="flex-wrap:wrap">
        <div class="seg" id="rng"><button data-r="today" class="on">Today</button><button data-r="yesterday">Yesterday</button><button data-r="7">Last 7 days</button><button data-r="30">Last 30 days</button></div>
        <input type="date" id="rf" value="${ymd(today)}"><span class="muted">to</span><input type="date" id="rt" value="${ymd(today)}">
        <select id="rs"><option value="">All stations</option>${st.cfg.stations.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <select id="ro"><option value="">Walk-in + online</option><option value="online">Online only</option><option value="walkin">Walk-in only</option></select>
        <input id="ri" placeholder="Item contains…" style="width:160px">
        <button class="btn primary" id="rgo">Run report</button>
      </div>
      <div class="tabs" id="rtabs">${[['summary', 'Summary'], ['station', 'By station'], ['item', 'By item'], ['order', 'By order'], ['hour', 'By hour']].map(([k, l], i) => `<button data-t="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}
        <span class="grow"></span><button class="btn sm" id="csv">⬇ Download CSV</button></div>
      <div id="rout"><div class="muted">Loading…</div></div>
      <p class="faint" style="font-size:.82em">Times are measured from when the order reached the kitchen. "Forced" bumps (finished without a station bump, or end-of-day close) are excluded from time averages.</p>
    </div>${demoFlag()}`;
    const R = { rows: [], tab: 'summary', table: null };
    K.$('#rng').onclick = (e) => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      K.$$('#rng button').forEach((x) => x.classList.toggle('on', x === b));
      const t = new Date(), f = new Date();
      if (b.dataset.r === 'yesterday') { f.setDate(f.getDate() - 1); t.setDate(t.getDate() - 1); }
      else if (b.dataset.r !== 'today') f.setDate(f.getDate() - (+b.dataset.r - 1));
      K.$('#rf').value = ymd(f); K.$('#rt').value = ymd(t); run();
    };
    K.$('#rtabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; K.$$('#rtabs [data-t]').forEach((x) => x.classList.toggle('on', x === b)); R.tab = b.dataset.t; draw(); };
    K.$('#rgo').onclick = run;
    ['rs', 'ro'].forEach((id) => (K.$('#' + id).onchange = draw)); K.$('#ri').oninput = draw;
    K.$('#csv').onclick = () => {
      if (!R.table) return;
      const csv = [R.table.head, ...R.table.rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `kds-${R.tab}-${K.$('#rf').value}_${K.$('#rt').value}.csv`; a.click();
    };

    async function run() {
      K.$('#rout').innerHTML = '<div class="muted">Loading…</div>';
      const f = new Date(K.$('#rf').value + 'T00:00:00'), t = new Date(K.$('#rt').value + 'T00:00:00'); t.setDate(t.getDate() + 1);
      try { R.rows = await api.reportRows(f.toISOString(), t.toISOString()); draw(); }
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
          ['Box / Plate units', `${stRows.filter((r) => r.pack === 'BOX').reduce((a, r) => a + r.qty, 0)} / ${stRows.filter((r) => r.pack !== 'BOX').reduce((a, r) => a + r.qty, 0)}`],
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
        table = { head: ['Item', 'Station', 'Units', 'Orders', 'Avg order → made', 'Avg order → finished', 'Box %'],
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
        out.innerHTML = tableHtml(table, (r, i) => `<div class="bar" style="width:${Math.round(used[i].orders / max * 160)}px"></div>`);
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
})();
