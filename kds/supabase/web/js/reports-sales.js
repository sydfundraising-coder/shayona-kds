/* Reports → Sales & trends. Uses sales imported from Square (sales_lines) so it can compare with
 * last week, last year and month-by-month against the previous year — including history from
 * before the KDS was installed. */
(function () {
  const K = window.KDS, api = K.api, esc = K.esc, C = K.chart;

  // ---------------------------------------------------------------- dates (local YYYY-MM-DD)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const D = (s) => new Date(s + 'T12:00:00');
  const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return ymd(d); };
  const addYears = (s, n) => { const d = D(s), m = d.getMonth(); d.setFullYear(d.getFullYear() + n); if (d.getMonth() !== m) d.setDate(0); return ymd(d); };
  const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5) + 1;
  const fmtDay = (s, yr) => D(s).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(yr ? { year: 'numeric' } : {}) });
  const fmtRange = (a, b, yr = true) => a === b ? fmtDay(a, yr) : `${D(a).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${D(b).toLocaleDateString([], { day: 'numeric', month: 'short', ...(yr ? { year: 'numeric' } : {}) })}`;
  const monthName = (m) => new Date(m + '-15T12:00:00').toLocaleDateString([], { month: 'short' });
  const today = () => ymd(new Date());

  // ---------------------------------------------------------------- change helpers
  const pct = (a, b) => (b > 0 ? (a - b) / b * 100 : null);
  const chg = (a, b, opts = {}) => {
    const p = pct(a, b);
    if (p == null) return `<span class="chg flat">${opts.none ?? 'no data'}</span>`;
    const cls = Math.abs(p) < 0.5 ? 'flat' : p > 0 ? 'up' : 'down';
    return `<span class="chg ${cls}">${cls === 'up' ? '▲' : cls === 'down' ? '▼' : '•'} ${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0)}%</span>`;
  };
  const S1 = '--s1', S2 = '--s2', S3 = '--s3';      // this period · last year · last week (fixed per meaning)

  // ---------------------------------------------------------------- import from Square
  async function importRange(from, to, onStep) {
    // month-sized calls; a call that runs out of time returns partial + where it got to
    let a = from;
    while (a <= to) {
      const end = [addDays(ymd(new Date(D(a).getFullYear(), D(a).getMonth() + 1, 0)), 0), to].sort()[0];
      const r = await api.importSales(a, end);
      onStep && onStep(a, end, r);
      a = r && r.partial && r.last_day && r.last_day > a ? r.last_day : addDays(end, 1);
    }
  }
  let lastAutoSync = 0;
  async function autoSync(cov) {
    // bring the last couple of days up to date when the report opens (at most every 5 minutes)
    if (!cov || !cov.last_day || Date.now() - lastAutoSync < 5 * 60e3) return false;
    lastAutoSync = Date.now();
    try { await api.importSales(addDays(cov.last_day > today() ? today() : cov.last_day, -1), today()); return true; } catch (e) { console.warn(e); return false; }
  }

  // ---------------------------------------------------------------- main
  K.renderSales = async function (box, from, to) {
    const asked = [from, to];
    box.innerHTML = '<div class="muted">Loading sales…</div>';
    let cov;
    try { cov = await api.salesCoverage(); }
    catch (e) {
      box.innerHTML = `<div class="banner">Sales reports need the database update <b>011_nightly_close_and_sales.sql</b> — run it in Supabase → SQL Editor. (${esc(e.message)})</div>`;
      return;
    }
    if (!cov || !cov.lines) return importPanel(box, from, to);
    if (await autoSync(cov)) cov = await api.salesCoverage().catch(() => cov);

    // a range that ends today: compare whole days only (today is still trading)
    let note = '';
    if (from < today() && to >= today()) { to = addDays(today(), -1); note = ' Today is left out until the day is finished — pick “Today” to see it so far.'; }
    const N = daysBetween(from, to);
    const wkShift = N <= 7 ? 7 : Math.ceil(N / 7) * 7;
    const P = { from, to };
    const W = { from: addDays(from, -wkShift), to: addDays(to, -wkShift) };
    const Y = { from: addDays(from, -364), to: addDays(to, -364) };          // 52 weeks back = same weekdays
    const wkLabel = N === 1 ? 'Same day last week' : N <= 7 ? 'Same days last week' : `Previous ${N} days`;
    const yrLabel = N === 1 ? 'Same day last year' : 'Same period last year';
    const curLabel = N === 1 ? (to === today() ? 'Today' : fmtDay(to)) : 'This period';
    // month by month: 12 months ending with the selected month (last month up to the selected date)
    const mFrom = ymd(new Date(D(to).getFullYear(), D(to).getMonth() - 11, 1));
    const W8 = { from: addDays(to, -55), to };                               // 8 weeks for busy-times / weekdays
    const W8y = { from: addDays(W8.from, -364), to: addDays(W8.to, -364) };

    let cur, wk, yr, mon, monLy, w8, w8y;
    try {
      [cur, wk, yr, mon, monLy, w8, w8y] = await Promise.all([
        api.salesReport(P.from, P.to), api.salesReport(W.from, W.to), api.salesReport(Y.from, Y.to),
        api.salesMonthly(mFrom, to), api.salesMonthly(addYears(mFrom, -1), addYears(to, -1)),
        api.salesReport(W8.from, W8.to), api.salesReport(W8y.from, W8y.to)]);
    } catch (e) { box.innerHTML = `<div class="banner">${esc(e.message)}</div>`; return; }

    // "today so far": compare only up to the current hour
    const live = to === today();
    const nowH = new Date().getHours();
    const cut = (rep) => {
      if (!live || N !== 1) return rep.totals;
      const hs = (rep.by_hour || []).filter((h) => h.h <= nowH);
      return { orders: hs.reduce((a, h) => a + h.orders, 0), units: hs.reduce((a, h) => a + (h.units || 0), 0), sales: hs.reduce((a, h) => a + h.sales, 0) };
    };
    const Tc = cur.totals, Tw = cut(wk), Ty = cut(yr);
    const aov = (t) => (t.orders ? t.sales / t.orders : 0);
    const share = (rep) => { const on = (rep.by_channel || []).find((c) => c.ch === 'Online'); const all = (rep.by_channel || []).reduce((a, c) => a + c.orders, 0); return all ? (on ? on.orders : 0) / all * 100 : 0; };
    const sinceTxt = live && N === 1 ? ` (to ${nowH % 12 || 12}${nowH < 12 ? 'am' : 'pm'})` : '';

    const noneYet = live && N === 1 && !Tc.orders;
    const kpi = (label, v, a, b, fmt) => noneYet ? `<div class="kpi skpi"><div class="l">${esc(label)}</div><div class="v">${esc(fmt(v))}</div>
      <div class="cmp"><span>last week</span><span>${esc(fmt(a))}</span></div><div class="cmp"><span>last year</span><span>${esc(fmt(b))}</span></div></div>` : `<div class="kpi skpi"><div class="l">${esc(label)}</div><div class="v">${esc(fmt(v))}</div>
      <div class="cmp"><span>vs last week</span>${chg(v, a)}</div><div class="cmp"><span>vs last year</span>${chg(v, b)}</div></div>`;
    const onC = share(cur), onW = share(wk), onY = share(yr);

    box.innerHTML = `
      <div class="covbar"><span>📊 Sales from Square: <b>${esc(fmtDay(cov.first_day, true))}</b> to <b>${esc(fmtDay(cov.last_day, true))}</b>.
        Comparing <b style="color:var(--s1)">${esc(fmtRange(from, to))}</b> with <b style="color:var(--s3)">${esc(fmtRange(W.from, W.to))}</b> (last week)
        and <b style="color:var(--s2)">${esc(fmtRange(Y.from, Y.to))}</b> (last year, same weekdays)${esc(sinceTxt)}.${esc(note)}</span>
        <span class="grow"></span><button class="btn sm" id="sync">↻ Refresh from Square</button><button class="btn sm" id="older">Import older history</button></div>
      <div class="kpis" style="margin-top:10px">
        ${kpi('Net sales', Tc.sales, Tw.sales, Ty.sales, C.money)}
        ${kpi('Orders', Tc.orders, Tw.orders, Ty.orders, C.num)}
        ${kpi('Average order', aov(Tc), aov(Tw), aov(Ty), (v) => '$' + (v / 100).toFixed(2))}
        ${kpi('Items sold', Tc.units, Tw.units, Ty.units, C.num)}
        <div class="kpi skpi"><div class="l">Online orders</div><div class="v">${onC.toFixed(0)}%</div>
          <div class="cmp"><span>last week</span><span>${onW.toFixed(0)}%</span></div><div class="cmp"><span>last year</span><span>${onY.toFixed(0)}%</span></div></div>
      </div>
      <ul class="insights" id="ins"></ul>
      <div class="vz-grid2">
        <div class="vz-card wide" id="c-trend"></div>
        <div class="vz-card wide" id="c-month"></div>
        <div id="c-cat"></div><div id="c-items"></div>
        <div id="c-move"></div><div id="c-wd"></div>
        <div class="vz-card wide" id="c-heat"></div>
      </div>
      <details style="margin-top:12px"><summary class="muted">Show month-by-month table</summary><div id="t-month"></div></details>`;

    const width = (id) => Math.max(320, Math.floor((K.$('#' + id).clientWidth || 760) - 28));
    const replaceCard = (id, html) => { const el = K.$('#' + id); el.outerHTML = html.replace('class="vz-card"', `class="vz-card ${el.classList.contains('wide') ? 'wide' : ''}" id="${id}"`); };

    // 1) trend: hourly for one day, daily (or weekly) for a range
    if (N === 1) {
      const hrs = [...new Set([cur, wk, yr].flatMap((r) => (r.by_hour || []).map((h) => h.h)))].sort((a, b) => a - b);
      const lo = Math.min(...hrs, 8), hi = Math.max(...hrs, 20), H = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      const at = (r, h) => { const x = (r.by_hour || []).find((y) => y.h === h); return x ? x.sales : (live && r === cur && h > nowH ? null : 0); };
      replaceCard('c-trend', C.line({ title: 'Sales by hour', sub: 'Spot the rush and the quiet times', width: width('c-trend'),
        labels: H.map((h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`),
        series: [{ name: curLabel, color: S1, main: true, values: H.map((h) => at(cur, h)) },
          { name: wkLabel, color: S3, values: H.map((h) => at(wk, h)) },
          { name: yrLabel, color: S2, dash: true, values: H.map((h) => at(yr, h)) }] }));
    } else {
      const days = Array.from({ length: N }, (_, i) => addDays(from, i));
      const val = (r, shift) => days.map((d) => { const x = (r.by_day || []).find((y) => y.d === addDays(d, -shift)); return d > today() ? null : x ? x.sales : 0; });
      let labels = days.map((d) => N <= 14 ? fmtDay(d) : D(d).toLocaleDateString([], { day: 'numeric', month: 'short' }));
      let sc = val(cur, 0), sw = val(wk, wkShift), sy = val(yr, 364);
      let sub = 'Each day compared with the same weekday';
      if (N > 62) {   // group into weeks
        const grp = (arr) => { const o = []; for (let i = 0; i < arr.length; i += 7) { const part = arr.slice(i, i + 7).filter((v) => v != null); o.push(part.length ? part.reduce((a, b) => a + b, 0) : null); } return o; };
        labels = days.filter((_, i) => i % 7 === 0).map((d) => 'wk ' + D(d).toLocaleDateString([], { day: 'numeric', month: 'short' }));
        sc = grp(sc); sw = grp(sw); sy = grp(sy); sub = 'Weekly totals';
      }
      replaceCard('c-trend', C.line({ title: N > 62 ? 'Weekly sales' : 'Daily sales', sub, width: width('c-trend'), labels,
        series: [{ name: curLabel, color: S1, main: true, values: sc }, { name: N <= 7 ? 'Last week' : wkLabel, color: S3, values: sw }, { name: 'Last year', color: S2, dash: true, values: sy }] }));
    }

    // 2) month by month vs previous year
    const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(D(mFrom).getFullYear(), D(mFrom).getMonth() + i, 1); return ymd(d).slice(0, 7); });
    const mv = (list, m) => (list.find((x) => x.m === m) || {}).sales;
    const lyKey = (m) => `${+m.slice(0, 4) - 1}${m.slice(4)}`;
    const thisY = months.map((m) => mv(mon, m) ?? null), lastY = months.map((m) => mv(monLy, lyKey(m)) ?? null);
    const partialM = to < ymd(new Date(D(to).getFullYear(), D(to).getMonth() + 1, 0));
    replaceCard('c-month', C.bars({ title: 'Month by month vs last year', width: width('c-month'),
      sub: partialM ? `${monthName(months[11])} is month-to-date (1–${D(to).getDate()} ${monthName(months[11])}), compared with the same dates last year` : 'Full months',
      labels: months.map((m, i) => monthName(m) + (i === 0 || m.endsWith('-01') ? ` ${m.slice(2, 4)}` : '')),
      series: [{ name: 'This year', color: S1, values: thisY }, { name: 'Previous year', color: S2, values: lastY }],
      notes: months.map((m, i) => { const p = pct(thisY[i] || 0, lastY[i] || 0); return p == null || !thisY[i] ? null : { text: `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`, cls: p >= 0.5 ? 'up' : p <= -0.5 ? 'down' : '' }; }) }));
    K.$('#t-month').innerHTML = `<div class="tablewrap"><table class="t"><thead><tr><th>Month</th><th class="n">Sales</th><th class="n">Previous year</th><th class="n">Change</th><th class="n">Orders</th><th class="n">Prev. orders</th><th class="n">Avg order</th></tr></thead><tbody>${months.map((m) => {
      const a = mon.find((x) => x.m === m) || {}, b = monLy.find((x) => x.m === lyKey(m)) || {};
      return `<tr><td>${esc(new Date(m + '-15T12:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' }))}</td><td class="n">${C.money(a.sales)}</td><td class="n">${b.sales ? C.money(b.sales) : '—'}</td><td class="n">${a.sales ? chg(a.sales, b.sales) : ''}</td><td class="n">${C.num(a.orders)}</td><td class="n">${b.orders ? C.num(b.orders) : '—'}</td><td class="n">${a.orders ? '$' + (a.sales / a.orders / 100).toFixed(2) : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`;

    // 3) categories and items vs last year (or last week when there's no last-year data)
    const cmpRep = (yr.totals && yr.totals.orders) ? yr : wk, cmpName = cmpRep === yr ? yrLabel : wkLabel, cmpColor = cmpRep === yr ? S2 : S3;
    const cmpVal = (list, name) => (list.find((x) => x.name === name) || {}).sales || 0;
    const cats = (cur.by_category || []).slice(0, 10);
    replaceCard('c-cat', C.hbars({ title: 'Sales by category', sub: `vs ${cmpName.toLowerCase()}`, series: [{ name: curLabel, color: S1 }, { name: cmpName, color: cmpColor }],
      rows: cats.map((c) => ({ label: c.name, values: [c.sales, cmpVal(cmpRep.by_category || [], c.name)] })),
      change: (r) => chg(r.values[0], r.values[1], { none: 'new' }) }));
    const items = (cur.items || []).slice(0, 12);
    replaceCard('c-items', C.hbars({ title: 'Top 12 items', sub: `by sales · vs ${cmpName.toLowerCase()}`, series: [{ name: curLabel, color: S1 }, { name: cmpName, color: cmpColor }],
      rows: items.map((c) => ({ label: c.name, values: [c.sales, cmpVal(cmpRep.items || [], c.name)] })),
      change: (r) => chg(r.values[0], r.values[1], { none: 'new' }) }));

    // 4) movers: biggest $ gains and drops
    const names = new Set([...(cur.items || []).map((i) => i.name), ...(cmpRep.items || []).map((i) => i.name)]);
    const moves = [...names].map((n) => ({ name: n, a: cmpVal(cur.items || [], n), b: cmpVal(cmpRep.items || [], n) })).map((x) => ({ ...x, d: x.a - x.b }));
    const ups = moves.filter((x) => x.d > 0).sort((p, q) => q.d - p.d).slice(0, 6), downs = moves.filter((x) => x.d < 0).sort((p, q) => p.d - q.d).slice(0, 6);
    const mrow = (x) => `<div class="vz-hrow" data-tip="${esc(`<b>${esc(x.name)}</b><div>${esc(curLabel)}<span>${C.money(x.a)}</span></div><div>${esc(cmpName)}<span>${C.money(x.b)}</span></div>`)}"><div class="vz-hl">${esc(x.name)}</div><div></div><div class="vz-hv"><span class="chg ${x.d > 0 ? 'up' : 'down'}">${x.d > 0 ? '▲ +' : '▼ −'}${C.money(Math.abs(x.d))}</span></div></div>`;
    K.$('#c-move').outerHTML = `<div class="vz-card" id="c-move"><div class="vz-title">Biggest movers<span class="vz-sub">change in sales vs ${esc(cmpName.toLowerCase())}</span></div>
      <div class="vz-sub" style="margin:6px 0 2px">Growing</div><div class="vz-hlist">${ups.map(mrow).join('') || '<div class="muted">—</div>'}</div>
      <div class="vz-sub" style="margin:10px 0 2px">Falling</div><div class="vz-hlist">${downs.map(mrow).join('') || '<div class="muted">—</div>'}</div></div>`;

    // 5) average day by weekday (last 8 weeks vs same 8 weeks last year)
    const dn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const avgW = (rep, d) => { const x = (rep.by_weekday || []).find((y) => y.dow === d); return x && x.days ? x.sales / x.days : null; };
    replaceCard('c-wd', C.bars({ title: 'Average day by weekday', sub: `last 8 weeks (${fmtRange(W8.from, W8.to, false)}) · for rostering`, width: width('c-wd'), height: 230,
      labels: dn, series: [{ name: 'Last 8 weeks', color: S1, values: dn.map((_, i) => avgW(w8, i + 1)) }, { name: 'Same weeks last year', color: S2, values: dn.map((_, i) => avgW(w8y, i + 1)) }] }));

    // 6) busy-times heatmap (average orders per hour, last 8 weeks)
    const dayCount = Object.fromEntries((w8.by_weekday || []).map((x) => [x.dow, x.days || 1]));
    const cells = (w8.heat || []).map((c) => ({ dow: c.dow, h: c.h, v: c.orders / (dayCount[c.dow] || 1) }));
    const hrsUsed = cells.filter((c) => c.v > 0).map((c) => c.h);
    const hLo = Math.min(...hrsUsed, 8), hHi = Math.max(...hrsUsed, 20);
    replaceCard('c-heat', C.heat({ title: 'Busy times', sub: 'average orders per hour · last 8 weeks', cells, hours: Array.from({ length: hHi - hLo + 1 }, (_, i) => hLo + i) }));

    // 7) plain-English insights
    const ins = [];
    const pw = pct(Tc.sales, Tw.sales), py = pct(Tc.sales, Ty.sales);
    if (live && N === 1 && !Tc.orders) ins.push(`No completed sales in Square yet today${esc(sinceTxt)}. Last week at this time: <b>${C.money(Tw.sales)}</b>; last year: <b>${C.money(Ty.sales)}</b>. Press “Refresh from Square” to update.`);
    else if (py != null) ins.push(`Sales are <b>${py >= 0 ? 'up' : 'down'} ${Math.abs(py).toFixed(0)}%</b> on ${yrLabel.toLowerCase()} (${C.money(Tc.sales)} vs ${C.money(Ty.sales)})${pw != null ? `, and <b>${pw >= 0 ? 'up' : 'down'} ${Math.abs(pw).toFixed(0)}%</b> on ${wkLabel.toLowerCase()}` : ''}${esc(sinceTxt)}.`);
    else if (pw != null) ins.push(`Sales are <b>${pw >= 0 ? 'up' : 'down'} ${Math.abs(pw).toFixed(0)}%</b> on ${wkLabel.toLowerCase()}${esc(sinceTxt)}. Import older history to compare with last year.`);
    const pa = pct(aov(Tc), aov(Ty));
    if (pa != null && Tc.orders && Math.abs(pa) >= 3) ins.push(`Average order is <b>$${(aov(Tc) / 100).toFixed(2)}</b>, ${pa > 0 ? 'up' : 'down'} ${Math.abs(pa).toFixed(0)}% on last year${pa < 0 ? ' — worth trying combos or add-ons at the counter' : ''}.`);
    const mtdP = pct(thisY[11] || 0, lastY[11] || 0);
    if (mtdP != null && thisY[11]) ins.push(`${monthName(months[11])} ${partialM ? 'to date' : ''}: <b>${C.money(thisY[11])}</b>, ${mtdP >= 0 ? 'ahead of' : 'behind'} last year by ${Math.abs(mtdP).toFixed(0)}%.`);
    const yearTot = thisY.reduce((a, v) => a + (v || 0), 0), yearLy = lastY.reduce((a, v) => a + (v || 0), 0);
    if (yearLy > 0) ins.push(`Last 12 months: <b>${C.money(yearTot)}</b> (${chg(yearTot, yearLy)} vs the 12 months before).`);
    const catMoves = (cur.by_category || []).filter((c) => c.sales > Tc.sales * 0.03).map((c) => ({ n: c.name, p: pct(c.sales, cmpVal(cmpRep.by_category || [], c.name)) })).filter((x) => x.p != null).sort((a, b) => b.p - a.p);
    if (catMoves.length > 1) ins.push(`Fastest-growing category: <b>${esc(catMoves[0].n)}</b> (${catMoves[0].p >= 0 ? '+' : ''}${catMoves[0].p.toFixed(0)}%). Weakest: <b>${esc(catMoves[catMoves.length - 1].n)}</b> (${catMoves[catMoves.length - 1].p.toFixed(0)}%).`);
    if (items[0]) ins.push(`Best seller: <b>${esc(items[0].name)}</b> — ${C.num(items[0].units)} sold, ${(items[0].sales / Math.max(1, Tc.sales) * 100).toFixed(0)}% of sales.`);
    const busiest = [...cells].sort((a, b) => b.v - a.v)[0];
    if (busiest) ins.push(`Busiest slot over the last 8 weeks: <b>${dn[busiest.dow - 1]} ${busiest.h % 12 || 12}${busiest.h < 12 ? 'am' : 'pm'}</b> (about ${busiest.v.toFixed(0)} orders an hour) — make sure the line is fully staffed.`);
    const wdAvg = dn.map((_, i) => avgW(w8, i + 1)).map((v, i) => ({ d: dn[i], v })).filter((x) => x.v != null).sort((a, b) => a.v - b.v);
    if (wdAvg.length > 2) ins.push(`Quietest day: <b>${wdAvg[0].d}</b> (avg ${C.money(wdAvg[0].v)}) vs busiest <b>${wdAvg[wdAvg.length - 1].d}</b> (${C.money(wdAvg[wdAvg.length - 1].v)}) — a good day for specials or lighter rosters.`);
    if (Math.abs(onC - onY) >= 2 && Ty.orders && Tc.orders) ins.push(`Online orders are <b>${onC.toFixed(0)}%</b> of orders (${onY.toFixed(0)}% a year ago).`);
    K.$('#ins').innerHTML = ins.map((x) => `<li>${x}</li>`).join('') || '<li class="muted">Not enough data yet for insights.</li>';

    // buttons
    K.$('#sync').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Refreshing…';
      try { await api.importSales(addDays(today(), -2), today()); lastAutoSync = Date.now(); K.renderSales(box, ...asked); }
      catch (err) { K.toast(err.message, { error: true }); e.target.disabled = false; e.target.textContent = '↻ Refresh from Square'; }
    };
    K.$('#older').onclick = () => importPanel(box, ...asked, cov);
  };

  // ---------------------------------------------------------------- first-time / older history import
  function importPanel(box, from, to, cov) {
    const end = cov && cov.first_day ? addDays(cov.first_day, -1) : today();
    box.innerHTML = `<div class="card" style="max-width:720px;margin-top:12px">
      <h2 style="margin-top:0">${cov ? 'Import older sales history' : 'Import your sales history from Square'}</h2>
      <p class="muted">${cov ? `History currently starts on <b>${esc(fmtDay(cov.first_day, true))}</b>.` : 'The sales reports compare with last week, last year and month-by-month — so they need your past sales from Square (only completed orders, item lines and amounts are copied).'}
        It takes about a minute per month of trading. Keep this page open while it runs; you can stop at any time and continue later.</p>
      <div class="row" style="flex-wrap:wrap">
        <label>Go back</label><select id="yrs"><option value="1">1 year</option><option value="2" selected>2 years</option><option value="3">3 years</option></select>
        <button class="btn primary" id="go">Start import</button>${cov ? '<button class="btn" id="back">Back to report</button>' : ''}
      </div>
      <div class="covbar"><div class="prog"><i id="pbar"></i></div><span id="ptxt"></span></div></div>`;
    if (cov) K.$('#back').onclick = () => K.renderSales(box, from, to);
    K.$('#go').onclick = async (e) => {
      e.target.disabled = true;
      const start = addYears(end, -K.$('#yrs').value), total = daysBetween(start, end);
      let orders = 0;
      try {
        await importRange(start, end, (a, b, r) => {
          orders += r?.orders || 0;
          K.$('#pbar').style.width = Math.min(100, daysBetween(start, b) / total * 100) + '%';
          K.$('#ptxt').textContent = `${fmtRange(start, b)} · ${C.num(orders)} orders imported`;
        });
        K.toast(`Imported ${C.num(orders)} orders from Square`);
        K.renderSales(box, from, to);
      } catch (err) { K.$('#ptxt').textContent = 'Stopped: ' + err.message + ' — press Start again to continue.'; e.target.disabled = false; }
    };
  }
})();
