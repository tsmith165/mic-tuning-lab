/* SVG drawing for the page. Marks carry classes, and app/style.css colors them from the theme tokens,
   so switching between light and dark needs no redraw. */
import { BANDS, PHASES, refCurve } from '../core/dsp.js';

const M = v => String(v).replace(/-/g, '−');
const W = el => Math.max(1, Math.round(el.getBoundingClientRect().width));
const f1 = v => v.toFixed(1);
const pathOf = pts => pts.map((p, i) => (i ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1])).join('');
function smooth(pts) {
  if (pts.length < 3) return pathOf(pts);
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}
const svg = (w, h, cls = '', body = '') => `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${body}</svg>`;
const label = id => (PHASES.find(p => p.id === id) || { label: id }).label;

/* A take's level over time, mirrored, on a square-root amplitude scale so quiet speech stays visible.
   take: { env: { fps, rms, peak }, marks, a }. o: { h, dur, upto (s, while recording), cur (segment index), cls, band, labels } */
function wave(el, take, o = {}) {
  const w = W(el), H = o.h || el.clientHeight || 112, top = o.labels === false ? 4 : 20, h = H - top, mid = top + h / 2, half = h / 2 - 1;
  const env = take.env || { fps: 25, rms: [], peak: [] }, fps = env.fps, n = Math.max(1, Math.round((o.dur || env.rms.length / fps) * fps));
  const have = Math.min(env.rms.length, o.upto != null ? Math.round(o.upto * fps) : env.rms.length);
  const y = db => Math.pow(10, Math.min(0, db) / 40) * half, X = i => i / n * w;
  let s = '';
  if (o.band) { const [lo, hi] = o.band, bh = f1(y(hi) - y(lo)); s += `<rect class="wv-band" x="0" y="${f1(mid - y(hi))}" width="${w}" height="${bh}"/><rect class="wv-band" x="0" y="${f1(mid + y(lo))}" width="${w}" height="${bh}"/>`; }
  (take.marks || []).forEach((m, i) => {
    const x = X(m.start * fps);
    if (i) s += `<line class="wv-mark" x1="${f1(x)}" x2="${f1(x)}" y1="${top - 4}" y2="${H}"/>`;
    if (o.labels !== false && (take.marks.length > 2 || i === 0 || (m.end - m.start) * fps / n * w > 90)) s += `<text class="wv-lbl${o.cur === i ? ' cur' : ''}${o.upto != null && m.start > o.upto ? ' later' : ''}" x="${f1(x + (i ? 6 : 0))}" y="11">${label(m.id)}</text>`;
  });
  const step = 2, cols = Math.floor(w / step), draw = (arr, cls) => {
    const t = [], b = [];
    for (let j = 0; j < cols; j++) {
      const a = Math.floor(j / cols * n), e = Math.max(a + 1, Math.floor((j + 1) / cols * n)); if (a >= have) break;
      let v = -200; for (let i = a; i < e && i < have; i++) if (arr[i] > v) v = arr[i];
      const xx = j * step + step / 2, yy = Math.max(.6, y(v)); t.push([xx, mid - yy]); b.push([xx, mid + yy]);
    }
    return t.length ? `<path class="${cls}" d="${pathOf(t)}L${t[t.length - 1][0]} ${mid}${pathOf(b.reverse()).replace('M', 'L')}Z"/>` : '';
  };
  s += draw(env.peak, 'wv-pk') + draw(env.rms, 'wv-rms') + `<line class="wv-axis" x1="0" x2="${w}" y1="${mid}" y2="${mid}"/>`;
  if (take.a && take.a.plosives && o.events !== false) for (const p of take.a.plosives) { const x = f1(X(p.t * fps)); s += `<line class="wv-ev plo" x1="${x}" x2="${x}" y1="${H - 5}" y2="${H}"/>`; }
  if (o.upto != null && have < n) s += `<line class="wv-head" x1="${f1(X(have))}" x2="${f1(X(have))}" y1="${top - 4}" y2="${H}"/>`;
  s += `<g class="ph" style="display:none"><line class="wv-play" x1="0" x2="0" y1="${top - 4}" y2="${H}"/><circle class="wv-playdot" cx="0" cy="${top - 4}" r="3"/></g>`;
  el.innerHTML = svg(w, H, 'wave' + (o.cls ? ' ' + o.cls : ''), s);
}
/* Moves a drawn waveform's play head; frac null hides it */
function playhead(el, frac) {
  const g = el && el.querySelector('g.ph'); if (!g) return;
  if (frac == null || !(frac >= 0 && frac <= 1)) { g.style.display = 'none'; return; }
  g.style.display = ''; g.setAttribute('transform', `translate(${f1(frac * W(el))} 0)`);
}

