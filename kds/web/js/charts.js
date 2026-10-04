/* Tiny SVG charts for the Reports page: line, grouped bars, paired horizontal bars, heatmap.
 * Colours come from CSS variables (--s1 this period, --s2 last year, --s3 last week; --seq-* for heatmaps)
 * so they follow the light/dark theme. Every mark has a hover tooltip (data-tip). */
(function () {
  const K = window.KDS, esc = K.esc;
  const C = (K.chart = {});
  const NS = 'http://www.w3.org/2000/svg';

  C.money = (c) => '$' + Math.round((c || 0) / 100).toLocaleString();
  C.moneyShort = (c) => { const d = (c || 0) / 100; return d >= 1e6 ? '$' + (d / 1e6).toFixed(1) + 'm' : d >= 1e4 ? '$' + Math.round(d / 1e3) + 'k' : d >= 1e3 ? '$' + (d / 1e3).toFixed(1) + 'k' : '$' + Math.round(d); };
  C.num = (n) => Math.round(n || 0).toLocaleString();

  // tidy axis: max and tick count so every tick is a round number (1, 2, 2.5, 5 × 10ⁿ)
  function niceAxis(v) {
    if (!(v > 0)) return { max: 1, n: 4 };
    let best = null;
    for (const n of [4, 5, 3]) {
      const raw = v / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
      for (const f of [1, 2, 2.5, 5, 10]) {
        const step = f * p; if (f === 2.5 && p < 10) continue;          // keep small counts whole
        if (step >= raw - 1e-9) { const max = step * n; if (!best || max < best.max - 1e-9) best = { max, n }; break; }
      }
    }
    return best;
  }
  const legend = (series) => series.length < 2 ? '' : `<div class="vz-legend">${series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}</div>`;
  const wrap = (title, sub, body, series) => `<div class="vz-card"><div class="vz-title">${esc(title)}${sub ? `<span class="vz-sub">${esc(sub)}</span>` : ''}</div>${legend(series || [])}${body}</div>`;

  // ---------------------------------------------------------------- line chart (shared x axis)
  C.line = function ({ title, sub, labels, series, fmt = C.money, axisFmt = C.moneyShort, height = 240, width = 760 }) {
    const W = width, H = height, L = 52, R = 14, T = 12, B = 30;
    const ax = niceAxis(Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v != null)))), max = ax.max;
    const n = labels.length, x = (i) => L + (n <= 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)), y = (v) => T + (H - T - B) * (1 - v / max);
    let g = '';
    for (let k = 0; k <= ax.n; k++) { const v = max * k / ax.n; g += `<line class="vz-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="vz-ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(axisFmt(v))}</text>`; }
    const every = Math.max(1, Math.ceil(n / 12));
    labels.forEach((lb, i) => { if (i % every === 0 || i === n - 1) g += `<text class="vz-ax" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>`; });
    // later series drawn first so "this period" sits on top
    [...series].reverse().forEach((s) => {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      g += `<path d="${d}" fill="none" stroke="var(${s.color})" stroke-width="${s.main ? 2.5 : 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
      if (n <= 31) s.values.forEach((v, i) => { if (v != null) g += `<circle cx="${x(i)}" cy="${y(v)}" r="${s.main ? 3.5 : 2.5}" fill="var(${s.color})" stroke="var(--panel)" stroke-width="2"/>`; });
    });
    // hover columns: guide line + tooltip listing every series
    const cw = n <= 1 ? W - L - R : (W - L - R) / (n - 1);
    labels.forEach((lb, i) => {
      const tip = `<b>${esc(lb)}</b>` + series.map((s) => `<div><i style="background:var(${s.color})"></i>${esc(s.name)}<span>${s.values[i] == null ? '—' : esc(fmt(s.values[i]))}</span></div>`).join('');
      g += `<g class="vz-col" data-tip="${esc(tip)}"><rect x="${x(i) - cw / 2}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent"/><line class="vz-guide" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/></g>`;
    });
    return wrap(title, sub, `<svg class="vz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>`, series);
  };

  // ---------------------------------------------------------------- grouped vertical bars
  C.bars = function ({ title, sub, labels, series, fmt = C.money, axisFmt = C.moneyShort, notes, height = 250, width = 760 }) {
    const W = width, H = height, L = 52, R = 10, T = 12, B = notes ? 46 : 30;
    const ax = niceAxis(Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v != null)))), max = ax.max;
    const n = labels.length, band = (W - L - R) / n, gap = 2, inner = Math.min(26, (band * 0.72 - gap * (series.length - 1)) / series.length);
    const y = (v) => T + (H - T - B) * (1 - v / max), base = y(0);
    let g = '';
    for (let k = 0; k <= ax.n; k++) { const v = max * k / ax.n; g += `<line class="vz-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="vz-ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(axisFmt(v))}</text>`; }
    labels.forEach((lb, i) => {
      const cx = L + band * i + band / 2, groupW = inner * series.length + gap * (series.length - 1);
      series.forEach((s, j) => {
        const v = s.values[i]; if (v == null || v <= 0) return;
        const bx = cx - groupW / 2 + j * (inner + gap), by = y(v), h = Math.max(1, base - by), r = Math.min(4, inner / 2, h);
        g += `<path d="M${bx},${base}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + inner - r}Q${bx + inner},${by} ${bx + inner},${by + r}V${base}Z" fill="var(${s.color})"/>`;
      });
      g += `<text class="vz-ax" x="${cx}" y="${H - (notes ? 26 : 8)}" text-anchor="middle">${esc(lb)}</text>`;
      if (notes && notes[i]) g += `<text class="vz-note ${notes[i].cls || ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(notes[i].text)}</text>`;
      const tip = `<b>${esc(lb)}</b>` + series.map((s) => `<div><i style="background:var(${s.color})"></i>${esc(s.name)}<span>${s.values[i] == null ? '—' : esc(fmt(s.values[i]))}</span></div>`).join('') + (notes && notes[i] ? `<div class="vz-tipnote">${esc(notes[i].text)}</div>` : '');
      g += `<rect class="vz-hit" data-tip="${esc(tip)}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>`;
    });
    return wrap(title, sub, `<svg class="vz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>`, series);
  };

  // ---------------------------------------------------------------- paired horizontal bars (this vs comparison)
  C.hbars = function ({ title, sub, rows, series, fmt = C.money, change }) {
    const max = Math.max(1, ...rows.flatMap((r) => r.values.filter((v) => v != null)));
    const body = rows.map((r) => {
      const tip = `<b>${esc(r.label)}</b>` + series.map((s, j) => `<div><i style="background:var(${s.color})"></i>${esc(s.name)}<span>${r.values[j] == null ? '—' : esc(fmt(r.values[j]))}</span></div>`).join('');
      return `<div class="vz-hrow" data-tip="${esc(tip)}"><div class="vz-hl">${esc(r.label)}</div>
        <div class="vz-hb">${series.map((s, j) => `<div class="vz-hbar ${j ? 'cmp' : ''}" style="width:${Math.max(0.4, (r.values[j] || 0) / max * 100)}%;background:var(${s.color})"></div>`).join('')}</div>
        <div class="vz-hv">${esc(fmt(r.values[0]))}${change ? change(r) : ''}</div></div>`;
    }).join('') || '<div class="muted">No data</div>';
    return wrap(title, sub, `<div class="vz-hlist">${body}</div>`, series);
  };

  // ---------------------------------------------------------------- heatmap (weekday × hour), one-hue sequential
  C.heat = function ({ title, sub, cells, hours, fmt = (v) => v.toFixed(1) + ' orders' }) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const max = Math.max(0.0001, ...cells.map((c) => c.v));
    const steps = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
    const get = (d, h) => cells.find((c) => c.dow === d && c.h === h);
    const fmtH = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
    let html = `<div class="vz-heat" style="grid-template-columns:3em repeat(${hours.length},1fr)"><div></div>${hours.map((h) => `<div class="vz-hh">${fmtH(h)}</div>`).join('')}`;
    days.forEach((dn, di) => {
      html += `<div class="vz-hd">${dn}</div>`;
      hours.forEach((h) => {
        const c = get(di + 1, h), v = c ? c.v : 0;
        const st = v <= 0 ? null : steps[Math.min(steps.length - 1, Math.floor(v / max * steps.length))];
        html += `<div class="vz-cell" style="background:${st ? `var(${st})` : 'var(--card2)'}" data-tip="${esc(`<b>${dn} ${fmtH(h)}</b><div>${fmt(v)}</div>`)}"></div>`;
      });
    });
    html += `</div><div class="vz-scale"><span>Quiet</span>${steps.map((s) => `<i style="background:var(${s})"></i>`).join('')}<span>Busy</span></div>`;
    return wrap(title, sub, html);
  };

  // ---------------------------------------------------------------- shared tooltip
  let tip = null;
  const show = (el, e) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'vz-tip'; document.body.appendChild(tip); }
    tip.innerHTML = el.getAttribute('data-tip'); tip.style.display = 'block';
    const r = tip.getBoundingClientRect(), pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  };
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.closest('.vz-card')) show(el, e); else if (tip) tip.style.display = 'none';
  });
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.closest('.vz-card')) show(el, e.touches[0]); else if (tip) tip.style.display = 'none';
  }, { passive: true });
})();
