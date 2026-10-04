/* Kitchen screens: station (prep), window (expo), front counter, customer board */
(function () {
  const K = window.KDS, st = K.state, api = K.api, esc = K.esc;

  const LAYOUTS = {
    station: [['tickets', 'Tickets'], ['rail', 'Docket rail'], ['list', 'List'], ['summary', 'Item summary']],
    window: [['makeline', 'Make line'], ['tickets', 'Tickets'], ['rail', 'Docket rail'], ['list', 'List']],
    front: [['columns', 'Status columns'], ['tickets', 'Tickets'], ['list', 'List']],
  };
  const DEFAULTS = { layout: null, size: 'm', fs: 1, sort: 'oldest', theme: 'dark', sound: true, sidebar: false, others: true };

  // ------------------------------------------------------------------ dismissed cancelled orders
  const dismissed = () => { try { return new Set(JSON.parse(localStorage.getItem('kds.dismissed') || '[]')); } catch (_) { return new Set(); } };
  const dismiss = (id) => { const s = dismissed(); s.add(id); try { localStorage.setItem('kds.dismissed', JSON.stringify([...s].slice(-300))); } catch (_) {} };
  const showCancelled = (o) => o.status === 'cancelled' && !dismissed().has(o.id) && Date.now() - new Date(o.cancelled_at || o.updated_at) < 30 * 60e3;

  // ------------------------------------------------------------------ hold-until-complete + part pickup
  let catMapFor = null, catMap = new Map();
  function catRow(it) {
    if (catMapFor !== st.cfg) { catMap = new Map(st.cfg.catalog.map((c) => [c.variation_id, c])); catMapFor = st.cfg; }
    return catMap.get(it.variation_id);
  }
  // items marked "hold" are not handed out until everything else in the order is ready
  K.isHeld = function (it) {
    const c = catRow(it);
    if (c && c.hold != null) return !!c.hold;
    const cat = st.cfg.categories.find((k) => (c && k.square_id === c.category_id) || k.name === it.category_name);
    return !!cat?.hold;
  };
  const liveItems = (o) => (st.itemsByOrder.get(o.id) || []).filter((i) => !i.removed);
  const allWindowDone = (o) => liveItems(o).every((i) => i.qty_window >= i.qty);
  K.pickup = function (o) {
    const items = liveItems(o), allReady = items.length > 0 && items.every((i) => i.qty_window >= i.qty);
    let total = 0, readyOrDone = 0, collectable = 0;
    items.forEach((it) => {
      const held = !allReady && K.isHeld(it), waiting = it.qty_window - it.qty_front;
      total += it.qty; collectable += held ? 0 : waiting; readyOrDone += it.qty_front + (held ? 0 : waiting);
    });
    return { allReady, total, readyOrDone, collectable, items };
  };

  // ------------------------------------------------------------------ small renderers
  const ono = (o) => { const n = String(o.order_no ?? o.kds_seq ?? ''); return /^\d+$/.test(n) ? '#' + n : n; };
  const modClass = (m) => /spicy|chilli|hot/i.test(m) ? 'hot' : /jain/i.test(m) ? 'jain' : '';
  const PACK_WORDS = /^(take ?away|takeaway|box|to go|plate|dine in|eat in|for here)$/i;
  function modsHtml(it) {
    const mods = (it.modifiers || []).filter((m) => !PACK_WORDS.test(String(m).trim()));
    return mods.length ? `<div class="mods">${mods.map((m) => `<span class="mod ${modClass(m)}">${esc(m)}</span>`).join('')}</div>` : '';
  }
  // Box/Plate badge — hidden for categories where it doesn't matter (e.g. drinks), unless it's an explicit BOX
  const showPack = (it) => it.pack === 'BOX' || !(K.setting('pack_hidden_categories', []) || []).some((c) => String(c).toLowerCase() === String(it.category_name || '').toLowerCase());
  K.showPack = showPack;
  const dots = (done, total) => total > 1 && total <= 12 ? `<div class="dots">${Array.from({ length: total }, (_, i) => `<span class="dot ${i < done ? 'on' : ''}"></span>`).join('')}</div>` : '';
  const timerHtml = (since, th) => `<span class="timer ${K.ageClass(since, th)}" data-since="${esc(since)}" data-warn="${th.warn}" data-late="${th.late}">${K.mmss(Date.now() - new Date(since))}</span>`;

  function badges(o) {
    const b = [];
    if (o.status === 'cancelled') b.push('<span class="pill badge-cancel">CANCELLED IN SQUARE</span>');
    b.push(o.is_online ? `<span class="pill badge-online">ONLINE${o.source_name && !/^online$/i.test(o.source_name) ? ' · ' + esc(o.source_name) : ''}</span>` : '<span class="pill badge-walkin">Walk-in</span>');
    if (o.pickup_at) b.push(`<span class="pill badge-pickup">Pickup ${K.time(o.pickup_at)}</span>`);
    if (o.table_name) b.push(`<span class="pill badge-pickup">${esc(o.table_name)}</span>`);
    if (o.forced) b.push('<span class="pill badge-forced">Forced</span>');
    return `<div class="t-sub">${b.join('')}</div>`;
  }
  function head(o, th) {
    return `<div class="t-head"><span class="ono">${esc(ono(o))}</span>${o.customer_name ? `<span class="who">${esc(o.customer_name)}</span>` : ''}${timerHtml(o.received_at, th)}</div>`;
  }

  // per-screen item model
  function itemModel(it, kind, held) {
    const st0 = K.stationById(it.station_id);
    const unrouted = !it.station_id && !it.no_prep;
    if (kind === 'station') {
      const rem = it.qty - it.qty_prep;
      return { rem, total: it.qty, doneCount: it.qty_prep, cls: rem <= 0 ? 'done' : 'tap', tap: rem > 0 ? { stage: 'prep' } : null, status: '' };
    }
    if (kind === 'window') {
      const ready = it.qty_prep - it.qty_window, waiting = it.qty - it.qty_prep, rem = it.qty - it.qty_window;
      let cls, status = '', tap = null;
      if (rem <= 0) { cls = 'done'; status = 'Finished'; }
      else if (ready > 0) { cls = 'tap ready'; tap = { stage: 'window' }; status = `${ready} ready to finish${waiting ? ` · ${waiting} still at ${esc(st0?.name || 'station')}` : ''}`; }
      else if (unrouted) { cls = 'tap unrouted'; tap = { stage: 'window', force: true }; status = 'No station set — tap to finish anyway'; }
      else { cls = 'waiting'; status = `Waiting · ${esc(st0?.name || 'kitchen')}${it.qty > 1 ? ` (${it.qty_prep}/${it.qty} made)` : ''}`; }
      return { rem, total: it.qty, doneCount: it.qty_window, cls, tap, status };
    }
    // front
    const col = it.qty_window - it.qty_front, rem = it.qty - it.qty_front;
    let cls, status, tap = null;
    if (rem <= 0) { cls = 'done'; status = 'Collected'; }
    else if (col > 0 && held) { cls = 'waiting'; status = `${col} ready · held until the whole order is ready`; }
    else if (col > 0) { cls = 'tap ready'; tap = { stage: 'front' }; status = `${col} ready to hand over`; }
    else if (it.qty_prep > it.qty_window) { cls = 'waiting'; status = 'At window'; }
    else { cls = 'waiting'; status = unrouted ? 'No station set' : `At ${esc(st0?.name || 'kitchen')} (${it.qty_prep}/${it.qty})`; }
    return { rem, total: it.qty, doneCount: it.qty_front, cls, tap, status };
  }
  function itemRow(o, it, kind, cancelled) {
    const m = itemModel(it, kind, kind === 'front' && K.isHeld(it) && !allWindowDone(o));
    const tap = !cancelled && m.tap;
    const name = `${esc(it.item_name)}${it.variation_name ? ` <span class="ivar">· ${esc(it.variation_name)}</span>` : ''}`;
    return `<li class="item ${tap ? m.cls : m.cls.replace('tap', '')}" ${tap ? `data-act="bump" data-item="${it.id}" data-stage="${m.tap.stage}" data-n="1" ${m.tap.force ? 'data-force="1"' : ''}` : ''}>
      <div class="qty">${m.rem > 0 ? m.rem : '✓'}${m.rem > 0 && m.rem !== m.total ? `<small>/${m.total}</small>` : ''}</div>
      <div><div class="iname">${name}</div>${modsHtml(it)}${it.note ? `<div class="inote">“${esc(it.note)}”</div>` : ''}${m.status ? `<div class="istatus">${m.status}</div>` : ''}</div>
      <div class="iright">${showPack(it) ? `<span class="pack ${it.pack === 'BOX' ? 'BOX' : 'PLATE'}">${it.pack === 'BOX' ? 'BOX' : 'PLATE'}</span>` : ''}${dots(m.doneCount, m.total)}
        ${tap && m.rem > 1 && (kind !== 'window' || it.qty_prep - it.qty_window > 1) && (kind !== 'front' || it.qty_window - it.qty_front > 1) ? `<button class="allbtn" data-act="bump" data-item="${it.id}" data-stage="${m.tap.stage}" data-n="all">ALL</button>` : ''}</div>
    </li>`;
  }

  // ------------------------------------------------------------------ models per screen
  function sortOrders(list, p) {
    const by = (a, b) => new Date(a.o.received_at) - new Date(b.o.received_at);
    list.sort(by);
    if (p.sort === 'newest') list.reverse();
    if (p.sort === 'online') list.sort((a, b) => (b.o.is_online - a.o.is_online) || by(a, b));
    if (p.sort === 'ready') list.sort((a, b) => ((b.o.status === 'at_window') - (a.o.status === 'at_window')) || by(a, b));
    return list;
  }
  function stationModel(stationId, p) {
    const out = [];
    for (const o of st.orders) {
      if (o.status === 'completed') continue;
      const all = (st.itemsByOrder.get(o.id) || []).filter((i) => !i.removed);
      const mine = all.filter((i) => i.station_id === stationId);
      const pending = mine.filter((i) => i.qty_prep < i.qty);
      if (!pending.length) continue;
      if (o.status === 'cancelled' && !showCancelled(o)) continue;
      out.push({ o, items: mine, pending, others: all.filter((i) => i.station_id !== stationId && !i.no_prep).length });
    }
    return sortOrders(out, p);
  }
  function windowModel(p) {
    const out = [];
    for (const o of st.orders) {
      if (o.status === 'completed' || o.status === 'ready') continue;
      if (o.status === 'cancelled' && !showCancelled(o)) continue;
      // items with no station don't go through the window (they're ready at the front counter)
      const items = (st.itemsByOrder.get(o.id) || []).filter((i) => !i.removed && (i.station_id || i.no_prep));
      if (!items.some((i) => i.qty_window < i.qty)) continue;
      out.push({ o, items, pending: items.filter((i) => i.qty_prep > i.qty_window) });
    }
    return sortOrders(out, p);
  }
  function frontModel(p) {
    const out = [];
    for (const o of st.orders) {
      if (o.status === 'completed') continue;
      if (o.status === 'cancelled' && !showCancelled(o)) continue;
      out.push({ o, items: (st.itemsByOrder.get(o.id) || []).filter((i) => !i.removed) });
    }
    return sortOrders(out, p);
  }

  // ------------------------------------------------------------------ ticket card
  function ticket(m, kind, ctx) {
    const { o } = m, th = ctx.th, cancelled = o.status === 'cancelled';
    const ageCls = K.ageClass(o.received_at, th);
    const allReady = kind === 'window' && o.status === 'at_window';
    let foot = '';
    if (cancelled) foot = `<button class="btn" data-act="dismiss" data-order="${o.id}">Dismiss</button>`;
    else if (kind === 'station') {
      const n = m.pending.reduce((a, i) => a + i.qty - i.qty_prep, 0);
      foot = `<button class="btn ok" data-act="order" data-order="${o.id}" data-stage="prep">DONE ✓ ${n > 1 ? `(${n})` : ''}</button>`;
    } else if (kind === 'window') {
      const n = m.pending.reduce((a, i) => a + i.qty_prep - i.qty_window, 0);
      foot = allReady
        ? `<button class="btn ok" data-act="order" data-order="${o.id}" data-stage="window">FINISH ORDER ✓</button>`
        : n ? `<button class="btn" data-act="order" data-order="${o.id}" data-stage="window">Finish ready (${n})</button>`
          : `<button class="btn" disabled>Waiting on kitchen</button>`;
      foot += `<button class="btn menu-btn" data-act="force" data-order="${o.id}" data-stage="window" title="More">⋮</button>`;
    } else {
      const pk = K.pickup(o);
      foot = o.status === 'ready'
        ? `<button class="btn ok" data-act="order" data-order="${o.id}" data-stage="front">COLLECTED ✓</button>`
        : pk.collectable ? `<button class="btn ok" data-act="handover" data-order="${o.id}">Hand over ready (${pk.collectable})</button>`
          : `<button class="btn" disabled>${o.status === 'at_window' ? 'At window' : 'In kitchen'}</button>`;
      foot += `<button class="btn menu-btn" data-act="force" data-order="${o.id}" data-stage="front" title="More">⋮</button>`;
    }
    const items = (kind === 'station' && ctx.p.hideDone ? m.pending : m.items);
    return `<div class="ticket ${o.is_online ? 'online' : ''} ${ageCls ? 'st-' + ageCls : ''} ${allReady ? 'all-ready' : ''} ${cancelled ? 'cancelled' : ''} ${ctx.fresh.has(o.id) ? 'new-flash' : ''}" data-order="${o.id}">
      ${head(o, th)}${badges(o)}${o.note ? `<div class="t-note">${esc(o.note)}</div>` : ''}
      <ul class="t-items">${items.map((it) => itemRow(o, it, kind, cancelled)).join('')}</ul>
      ${kind === 'station' && ctx.p.others && m.others ? `<div class="t-other">+ ${m.others} item(s) at other stations</div>` : ''}
      ${kind === 'front' && !cancelled ? frontExtra(o) : ''}
      <div class="t-foot">${foot}</div></div>`;
  }
  function frontExtra(o) {
    const pk = K.pickup(o);
    if (pk.allReady || !pk.readyOrDone) return '';
    const todo = pk.items.filter((i) => i.qty_window < i.qty).map((i) => `${esc(i.item_name)} ×${i.qty - i.qty_window}`);
    return `<div class="t-other"><b style="color:var(--ok)">${pk.readyOrDone} of ${pk.total} ready/collected</b>${todo.length ? ` · Still to come: ${todo.join(', ')}` : ''}</div>`;
  }
  function listRow(m, kind, ctx) {
    const { o } = m, ageCls = K.ageClass(o.received_at, ctx.th), cancelled = o.status === 'cancelled';
    const t = ticket(m, kind, ctx);
    const foot = t.match(/<div class="t-foot">([\s\S]*)<\/div><\/div>$/)?.[1] || '';
    return `<div class="lrow ${o.is_online ? 'online' : ''} ${ageCls ? 'st-' + ageCls : ''}" data-order="${o.id}">
      <div class="lhead"><span class="ono">${esc(ono(o))}</span>${timerHtml(o.received_at, ctx.th)}${badges(o).replace('t-sub', 'mods')}</div>
      <ul class="t-items litems" style="padding:0">${m.items.map((it) => itemRow(o, it, kind, cancelled)).join('')}</ul>
      <div class="row">${foot}</div></div>`;
  }
  function summaryView(model, ctx) {
    const groups = new Map();
    model.forEach((m) => m.pending.forEach((it) => {
      if (m.o.status === 'cancelled') return;
      const key = it.item_name + '|' + (it.variation_name || '');
      if (!groups.has(key)) groups.set(key, { name: it.item_name, variation: it.variation_name, total: 0, rows: [] });
      const g = groups.get(key); const rem = it.qty - it.qty_prep; g.total += rem; g.rows.push({ o: m.o, it, rem });
    }));
    if (!groups.size) return empty();
    return [...groups.values()].sort((a, b) => b.total - a.total).map((g) => `
      <div class="sgroup"><div class="shead"><span class="n">${g.total}</span><span class="nm">${esc(g.name)}${g.variation ? ` · ${esc(g.variation)}` : ''}</span>
        <button class="btn sm ok" data-act="bump" data-item="${g.rows[0].it.id}" data-stage="prep" data-n="1">Bump oldest</button></div>
        <div class="chips">${g.rows.map((r) => {
          const mods = (r.it.modifiers || []).filter((x) => !PACK_WORDS.test(String(x).trim()));
          return `<button class="chip ${r.o.is_online ? 'online' : ''} ${K.ageClass(r.o.received_at, ctx.th)}" data-act="bump" data-item="${r.it.id}" data-stage="prep" data-n="1">
            <span class="c1">${esc(ono(r.o))} × ${r.rem}</span>
            <span class="c2">${timerHtml(r.o.received_at, ctx.th).replace('class="timer', 'class="')}${showPack(r.it) ? ' · ' + (r.it.pack === 'BOX' ? 'BOX' : 'PLATE') : ''}</span>
            ${mods.length ? `<span class="c2">${esc(mods.join(', '))}</span>` : ''}</button>`;
        }).join('')}</div></div>`).join('');
  }
  // ---- Make line (window): one row per unit ready to dress, grouped by item, oldest order first
  function makeLineView(model, ctx) {
    const groups = new Map(), coming = new Map();
    const remainingOf = (o) => liveItems(o).reduce((a, i) => a + Math.max(0, i.qty - i.qty_window), 0);
    model.forEach((m) => {
      if (m.o.status === 'cancelled') return;
      m.items.forEach((it) => {
        const key = it.item_name + '|' + (it.variation_name || '');
        const unrouted = false;
        const ready = it.qty_prep - it.qty_window;
        const later = it.qty - it.qty_prep;
        if (later > 0) coming.set(key, (coming.get(key) || 0) + later);
        if (ready <= 0) return;
        if (!groups.has(key)) groups.set(key, { name: it.item_name, variation: it.variation_name, rows: [], ready: 0 });
        const g = groups.get(key); g.ready += ready;
        g.rows.push({ o: m.o, it, n: ready, force: unrouted, last: remainingOf(m.o) <= ready });
      });
    });
    if (!groups.size) {
      const nxt = [...coming.entries()].map(([k, n]) => `${esc(k.split('|')[0])} ×${n}`).join(' · ');
      return empty(nxt ? `Nothing to dress yet<br><small class="muted">Coming next: ${nxt}</small>` : 'All caught up');
    }
    const sorted = [...groups.entries()].sort((a, b) => new Date(a[1].rows[0].o.received_at) - new Date(b[1].rows[0].o.received_at));
    const html = sorted.map(([key, g]) => {
      let rows;
      const modsOf = (it) => (it.modifiers || []).filter((x) => !PACK_WORDS.test(String(x).trim()));
      const detail = (it) => {
        const mods = modsOf(it);
        return `${showPack(it) ? `<span class="pack ${it.pack === 'BOX' ? 'BOX' : 'PLATE'}">${it.pack === 'BOX' ? 'BOX' : 'PLATE'}</span>` : ''}
          <span class="mdet">${mods.map((x) => `<span class="mod ${modClass(x)}">${esc(x)}</span>`).join('')}${it.note ? `<span class="inote">“${esc(it.note)}”</span>` : ''}${!mods.length && !it.note ? '<span class="faint">no changes</span>' : ''}</span>`;
      };
      if (ctx.p.batch) {
        const sig = new Map();
        g.rows.forEach((r) => {
          const k = [r.it.pack, ...modsOf(r.it).sort(), r.it.note || ''].join('|');
          if (!sig.has(k)) sig.set(k, { it: r.it, parts: [], n: 0, force: false });
          const x = sig.get(k); x.parts.push(r); x.n += r.n; x.force = x.force || r.force;
        });
        rows = [...sig.values()].map((x) => `<button class="mrow ${x.parts.some((r) => r.o.is_online) ? 'online' : ''}" data-act="batch" data-items="${x.parts.map((r) => r.it.id + ':' + r.n).join('|')}" ${x.force ? 'data-force="1"' : ''}>
            <span class="mqty">${x.n}×</span><span class="mbody">${detail(x.it)}
            <span class="mords">${x.parts.map((r) => `<span class="pill ${r.last ? 'badge-online' : 'badge-walkin'}">${esc(ono(r.o))}${r.n > 1 ? ' ×' + r.n : ''}${r.last ? ' · LAST' : ''}</span>`).join(' ')}</span></span>
            ${timerHtml(x.parts[0].o.received_at, ctx.th)}</button>`).join('');
      } else {
        rows = g.rows.flatMap((r) => Array.from({ length: r.n }, (_, k) => `<button class="mrow ${r.o.is_online ? 'online' : ''}" data-act="bump" data-item="${r.it.id}" data-stage="window" data-n="1" ${r.force ? 'data-force="1"' : ''}>
            <span class="mono">${esc(ono(r.o))}${r.o.customer_name ? `<small>${esc(r.o.customer_name)}</small>` : ''}</span>
            <span class="mbody">${detail(r.it)}${r.last && k === r.n - 1 ? '<span class="pill badge-online lastflag">LAST ITEM · order complete</span>' : ''}${r.force ? '<span class="pill badge-cancel">No station set</span>' : ''}</span>
            ${timerHtml(r.o.received_at, ctx.th)}</button>`)).join('');
      }
      const c = coming.get(key);
      return `<div class="mgroup"><div class="mhead"><span class="n">${g.ready}</span><span class="nm">${esc(g.name)}${g.variation ? ` · ${esc(g.variation)}` : ''}</span>
        ${c ? `<span class="pill badge-walkin">${c} coming</span>` : ''}
        <button class="btn sm ok" data-act="bump" data-item="${g.rows[0].it.id}" data-stage="window" data-n="1" ${g.rows[0].force ? 'data-force="1"' : ''}>Finish oldest</button></div>
        <div class="mrows">${rows}</div></div>`;
    }).join('');
    const nxt = [...coming.entries()].filter(([k]) => !groups.has(k)).map(([k, n]) => `${esc(k.split('|')[0])} ×${n}`);
    return html + (nxt.length ? `<div class="mcoming muted">Coming next: ${nxt.join(' · ')}</div>` : '');
  }
  const empty = (txt = 'All caught up') => `<div class="empty"><div class="big">✓</div>${txt}</div>`;

  function allDay(model, kind) {
    const t = new Map();
    model.forEach((m) => {
      if (m.o.status === 'cancelled') return;
      m.items.forEach((it) => {
        const n = kind === 'station' ? it.qty - it.qty_prep : it.qty - it.qty_window;
        if (n > 0) t.set(it.item_name, (t.get(it.item_name) || 0) + n);
      });
    });
    return `<h4>All-day count</h4>${[...t.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="allday"><span>${esc(k)}</span><b>${v}</b></div>`).join('') || '<div class="muted">Nothing waiting</div>'}`;
  }

  // ------------------------------------------------------------------ screen frame
  function screen(r, kind) {
    const station = kind === 'station' ? K.stationById(r.arg) : null;
    if (kind === 'station' && !station) { location.hash = '#/'; return; }
    const key = kind === 'station' ? 'station:' + station.id : kind;
    const p = K.prefs(key, { ...DEFAULTS, layout: LAYOUTS[kind][0][0] });
    K.applyTheme(p);
    const title = station ? station.name : kind === 'window' ? 'Order handling window' : 'Front counter';
    const colour = station ? station.colour : kind === 'window' ? 'var(--ok)' : 'var(--info)';
    const stageOf = { station: 'prep', window: 'window', front: 'front' }[kind];
    const ctx = { kind, station, key, p, stage: stageOf, seen: null, fresh: new Set() };
    K.screenCtx = ctx;

    document.getElementById('app').innerHTML = `
      <div class="topbar">
        <a class="iconbtn" href="#/" title="Home">←</a>
        <div class="title"><span class="swatch" style="background:${esc(colour)}"></span>${esc(title)}</div>
        <span class="stat" id="stats"></span>
        <span class="grow"></span>
        <span class="conn ${st.connected ? '' : 'off'}" title="Live connection"></span>
        <span class="clock"></span>
        <button class="iconbtn" data-top="recall" title="Recall a bumped item">↺ Recall</button>
        ${kind !== 'front' ? '<button class="iconbtn" data-top="avail" title="Item availability">86</button>' : ''}
        <button class="iconbtn" data-top="settings" title="Layout & display">⚙</button>
        <button class="iconbtn" data-top="fs" title="Full screen">⛶</button>
      </div>
      <div id="banner"></div>
      <div id="wrap"></div>
      ${api.mode === 'demo' ? '<div class="demo-flag">DEMO</div>' : ''}`;

    K.$('.topbar').onclick = (e) => {
      const b = e.target.closest('[data-top]'); if (!b) return;
      const a = b.dataset.top;
      if (a === 'fs') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}); }
      if (a === 'settings') settingsDrawer(ctx);
      if (a === 'recall') recallDrawer(ctx);
      if (a === 'avail') location.hash = `#/availability${station ? '?station=' + station.id : ''}`;
    };
    K.$('#wrap').onclick = (e) => onAction(e, ctx);
    startOverlay(ctx);
    drawBoard(ctx);
  }

  function drawBoard(ctx) {
    const { kind, station, p } = ctx;
    if (!K.$('#wrap')) return;
    ctx.th = K.thresholds(station);
    const model = kind === 'station' ? stationModel(station.id, p) : kind === 'window' ? windowModel(p) : frontModel(p);

    // new-order detection (flash + chime)
    const ids = new Set(model.map((m) => m.o.id));
    ctx.fresh = new Set();
    if (ctx.seen && st.loaded) {
      const fresh = model.filter((m) => !ctx.seen.has(m.o.id) && m.o.status !== 'cancelled');
      fresh.forEach((m) => ctx.fresh.add(m.o.id));
      if (fresh.length && p.sound) K.beep(fresh.some((m) => m.o.is_online) ? 'online' : 'new');
      if (model.some((m) => m.o.status === 'cancelled' && !ctx.seen.has(m.o.id)) && p.sound) K.beep('late');
    }
    if (st.loaded) ctx.seen = ids;

    // stats
    const units = model.reduce((a, m) => a + m.items.reduce((b, it) => b + Math.max(0,
      kind === 'station' ? it.qty - it.qty_prep : kind === 'window' ? it.qty - it.qty_window : it.qty - it.qty_front), 0), 0);
    const late = model.filter((m) => Date.now() - new Date(m.o.received_at) >= ctx.th.late && m.o.status !== 'cancelled').length;
    K.$('#stats').innerHTML = `Orders <b>${model.length}</b> · Items <b>${units}</b>${late ? ` · <span style="color:var(--late)">Late <b style="color:var(--late)">${late}</b></span>` : ''}${kind === 'front' ? ` · Ready <b style="color:var(--ok)">${model.filter((m) => m.o.status === 'ready').length}</b>` : ''}`;

    // banners: unavailable items for this station
    let banner = '';
    if (kind !== 'front') {
      const off = st.cfg.catalog.filter((c) => !c.available && !c.is_deleted && (!station || routeOf(c) === station.id));
      if (off.length) banner = `<div class="banner"><span>86'd (unavailable):</span> ${off.slice(0, 12).map((c) => `<span class="pill badge-cancel">${esc(c.item_name)}</span>`).join(' ')}${off.length > 12 ? ` +${off.length - 12} more` : ''}</div>`;
    }
    if (!st.connected) banner += '<div class="banner">⚠ Connection lost — retrying. New orders may be delayed.</div>';
    K.$('#banner').innerHTML = banner;

    let html;
    if (!st.loaded) html = '<div class="board"><div class="empty"><div class="big">⏳</div>Loading orders…</div></div>';
    else if (kind === 'front' && p.layout === 'columns') {
      const col = (title, cls, rows) => `<div class="col ${cls}"><h3>${title}<span class="pill badge-walkin">${rows.length}</span></h3><div class="stack">${rows.map((m) => ticket(m, kind, ctx)).join('') || '<div class="muted" style="padding:10px">—</div>'}</div></div>`;
      html = `<div class="cols" style="font-size:${p.size === 's' ? '.9em' : p.size === 'l' ? '1.1em' : '1em'}">
        ${col('In kitchen', '', model.filter((m) => m.o.status !== 'ready' && (m.o.status === 'cancelled' || !K.pickup(m.o).collectable)))}
        ${col('Collect now (part ready)', 'ready', model.filter((m) => m.o.status !== 'ready' && m.o.status !== 'cancelled' && K.pickup(m.o).collectable))}
        ${col('All ready', 'ready', model.filter((m) => m.o.status === 'ready'))}</div>`;
    } else if (p.layout === 'makeline' && kind === 'window') {
      html = `<div class="board makeline">${makeLineView(model, ctx)}</div>`;
    } else if (p.layout === 'summary' && kind === 'station') {
      html = `<div class="board tickets size-${p.size === 's' ? 'm' : 'l'}">${summaryView(model, ctx)}</div>`;
    } else if (p.layout === 'list') {
      html = `<div class="board list">${model.map((m) => listRow(m, kind, ctx)).join('') || empty()}</div>`;
    } else {
      html = `<div class="board ${p.layout === 'rail' ? 'rail' : 'tickets'} size-${p.size}">${model.map((m) => ticket(m, kind, ctx)).join('') || empty()}</div>`;
    }
    const side = p.sidebar && kind !== 'front';
    K.$('#wrap').className = side ? 'with-side' : '';
    K.$('#wrap').innerHTML = html + (side ? `<aside class="sidebar">${allDay(model, kind)}</aside>` : '');
  }

  function routeOf(c) {
    if (c.no_prep) return null;
    if (c.station_id) return c.station_id;
    const cat = st.cfg.categories.find((k) => k.square_id === c.category_id);
    return cat && !cat.no_prep ? cat.station_id : null;
  }
  K.routeOf = routeOf;

  // ------------------------------------------------------------------ actions
  const findItem = (id) => st.items.find((i) => i.id === id);
  const findOrder = (id) => st.orders.find((o) => o.id === id);
  const stationFilter = (ctx) => (ctx.kind === 'station' ? ctx.station.id : null);

  async function undoItem(ctx, itemId, stage) {
    const evs = await api.recentEvents(stage, stationFilter(ctx), 15);
    const e = evs.find((x) => x.order_item_id === itemId);
    if (!e) throw new Error('Nothing to undo');
    await api.recall(e.id, ctx.key);
  }
  async function undoOrder(ctx, orderId, stage) {
    const evs = (await api.recentEvents(stage, stationFilter(ctx), 3)).filter((x) => x.order_id === orderId);
    for (const e of evs) await api.recall(e.id, ctx.key);
  }

  async function onAction(e, ctx) {
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    e.stopPropagation();
    const act = el.dataset.act;
    if (el.classList.contains('busy')) return;
    el.classList.add('busy'); setTimeout(() => el.classList.remove('busy'), 800);
    try {
      if (act === 'bump') {
        const it = findItem(el.dataset.item); const o = it && findOrder(it.order_id);
        const force = el.dataset.force === '1';
        const n = await api.bump(el.dataset.item, el.dataset.stage, el.dataset.n === 'all' ? null : +el.dataset.n, ctx.key, force);
        if (n) K.toast(`${n} × ${it?.item_name || 'item'} — ${ono(o || {})}`, { undo: () => undoItem(ctx, el.dataset.item, el.dataset.stage) });
        else K.toast('Nothing left to bump on that item');
      } else if (act === 'batch') {
        const parts = el.dataset.items.split('|').map((x) => x.split(':'));
        let n = 0;
        for (const [id, q] of parts) n += await api.bump(id, 'window', +q, ctx.key, el.dataset.force === '1');
        const it = findItem(parts[0][0]);
        K.toast(`${n} × ${it?.item_name || 'item'} finished`, { undo: async () => { for (const [id] of parts) await undoItem(ctx, id, 'window'); } });
      } else if (act === 'handover') {
        const o = findOrder(el.dataset.order);
        const allReady = allWindowDone(o); let n = 0;
        for (const it of liveItems(o)) {
          const q = it.qty_window - it.qty_front;
          if (q > 0 && (allReady || !K.isHeld(it))) n += await api.bump(it.id, 'front', q, ctx.key, false);
        }
        K.toast(`${ono(o)}: ${n} item${n === 1 ? '' : 's'} handed over`, { undo: () => undoOrder(ctx, o.id, 'front') });
      } else if (act === 'order') {
        const o = findOrder(el.dataset.order);
        const n = await api.bumpOrder(el.dataset.order, el.dataset.stage, stationFilter(ctx), ctx.key, false);
        const verb = { prep: 'done', window: 'finished', front: 'collected' }[el.dataset.stage];
        K.toast(`${ono(o)} ${verb} (${n} item${n === 1 ? '' : 's'})`, { undo: () => undoOrder(ctx, el.dataset.order, el.dataset.stage) });
      } else if (act === 'force') {
        const o = findOrder(el.dataset.order);
        const stage = el.dataset.stage;
        const ok = await K.confirm(stage === 'front' ? `Complete ${ono(o)} now?` : `Finish all of ${ono(o)}?`,
          stage === 'front' ? 'Marks every item as made, finished and collected — use when the customer has taken the order or it was handed over outside the system.'
            : 'Marks every item as made and finished, even if a station hasn\'t bumped it. Shown as "forced" in reports.', 'Yes, complete');
        if (!ok) return;
        await api.bumpOrder(o.id, stage, null, ctx.key, true);
        K.toast(`${ono(o)} ${stage === 'front' ? 'completed' : 'finished'}`, { undo: () => undoOrder(ctx, o.id, stage) });
      } else if (act === 'dismiss') {
        dismiss(el.dataset.order); drawBoard(ctx); return;
      }
      K.reload(0);
    } catch (err) { K.toast(err.message, { error: true }); K.reload(0); }
  }

  // ------------------------------------------------------------------ drawers
  function settingsDrawer(ctx) {
    const p = ctx.p;
    const seg = (name, opts) => `<div class="seg" data-pref="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(p[name]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    K.drawer('Display settings', `
      <div class="field"><label>Layout</label>${seg('layout', LAYOUTS[ctx.kind])}</div>
      <div class="field"><label>Card size</label>${seg('size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']])}</div>
      <div class="field"><label>Text size</label>${seg('fs', [['0.9', 'A−'], ['1', 'A'], ['1.15', 'A+'], ['1.3', 'A++']])}</div>
      <div class="field"><label>Order sorting</label>${seg('sort', [['oldest', 'Oldest first'], ['newest', 'Newest first'], ['online', 'Online first'], ...(ctx.kind === 'window' ? [['ready', 'Ready first']] : [])])}</div>
      <div class="field"><label>Theme</label>${seg('theme', [['dark', 'Dark'], ['light', 'Light']])}</div>
      <div class="field"><label>New-order chime</label>${seg('sound', [['true', 'On'], ['false', 'Off']])}</div>
      ${ctx.kind !== 'front' ? `<div class="field"><label>All-day count sidebar</label>${seg('sidebar', [['true', 'Show'], ['false', 'Hide']])}</div>` : ''}
      ${ctx.kind === 'window' ? `<div class="field"><label>Make line rows</label>${seg('batch', [['false', 'One row per item'], ['true', 'Group identical (same pack + modifiers)']])}</div>` : ''}
      ${ctx.kind === 'station' ? `<div class="field"><label>"Items at other stations" hint</label>${seg('others', [['true', 'Show'], ['false', 'Hide']])}</div>
      <div class="field"><label>Items already bumped</label>${seg('hideDone', [['false', 'Show faded'], ['true', 'Hide']])}</div>` : ''}
      <p class="muted" style="font-size:.85em">Settings are saved on this screen/device only.</p>`, (w) => {
      w.querySelector('.body').onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        const name = b.parentElement.dataset.pref; let v = b.dataset.v;
        if (v === 'true' || v === 'false') v = v === 'true';
        p[name] = v; K.savePrefs(ctx.key, p);
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        K.applyTheme(p); drawBoard(ctx);
      };
    });
  }

  async function recallDrawer(ctx) {
    const d = K.drawer('Recall a bumped item', '<div class="muted">Loading…</div>');
    try {
      const evs = await api.recentEvents(ctx.stage, stationFilter(ctx), 120);
      const body = d.querySelector('.body');
      body.innerHTML = evs.length ? `<p class="muted" style="margin-top:0">Tap Recall to put it back on screen (last 2 hours).</p>` + evs.map((e) => `
        <div class="evt"><div class="grow"><div>${esc(ono({ order_no: e.order_no }))} · ${e.qty} × ${esc(e.item_name || '')}</div>
        <div class="muted" style="font-size:.85em">${K.time(e.at)}${e.forced ? ' · forced' : ''}</div></div>
        <button class="btn sm" data-ev="${e.id}">Recall</button></div>`).join('') : '<div class="empty" style="padding:30px">Nothing bumped recently</div>';
      body.onclick = async (e) => {
        const b = e.target.closest('[data-ev]'); if (!b) return;
        b.disabled = true;
        try { await api.recall(+b.dataset.ev, ctx.key); b.closest('.evt').remove(); K.toast('Recalled — back on screen'); K.reload(0); }
        catch (err) { K.toast(err.message, { error: true }); b.disabled = false; }
      };
    } catch (err) { d.querySelector('.body').textContent = err.message; }
  }

  let started = false;
  function startOverlay(ctx) {
    if (started) return;
    const o = document.createElement('div'); o.className = 'start';
    o.innerHTML = `<h2>${esc(K.$('.topbar .title').textContent)}</h2><div class="muted">Tap to start this screen (turns on the new-order chime and keeps the screen awake)</div>
      <div class="row"><button class="btn primary" data-go="1">▶ Start screen</button><button class="btn" data-go="fs">Start full screen</button></div>`;
    o.onclick = (e) => {
      const g = e.target.closest('[data-go]'); if (!g) return;
      started = true; K.unlockAudio(); K.keepAwake();
      if (g.dataset.go === 'fs') document.documentElement.requestFullscreen?.().catch(() => {});
      o.remove();
    };
    document.body.appendChild(o);
  }

  // ------------------------------------------------------------------ routes
  K.routes.station = (r) => screen(r, 'station');
  K.routes.window = (r) => screen(r, 'window');
  K.routes.front = (r) => screen(r, 'front');
  const onData = () => { if (K.screenCtx && K.$('#wrap')) drawBoard(K.screenCtx); };
  K.routes.station.onData = K.routes.window.onData = K.routes.front.onData = onData;

  // customer-facing pickup board (no buttons)
  K.routes.board = function () {
    K.applyTheme(K.prefs('board', { theme: 'dark' }));
    document.getElementById('app').innerHTML = `<div class="pboard three"><section class="prep"><h2>Preparing</h2><div class="nums" id="pb-prep"></div></section>
      <section class="part"><h2>Collect now</h2><div class="sub">Part of your order is ready</div><div class="nums" id="pb-part"></div></section>
      <section class="ready"><h2>All ready</h2><div class="nums" id="pb-ready"></div></section></div>
      <a href="#/" class="iconbtn" style="position:fixed;left:8px;bottom:8px;opacity:.25">←</a>`;
    K.$('.pboard').onclick = () => { K.unlockAudio(); K.keepAwake(); document.documentElement.requestFullscreen?.().catch(() => {}); };
    K.routes.board.onData();
  };
  let boardSeen = null;
  K.routes.board.onData = function () {
    const prep = K.$('#pb-prep'), ready = K.$('#pb-ready'); if (!prep) return;
    const live = st.orders.filter((o) => ['new', 'preparing', 'at_window', 'ready'].includes(o.status)).sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
    const r = live.filter((o) => o.status === 'ready');
    const pk = new Map(live.map((o) => [o.id, K.pickup(o)]));
    const part = live.filter((o) => o.status !== 'ready' && pk.get(o.id).collectable);
    prep.innerHTML = live.filter((o) => o.status !== 'ready' && !pk.get(o.id).collectable).map((o) => `<div class="num">${esc(String(o.order_no ?? o.kds_seq))}${pk.get(o.id).readyOrDone ? `<small>${pk.get(o.id).readyOrDone} of ${pk.get(o.id).total} collected</small>` : ''}</div>`).join('');
    K.$('#pb-part').innerHTML = part.map((o) => `<div class="num">${esc(String(o.order_no ?? o.kds_seq))}<small>${pk.get(o.id).readyOrDone} of ${pk.get(o.id).total}</small></div>`).join('');
    ready.innerHTML = r.map((o) => `<div class="num ${Date.now() - new Date(o.ready_at) < 60e3 ? 'fresh' : ''}">${esc(String(o.order_no ?? o.kds_seq))}</div>`).join('');
    const ids = new Set([...r, ...part].map((o) => o.id + ':' + pk.get(o.id).readyOrDone));
    if (boardSeen && [...ids].some((id) => !boardSeen.has(id))) K.beep('new');
    boardSeen = ids;
  };
})();