/* Long-term spectrum on a log frequency axis. series: [{ pts: [{ f, db }], cls }], first drawn on top.
   o: { h, ref: pts (average speech), noise: pts, hot: [band names], fill } */
const F0 = 40, F1 = 16000, LIVE = [-110, -20];
function spec(el, series, o = {}) {
  const w = W(el), H = o.h || el.clientHeight || 200, padL = 34, padR = 8, padT = 24, padB = 20;
  const all = [...series.flatMap(s => s.pts || []), ...(o.ref || [])].filter(p => p.f >= 60 && p.f <= 12000 && Number.isFinite(p.db));
  const hi = o.range ? o.range[1] : all.length ? Math.ceil((Math.max(...all.map(p => p.db)) + 6) / 10) * 10 : -30, lo = o.range ? o.range[0] : hi - 80;
  const X = f => padL + Math.log(f / F0) / Math.log(F1 / F0) * (w - padL - padR), Y = db => padT + (hi - Math.max(lo, Math.min(hi, db))) / (hi - lo) * (H - padT - padB);
  const line = pts => smooth(pts.filter(p => p.f >= F0 && p.f <= F1 && Number.isFinite(p.db)).map(p => [X(p.f), Y(p.db)]));
  let s = '';
  BANDS.forEach(([n, a, b], i) => {
    const A = X(Math.max(F0, a)), B = X(b), hot = (o.hot || []).includes(n);
    if (hot) s += `<rect class="sp-hot" x="${f1(A)}" y="${padT}" width="${f1(B - A)}" height="${H - padT - padB}"/>`;
    if (i) s += `<line class="sp-band" x1="${f1(A)}" x2="${f1(A)}" y1="4" y2="${H - padB}"/>`;
    s += `<text class="sp-bl${hot ? ' hot' : ''}" x="${f1((A + B) / 2)}" y="14" text-anchor="middle">${n}</text>`;
  });
  for (let db = hi - 10; db > lo; db -= 20) s += `<line class="sp-grid" x1="${padL}" x2="${w - padR}" y1="${f1(Y(db))}" y2="${f1(Y(db))}"/><text class="ax" x="${padL - 6}" y="${f1(Y(db) + 3.5)}" text-anchor="end">${M(db)}</text>`;
  for (const [f, l] of [[100, '100'], [1000, '1k'], [10000, '10k']]) s += `<text class="ax" x="${f1(X(f))}" y="${H - 5}" text-anchor="middle">${l}</text>`;
  s += `<text class="ax" x="${w - padR}" y="${H - 5}" text-anchor="end">Hz</text>`;
  if (o.noise) s += `<path class="sp-noise" d="${line(o.noise)}"/>`;
  if (o.ref) s += `<path class="sp-ref" d="${line(o.ref)}"/>`;
  series.slice().reverse().forEach((sr, k) => {
    if (!sr.pts) return;
    const d = line(sr.pts);
    if (o.fill && k === series.length - 1) { const pts = sr.pts.filter(p => p.f >= F0 && p.f <= F1); s += `<path class="sp-fill" d="${d}L${f1(X(pts[pts.length - 1].f))} ${H - padB}L${f1(X(pts[0].f))} ${H - padB}Z"/>`; }
    s += `<path class="sp-line s-${sr.cls || 'you'}" d="${d}"/>`;
  });
  el.innerHTML = svg(w, H, 'spec', s);
}

/* The live spectrum: the frame is drawn once, then two paths move. Bins are averaged into 1/6 octave bands
   so the curve has the same shape as a run's spectrum, and the average-speech line is aligned to it. */
