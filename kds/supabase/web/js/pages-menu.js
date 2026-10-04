/* Menu & TV screens (replaces the local Menu Manager): availability, NEW / Jain / wait / add-on,
 * board category, presets, board header, screen notices, photos & videos for the slideshow. */
(function () {
  const K = window.KDS, st = K.state, api = K.api, esc = K.esc;
  const app = () => document.getElementById('app');
  const WAITS = [0, 10, 15, 20, 30, 45, 60];
  const NOTICES = {
    break: { title: "We're on a short break", message: 'Back shortly.\nThank you for your patience.', hours: false },
    aarti: { title: 'Aarti Ritual in progress', message: 'The counter is closed during the Aarti ritual.\nWe will reopen shortly.', hours: false },
    closed: { title: "We're closed for the day", message: 'Thank you for visiting.\nWe look forward to seeing you again soon.', hours: true },
  };
  const money = (c) => (c == null ? '' : '$' + (c / 100).toFixed(2));
  const catName = (id) => st.cfg.categories.find((c) => c.square_id === id)?.name;
  const boardCat = (r) => r.board_category || r.category_name || 'UNCATEGORISED';
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mediaFor = (name) => (st.cfg.media || []).find((m) => m.kind === 'item' && normName(m.item_name) === normName(name));
  const reloadCfg = async () => { await K.loadConfig(); };
  // Menu control + TV screens only list items with a café stock count of 0 or more in Square
  // (the items managed on the menu). Before 006 is run there is no stock column, so show everything.
  const onMenu = (c) => !c.is_deleted && (!('stock_qty' in c) || (c.stock_qty != null && Number(c.stock_qty) >= 0));
  const menuItems = () => st.cfg.catalog.filter(onMenu);
  let autoWaits = {};

  K.routes.menu = function (r) {
    K.applyTheme(K.prefs('menu', { theme: 'warm' }));      // same look as the old Menu Manager by default
    const tab = r.q.get('tab') || 'items';
    const tabs = [['items', 'Items & availability'], ['screens', 'TV screens, notices & presets'], ['media', 'Photos & videos']];
    app().innerHTML = `<div class="topbar"><a class="iconbtn" href="#/">←</a><div class="title">Shayona Cafe · Menu control</div><span class="grow"></span>
      <a class="iconbtn" href="menu-board.html" target="_blank" rel="noopener">TV menu ↗</a><a class="iconbtn" href="menu-slideshow.html" target="_blank" rel="noopener">Slideshow ↗</a>
      ${K.themeBtn('menu', ['warm', 'dark'])}<span class="conn ${st.connected ? '' : 'off'}"></span><span class="clock"></span></div>
      <div class="page"><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="mtab"></div></div>
      ${api.mode === 'demo' ? '<div class="demo-flag">DEMO</div>' : ''}`;
    K.$('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/menu?tab=' + b.dataset.tab; };
    ({ items: tabItems, screens: tabScreens, media: tabMedia })[tab]();
  };
  K.routes.menu.onData = () => {};

  // ================================================================== items
  function tabItems() {
    const box = K.$('#mtab');
    box.innerHTML = `
      <div class="row" style="flex-wrap:wrap">
        <input id="mq" placeholder="Search items…" class="grow" style="min-width:200px">
        <select id="mf"><option value="">All items</option><option value="on">Available</option><option value="off">Sold out</option>
          <option value="new">NEW</option><option value="wait">With wait time</option><option value="nophoto">Available, no photo</option></select>
        <button class="btn" id="msync">↻ Refresh from Square</button>
      </div>
      <p class="muted" style="font-size:.86em;margin:8px 0 0">Switch = available / sold out in Square (POS &amp; online), the kitchen screens and the TV menu.
      <b>J</b> = Jain mark · <b>NEW</b> badge · <b>⏱</b> tap to cycle peak wait (10–60 min) · <b>＋</b> add-on line under the item on the board.
      Wait times also fill in automatically from the kitchen when items are taking long (faint ⏱).</p>
      <div id="mlist"></div>`;
    api.liveWaits().then((w) => { autoWaits = w || {}; draw(); });
    const draw = () => {
      const q = K.$('#mq').value.trim().toLowerCase(), f = K.$('#mf').value;
      let rows = menuItems();
      if (q) rows = rows.filter((c) => c.item_name.toLowerCase().includes(q));
      if (f === 'on') rows = rows.filter((c) => c.available);
      if (f === 'off') rows = rows.filter((c) => !c.available);
      if (f === 'new') rows = rows.filter((c) => c.is_new);
      if (f === 'wait') rows = rows.filter((c) => c.wait_min || autoWaits[c.variation_id]);
      if (f === 'nophoto') rows = rows.filter((c) => c.available && !mediaFor(c.item_name));
      const groups = {};
      rows.forEach((c) => (groups[boardCat(c)] = groups[boardCat(c)] || []).push(c));
      K.$('#mlist').innerHTML = Object.keys(groups).sort().map((g) => {
        const list = groups[g].sort((a, b) => a.item_name.localeCompare(b.item_name));
        const on = list.filter((c) => c.available).length;
        return `<h2 class="row" style="justify-content:space-between;flex-wrap:wrap"><span>${esc(g)} <span class="muted" style="font-size:.8em;font-weight:600">${on}/${list.length} available</span></span>
          <span class="row"><button class="btn sm" data-bulk="1" data-cat="${esc(g)}">All on</button><button class="btn sm" data-bulk="0" data-cat="${esc(g)}">All off</button></span></h2>
          <div class="mm-list">${list.map(rowHtml).join('')}</div>`;
      }).join('') || '<div class="empty">No items match</div>';
    };
    function rowHtml(c) {
      const opts = [...new Set([c.category_name, ...(c.category_ids || []).map(catName)].filter(Boolean))];
      const aw = autoWaits[c.variation_id];
      const photo = mediaFor(c.item_name);
      return `<div class="mm-row ${c.available ? '' : 'off'}" data-v="${esc(c.variation_id)}">
        <button class="switch ${c.available ? 'on' : ''}" data-act="avail" aria-label="Available"></button>
        <div class="mm-name"><b>${esc(c.item_name)}</b>${c.variation_name ? ` <span class="muted">· ${esc(c.variation_name)}</span>` : ''}
          <span class="muted">${money(c.price_cents)}</span>
          ${c.online_visible === false ? '<span class="pill badge-walkin">In-store only</span>' : ''}
          ${c.addon ? `<div class="mm-addon">${esc(c.addon)}</div>` : ''}</div>
        <div class="mm-tools">
          <button class="tbtn ${c.jain ? 'on jain' : ''}" data-act="jain" title="Jain mark on the board">J</button>
          <button class="tbtn ${c.is_new ? 'on new' : ''}" data-act="new" title="NEW badge">NEW</button>
          <button class="tbtn ${c.wait_min ? 'on wait' : aw ? 'auto' : ''}" data-act="wait" title="Peak wait time — tap to cycle">⏱ ${c.wait_min ? c.wait_min + 'm' : aw ? aw + 'm' : ''}</button>
          <button class="tbtn ${c.addon ? 'on' : ''}" data-act="addon" title="Add-on line under the item">＋</button>
          ${opts.length > 1 ? `<select data-act="cat" title="Show under this category on the board">${opts.map((o) => `<option ${o === boardCat(c) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : ''}
          <span class="tbtn ${photo ? 'on' : 'ghostbtn'}" title="${photo ? 'Has a photo/video' : 'No photo yet'}">${photo ? (photo.is_video ? '🎬' : '📷') : '—'}</span>
        </div></div>`;
    }
    const patchLocal = (ids, patch) => st.cfg.catalog.filter((c) => ids.includes(c.variation_id)).forEach((c) => Object.assign(c, patch));
    K.$('#mq').oninput = draw; K.$('#mf').onchange = draw;
    K.pageRefresh = draw;                          // live: redraw when anything changes on another screen or in Square
    K.$('#msync').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api.syncCatalog(); await reloadCfg(); K.toast(`Menu refreshed from Square — ${r.variations} items` + (r.available != null ? `, ${r.available} available, ${r.sold_out} sold out` : '')); draw(); }
      catch (err) { K.toast(err.message, { error: true }); } finally { e.target.disabled = false; }
    };
    K.$('#mlist').onclick = async (e) => {
      const bulk = e.target.closest('[data-bulk]');
      if (bulk) {
        const on = bulk.dataset.bulk === '1';
        const ids = menuItems().filter((c) => boardCat(c) === bulk.dataset.cat && c.available !== on).map((c) => c.variation_id);
        if (!ids.length) return K.toast('Nothing to change');
        if (!(await K.confirm(`Turn ${on ? 'ON' : 'OFF'} ${ids.length} item(s) in ${esc(bulk.dataset.cat)}?`, 'This updates Square, the kitchen screens and the TV menu.', on ? 'Turn on' : 'Turn off'))) return;
        await runAvailability(ids.map((id) => ({ variation_id: id, available: on })));
        draw(); return;
      }
      const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
      const row = b.closest('[data-v]'); const id = row.dataset.v; const c = st.cfg.catalog.find((x) => x.variation_id === id);
      const act = b.dataset.act;
      try {
        if (act === 'avail') {
          if (b.classList.contains('busy')) return; b.classList.add('busy');
          await runAvailability([{ variation_id: id, available: !c.available }]);
        } else if (act === 'jain') { await api.setMenuFlags([id], { jain: !c.jain }); patchLocal([id], { jain: !c.jain }); }
        else if (act === 'new') { await api.setMenuFlags([id], { is_new: !c.is_new }); patchLocal([id], { is_new: !c.is_new }); }
        else if (act === 'wait') {
          const next = WAITS[(WAITS.indexOf(c.wait_min || 0) + 1) % WAITS.length];
          await api.setMenuFlags([id], { wait_min: next }); patchLocal([id], { wait_min: next || null });
        } else if (act === 'addon') {
          K.modal('Add-on line', `<p class="muted" style="margin-top:0">Shows in orange under <b>${esc(c.item_name)}</b> on the TV menu, e.g. "+ Add Cheese $1 · Mumbai style".</p>
            <div class="field"><input id="adt" maxlength="120" value="${esc(c.addon || '')}" placeholder="+ Add Cheese $1"></div>
            <div class="actions"><button class="btn" id="adc">Remove</button><span class="grow"></span><button class="btn" id="adx">Cancel</button><button class="btn primary" id="ads">Save</button></div>`, (w, close) => {
            const save = async (t) => { try { await api.setMenuFlags([id], { addon: t }); patchLocal([id], { addon: t.trim() || null }); close(); draw(); } catch (err) { K.toast(err.message, { error: true }); } };
            K.$('#ads', w).onclick = () => save(K.$('#adt', w).value); K.$('#adc', w).onclick = () => save(''); K.$('#adx', w).onclick = close;
            K.$('#adt', w).focus();
          });
          return;
        }
        draw();
      } catch (err) { K.toast(err.message, { error: true }); draw(); }
    };
    K.$('#mlist').onchange = async (e) => {
      const sel = e.target.closest('select[data-act="cat"]'); if (!sel) return;
      const id = sel.closest('[data-v]').dataset.v; const c = st.cfg.catalog.find((x) => x.variation_id === id);
      const ids = st.cfg.catalog.filter((x) => x.item_id === c.item_id).map((x) => x.variation_id);
      const val = sel.value === c.category_name ? '' : sel.value;
      try { await api.setMenuFlags(ids, { board_category: val }); patchLocal(ids, { board_category: val || null }); K.toast('Category saved'); draw(); }
      catch (err) { K.toast(err.message, { error: true }); }
    };
    draw();
  }

  async function runAvailability(changes) {
    const res = await api.setAvailabilityMany(changes);
    const failedIds = new Set((res.failed || []).map((f) => f.variation_id));
    changes.forEach((c) => { if (!failedIds.has(c.variation_id)) st.cfg.catalog.filter((x) => x.variation_id === c.variation_id).forEach((x) => { x.available = c.available; if ('stock_qty' in x) x.stock_qty = c.available ? Math.max(1, Number(x.stock_qty) || 1000) : 0; }); });
    if (res.failed?.length) {
      K.modal(`${res.failed.length} item(s) couldn't be changed`, `<ul style="padding-left:18px;margin:0">${res.failed.slice(0, 20).map((f) => `<li><b>${esc(f.name)}</b> — ${esc(f.reason)}</li>`).join('')}</ul>
        <div class="actions"><button class="btn primary" data-x>OK</button></div>`, (w, close) => { K.$('[data-x]', w).onclick = close; });
    } else if (changes.length > 1) K.toast(`${res.applied ?? changes.length} item(s) updated${api.mode === 'demo' ? ' (demo — Square not changed)' : ' in Square'}`);
    else K.toast(`${changes[0].available ? 'Available' : 'Sold out'}${api.mode === 'demo' ? ' (demo)' : ' — Square updated'}`);
    return res;
  }

  // ================================================================== screens, notices, presets
  function tabScreens() {
    const s = st.cfg.settings, n = s.menu_notice || {}, aw = s.auto_wait || { enabled: true, min_minutes: 10, lookback_minutes: 30 };
    const base = location.href.split('#')[0].replace(/index\.html$/, '').replace(/[^/]*$/, '');
    const presets = st.cfg.presets || [];
    K.$('#mtab').innerHTML = `<div class="mm-grid">
      <div class="card"><h2 style="margin-top:0">TV screen links</h2>
        <p class="muted" style="font-size:.88em">Open on the TV's browser and go full screen. They update by themselves and don't need a login or a computer running in the café.</p>
        ${[['TV menu board', base + 'menu-board.html'], ['Photo / video slideshow', base + 'menu-slideshow.html'], ['Order pickup board', base + '#/board']].map(([l, u]) =>
          `<div class="row" style="margin-bottom:8px;flex-wrap:wrap"><b style="min-width:180px">${l}</b><code style="font-size:.8em;word-break:break-all" class="grow">${esc(u)}</code>
          <button class="btn sm" data-copy="${esc(u)}">Copy</button><a class="btn sm" href="${esc(u)}" target="_blank" rel="noopener">Open</a></div>`).join('')}
      </div>
      <div class="card"><h2 style="margin-top:0">Board header</h2>
        <p class="muted" style="font-size:.88em">A banner across the top of the TV menu, e.g. "Farali Special" or "Long Weekend Special".</p>
        <div class="row"><input id="bn" class="grow" maxlength="80" value="${esc(s.menu_banner || '')}" placeholder="Farali Special"><button class="btn primary" id="bnset">Show on board</button><button class="btn" id="bnclr">Clear</button></div>
      </div>
      <div class="card"><h2 style="margin-top:0">Screen notice</h2>
        <p class="muted" style="font-size:.88em">Full-screen message on the TV menu and slideshow.
        ${n.active ? `<br><b style="color:var(--warn)">Showing now: ${esc(n.title)}</b>` : '<br>No notice showing.'}</p>
        <div class="row" style="flex-wrap:wrap"><button class="btn" data-notice="break">On a Break</button><button class="btn" data-notice="aarti">Aarti</button>
          <button class="btn" data-notice="closed">Closed for the day</button><button class="btn" data-notice="custom">Custom…</button>
          <button class="btn ok" data-notice="clear">Clear (reopen)</button></div>
      </div>
      <div class="card"><h2 style="margin-top:0">Wait times</h2>
        <label class="row" style="margin-bottom:8px"><input type="checkbox" id="awon" ${aw.enabled !== false ? 'checked' : ''}> Show wait times automatically from the kitchen</label>
        <div class="row" style="flex-wrap:wrap"><span class="muted">Show when an item is taking</span><select id="awmin">${[5, 10, 15, 20].map((m) => `<option ${+aw.min_minutes === m ? 'selected' : ''} value="${m}">${m}+ min</option>`).join('')}</select>
          <span class="muted">(based on the last ${aw.lookback_minutes || 30} minutes)</span></div>
        <p class="muted" style="font-size:.86em">A wait time you set by hand on an item always wins over the automatic one.</p>
        <button class="btn" id="wclr">Clear all manual wait times</button>
      </div>
      <div class="card"><h2 style="margin-top:0">Presets</h2>
        <p class="muted" style="font-size:.88em">Applying a preset turns its items ON and every other item OFF — in Square, the kitchen screens and the TV menu.</p>
        <div class="tablewrap" style="max-height:none"><table class="t"><tbody>${presets.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${p.variation_ids.length} items</td>
          <td style="text-align:right"><button class="btn sm primary" data-preset="apply" data-name="${esc(p.name)}">Apply</button> <button class="btn sm" data-preset="del" data-name="${esc(p.name)}">Delete</button></td></tr>`).join('') || '<tr><td class="muted">No presets yet</td></tr>'}</tbody></table></div>
        <div class="row" style="margin-top:10px"><input id="pn" class="grow" placeholder="Preset name, e.g. Weekday Lunch"><button class="btn" id="psave">Save current menu as preset</button></div>
      </div></div>`;

    const box = K.$('#mtab');
    const setting = async (k, v, msg) => { try { await api.setMenuSetting(k, v); st.cfg.settings[k] = v; K.toast(msg); tabScreens(); } catch (err) { K.toast(err.message, { error: true }); } };
    K.$('#bnset').onclick = () => setting('menu_banner', K.$('#bn').value.trim(), 'Header showing on the board');
    K.$('#bnclr').onclick = () => setting('menu_banner', '', 'Header cleared');
    K.$('#awon').onchange = () => setting('auto_wait', { ...aw, enabled: K.$('#awon').checked }, 'Saved');
    K.$('#awmin').onchange = () => setting('auto_wait', { ...aw, min_minutes: +K.$('#awmin').value }, 'Saved');
    K.$('#wclr').onclick = async () => { try { await api.clearWaits(); st.cfg.catalog.forEach((c) => (c.wait_min = null)); K.toast('Wait times cleared'); } catch (err) { K.toast(err.message, { error: true }); } };
    K.$('#psave').onclick = async () => {
      const name = K.$('#pn').value.trim(); if (!name) return K.toast('Type a preset name', { error: true });
      const ids = menuItems().filter((c) => c.available).map((c) => c.variation_id);
      try { await api.savePreset(name, ids); await reloadCfg(); K.toast(`Preset "${name}" saved (${ids.length} items)`); tabScreens(); } catch (err) { K.toast(err.message, { error: true }); }
    };
    box.onclick = async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => K.toast('Link copied')).catch(() => {}); return; }
      const nb = e.target.closest('[data-notice]');
      if (nb) {
        const k = nb.dataset.notice;
        if (k === 'clear') return setting('menu_notice', { active: false, title: '', message: '', hours: false }, 'Notice cleared — screens reopened');
        if (k === 'custom') {
          return K.modal('Custom notice', `<div class="field"><label>Title</label><input id="nt" maxlength="120" placeholder="We'll be back at 5pm"></div>
            <div class="field"><label>Message (each line shows on its own line)</label><textarea id="nm" rows="4" maxlength="600"></textarea></div>
            <label class="row"><input type="checkbox" id="nh"> Also show our opening hours</label>
            <div class="actions"><button class="btn" id="nx">Cancel</button><button class="btn primary" id="ns">Show on screens</button></div>`, (w, close) => {
            K.$('#nx', w).onclick = close;
            K.$('#ns', w).onclick = () => { const t = K.$('#nt', w).value.trim(); if (!t) return K.toast('Type a title', { error: true }); close();
              setting('menu_notice', { active: true, title: t, message: K.$('#nm', w).value.replace(/\r/g, '').trim(), hours: K.$('#nh', w).checked }, 'Notice showing'); };
          });
        }
        return setting('menu_notice', { active: true, ...NOTICES[k] }, `"${NOTICES[k].title}" showing on the screens`);
      }
      const pb = e.target.closest('[data-preset]');
      if (pb) {
        const p = presets.find((x) => x.name === pb.dataset.name); if (!p) return;
        if (pb.dataset.preset === 'del') {
          if (!(await K.confirm(`Delete preset "${esc(p.name)}"?`, 'The items themselves are not changed.', 'Delete', true))) return;
          try { await api.deletePreset(p.name); await reloadCfg(); tabScreens(); } catch (err) { K.toast(err.message, { error: true }); }
          return;
        }
        const on = new Set(p.variation_ids);
        const changes = menuItems().map((c) => ({ variation_id: c.variation_id, available: on.has(c.variation_id) }));
        const flips = changes.filter((c) => st.cfg.catalog.find((x) => x.variation_id === c.variation_id).available !== c.available).length;
        if (!(await K.confirm(`Apply "${esc(p.name)}"?`, `${p.variation_ids.length} items on, everything else off. <b>${flips}</b> item(s) will change in Square.`, 'Apply preset'))) return;
        pb.disabled = true; pb.textContent = 'Applying…';
        try { await runAvailability(changes); } catch (err) { K.toast(err.message, { error: true }); }
        tabScreens();
      }
    };
  }

  // ================================================================== photos & videos
  function tabMedia() {
    const media = st.cfg.media || [];
    const items = media.filter((m) => m.kind === 'item').sort((a, b) => a.item_name.localeCompare(b.item_name));
    const promos = media.filter((m) => m.kind === 'promo').sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
    const names = [...new Set(menuItems().map((c) => c.item_name))].sort();
    const missing = [...new Set(menuItems().filter((c) => c.available && !mediaFor(c.item_name)).map((c) => c.item_name))].sort();
    const thumb = (m) => m.is_video ? `<video src="${esc(m.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`;
    K.$('#mtab').innerHTML = `
      <div class="card"><h2 style="margin-top:0">Add a dish photo or video</h2>
        <p class="muted" style="font-size:.88em">Shows on the slideshow with the item's name and price while the item is available. Photos (JPG/PNG/WebP/GIF) or short MP4 clips. A clip wins over a photo. Uploading again replaces the old one.</p>
        <div class="row" style="flex-wrap:wrap"><input id="mi" list="mnames" placeholder="Item name, e.g. Vada Pav" class="grow" style="min-width:220px">
          <datalist id="mnames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
          <input type="file" id="mfile" accept="image/*,video/mp4,video/webm"><button class="btn primary" id="mup">Upload</button></div>
        ${missing.length ? `<p class="muted" style="font-size:.86em;margin-bottom:4px">Available items with no photo (tap to pick):</p><div class="row" style="flex-wrap:wrap;gap:6px">${missing.slice(0, 60).map((n) => `<button class="pill badge-walkin" data-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <h2>Dish photos &amp; videos (${items.length})</h2>
      <div class="media-grid">${items.map((m) => `<div class="media-card">${thumb(m)}<div class="row"><b class="grow">${esc(m.item_name)}</b><button class="btn sm" data-del="${m.id}" data-path="${esc(m.path)}">Delete</button></div></div>`).join('') || '<div class="muted">None yet.</div>'}</div>
      <h2>Promos &amp; announcements (${promos.length})</h2>
      <div class="card"><p class="muted" style="font-size:.88em;margin-top:0">Ads or notices that aren't menu items — they play in the slideshow without a price. They play in name order (name files 1-…, 2-… to set the order).</p>
        <div class="row"><input type="file" id="pfile" accept="image/*,video/mp4,video/webm" multiple><button class="btn primary" id="pup">Upload promos</button></div></div>
      <div class="media-grid">${promos.map((m) => `<div class="media-card">${thumb(m)}<div class="row"><span class="grow muted" style="font-size:.85em;word-break:break-all">${esc(m.sort || m.path)}</span><button class="btn sm" data-del="${m.id}" data-path="${esc(m.path)}">Delete</button></div></div>`).join('') || '<div class="muted">None yet.</div>'}</div>`;

    const big = (f) => f.size > 50 * 1024 * 1024;
    K.$('#mup').onclick = async (e) => {
      const name = K.$('#mi').value.trim(), f = K.$('#mfile').files[0];
      if (!name || !f) return K.toast('Pick an item and a file', { error: true });
      const real = names.find((n) => n.toLowerCase() === name.toLowerCase());
      if (!real && !(await K.confirm('Item not found', `No menu item is called <b>${esc(name)}</b>. The photo only shows if the name matches an item exactly. Upload anyway?`, 'Upload'))) return;
      if (big(f)) return K.toast('That file is over 50 MB — please use a shorter or smaller video', { error: true });
      e.target.disabled = true; e.target.textContent = 'Uploading…';
      try { await api.uploadMedia(f, 'item', real || name); await reloadCfg(); K.toast('Uploaded'); tabMedia(); }
      catch (err) { K.toast(err.message, { error: true }); e.target.disabled = false; e.target.textContent = 'Upload'; }
    };
    K.$('#pup').onclick = async (e) => {
      const files = [...K.$('#pfile').files]; if (!files.length) return K.toast('Choose one or more files', { error: true });
      if (files.some(big)) return K.toast('One of the files is over 50 MB', { error: true });
      e.target.disabled = true; e.target.textContent = 'Uploading…';
      try { for (const f of files) await api.uploadMedia(f, 'promo'); await reloadCfg(); K.toast(`${files.length} promo(s) uploaded`); tabMedia(); }
      catch (err) { K.toast(err.message, { error: true }); e.target.disabled = false; e.target.textContent = 'Upload promos'; }
    };
    K.$('#mtab').onclick = async (e) => {
      const p = e.target.closest('[data-pick]'); if (p) { K.$('#mi').value = p.dataset.pick; K.$('#mfile').click(); return; }
      const d = e.target.closest('[data-del]'); if (!d) return;
      if (!(await K.confirm('Delete this file?', 'It will stop showing on the slideshow.', 'Delete', true))) return;
      try { await api.deleteMedia(d.dataset.del, d.dataset.path); await reloadCfg(); tabMedia(); } catch (err) { K.toast(err.message, { error: true }); }
    };
  }
})();