function liveSpec(el, an) {
  const w = W(el), H = el.clientHeight || 170;
  if (!el._ls || el._ls.w !== w || el._ls.H !== H) {
    el._ls = { w, H, avg: null };
    spec(el, [], { h: H, range: LIVE });
    const g = el.querySelector('svg'); g.insertAdjacentHTML('beforeend', '<path class="sp-ref" d=""/><path class="sp-fill" d=""/><path class="sp-line s-you" d=""/>');
    [el._ls.ref, el._ls.fill, el._ls.line] = g.querySelectorAll('path');
  }
  if (!an) return;
  const L = el._ls, bw = an.fs / an.node.fftSize, pts = [];
  for (let i = 0; i < 96; i++) {
    const f = F0 * Math.pow(F1 / F0, i / 95), a = Math.max(1, Math.floor(f * Math.pow(2, -1 / 12) / bw)), b = Math.max(a, Math.ceil(f * Math.pow(2, 1 / 12) / bw));
    let p = 0; for (let k = a; k <= b; k++) p += Math.pow(10, an.freq[k] / 10);
    pts.push({ f, db: 10 * Math.log10(p / (b - a + 1) + 1e-14) });
  }
  L.avg = L.avg ? L.avg.map((q, i) => ({ f: q.f, db: q.db * .97 + pts[i].db * .03 })) : pts;
  const padL = 34, padR = 8, padT = 24, padB = 20, [lo, hi] = LIVE;
  const X = f => padL + Math.log(f / F0) / Math.log(F1 / F0) * (w - padL - padR), Y = db => padT + (hi - Math.max(lo, Math.min(hi, db))) / (hi - lo) * (H - padT - padB);
  const d = smooth(pts.map(p => [X(p.f), Y(p.db)]));
  L.line.setAttribute('d', d); L.fill.setAttribute('d', `${d}L${f1(X(F1))} ${H - padB}L${f1(X(F0))} ${H - padB}Z`);
  const ref = refCurve(L.avg); if (ref) L.ref.setAttribute('d', smooth(ref.filter(p => p.f >= F0 && p.f <= F1).map(p => [X(p.f), Y(p.db)])));
}

/* A target ruler: the scale, the target band, this run, and earlier runs as hollow dots or other series */
function ruler(el, o) {
  const w = W(el), H = 34, pad = 6, ty = 12, X = v => pad + (Math.max(o.min, Math.min(o.max, v)) - o.min) / (o.max - o.min) * (w - 2 * pad);
  let s = '';
  for (let k = 0, v = o.min; v <= o.max + 1e-6; k++, v = o.min + k * o.tick) { const maj = k % (o.every || 3) === 0; s += `<line class="ru-tick" x1="${f1(X(v))}" x2="${f1(X(v))}" y1="${ty + 6}" y2="${ty + (maj ? 11 : 9)}"/>`; }
  s += `<line class="ru-base" x1="${pad}" x2="${w - pad}" y1="${ty + 6}" y2="${ty + 6}"/>`;
  const b0 = X(Math.max(o.min, o.band[0])), b1 = X(Math.min(o.max, o.band[1]));
  s += `<rect class="ru-band" x="${f1(b0)}" y="${ty - 6}" width="${f1(b1 - b0)}" height="12" rx="2"/>`;
  o.labels.forEach(v => { const x = X(v); s += `<text class="ru-lbl${o.band.includes(v) ? ' t' : ''}" x="${f1(x)}" y="${H - 1}" text-anchor="${x < 14 ? 'start' : x > w - 14 ? 'end' : 'middle'}">${M(v)}</text>`; });
  for (const m of o.marks || []) {
    if (!Number.isFinite(m.v)) continue;
    s += m.ghost ? `<circle class="ru-ghost s-${m.s || 'prev'}" cx="${f1(X(m.v))}" cy="${ty}" r="4"/>` : `<rect class="ru-mark s-${m.s || 'you'}" x="${f1(X(m.v) - 1.5)}" y="${ty - 9}" width="3" height="18" rx="1.5"/>`;
  }
  if (o.arrow && Number.isFinite(o.arrow[0])) { const a = X(o.arrow[0]), b = X(o.arrow[1]); if (Math.abs(b - a) > 10) s += `<line class="ru-arrow" x1="${f1(a)}" x2="${f1(b + (b > a ? -6 : 6))}" y1="${ty}" y2="${ty}"/><path class="ru-head" d="M${f1(b)} ${ty}l${b > a ? -6 : 6} -3.5v7Z"/>`; }
  el.innerHTML = svg(w, H, 'ruler', s);
}

/* The input meter: momentary level, recent peak and the target band for speech peaks */
function meter(el, o) {
  const w = W(el), H = 40, X = v => (Math.max(-60, Math.min(0, v)) + 60) / 60 * w, by = 4, bh = 14, [lo, hi] = o.band;
  if (!el._mt || el._mt.w !== w || el._mt.lo !== lo || el._mt.hi !== hi) {
    let s = `<rect class="mt-track" x="0" y="${by}" width="${w}" height="${bh}" rx="3"/><rect class="mt-fill" x="0" y="${by}" width="0" height="${bh}" rx="3"/>`;
    s += `<rect class="mt-band" x="${f1(X(lo))}" y="${by}" width="${f1(X(hi) - X(lo))}" height="${bh}"/>`;
    for (const v of [lo, hi]) s += `<line class="mt-edge" x1="${f1(X(v))}" x2="${f1(X(v))}" y1="${by - 3}" y2="${by + bh + 3}"/>`;
    s += `<rect class="mt-pk" x="-4" y="${by}" width="2" height="${bh}"/>`;
    for (let v = -60; v <= 0; v += 6) s += `<line class="mt-tick" x1="${f1(X(v))}" x2="${f1(X(v))}" y1="${by + bh + 3}" y2="${by + bh + (v % 12 ? 5 : 7)}"/>`;
    [-60, -48, -36, -24, lo, hi, 0].forEach(v => { s += `<text class="mt-lbl${v === lo || v === hi ? ' t' : ''}" x="${f1(X(v))}" y="${H - 2}" text-anchor="${v === -60 ? 'start' : v === 0 ? 'end' : 'middle'}">${M(v)}</text>`; });
    el.innerHTML = svg(w, H, 'meter', s);
    el._mt = { w, lo, hi, fill: el.querySelector('.mt-fill'), pk: el.querySelector('.mt-pk') };
  }
  el._mt.fill.setAttribute('width', o.rms == null ? 0 : f1(X(o.rms)));
  el._mt.pk.setAttribute('x', o.pk == null ? -4 : f1(X(o.pk) - 1));
  el._mt.pk.classList.toggle('clip', o.pk != null && o.pk > -1);
}

/* Score over runs, oldest on the left. pts: [{ n, score }]; sel: run numbers marked in their series colors */
function trend(el, pts, sel = [], series = []) {
  const w = W(el), H = 92, padL = 22, padR = 10, padT = 8, padB = 18, X = i => padL + (pts.length > 1 ? i / (pts.length - 1) : .5) * (w - padL - padR), Y = v => padT + (100 - v) / 100 * (H - padT - padB);
  let s = `<rect class="tr-good" x="${padL}" y="${Y(100)}" width="${w - padL - padR}" height="${f1(Y(85) - Y(100))}"/>`;
  for (const v of [0, 50, 100]) s += `<line class="tr-grid" x1="${padL}" x2="${w - padR}" y1="${f1(Y(v))}" y2="${f1(Y(v))}"/><text class="ax" x="${padL - 5}" y="${f1(Y(v) + 3)}" text-anchor="end">${v}</text>`;
  s += `<path class="tr-line" d="${pathOf(pts.map((p, i) => [X(i), Y(p.score)]))}"/>`;
  const every = Math.ceil(pts.length / Math.max(1, Math.floor((w - padL - padR) / 22)));
  pts.forEach((p, i) => {
    const k = sel.indexOf(p.n);
    s += `<circle class="tr-dot${k >= 0 ? ' on s-' + (series[k] || 'you') : ''}" cx="${f1(X(i))}" cy="${f1(Y(p.score))}" r="${k >= 0 ? 4 : 2.6}"/>`;
    if (k >= 0 || i % every === 0 || i === pts.length - 1) s += `<text class="ax${k >= 0 ? ' on' : ''}" x="${f1(X(i))}" y="${H - 4}" text-anchor="middle">${p.n}</text>`;
  });
  el.innerHTML = svg(w, H, 'trend', s);
}

/* Icons: Lucide (ISC license), drawn at 16 px */
const IC = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  down: '<path d="m6 9 6 6 6-6"/>', lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>', play: '<path d="M7 4.5v15l12.5-7.5z" class="fill"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect width="12" height="12" x="6" y="6" rx="1.5" class="fill"/>', download: '<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>', copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', minus: '<path d="M5 12h14"/>', plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', usb: '<path d="M10 7V3h4v4"/><rect width="8" height="9" x="8" y="7" rx="1"/><path d="M12 16v5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};
const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${IC[name] || ''}</svg>`;
const icons = (root = document) => root.querySelectorAll('i[data-i]').forEach(i => { i.outerHTML = icon(i.dataset.i, i.className); });

export { M, wave, playhead, spec, liveSpec, ruler, meter, trend, icon, icons };
