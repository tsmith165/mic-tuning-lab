/* HTML for a run's result, the run list and the comparison, and the charts drawn into them.
   Everything that depends on the page's state arrives in the context object c, built in app.js. */
import { PHASES, refCurve } from '../core/dsp.js';
import { fmt, fmtS } from '../core/advice.js';
import { KINDS, METRICS, bestTake, diffSetups } from '../core/runs.js';
import { M, wave, spec, ruler, trend, icon } from './charts.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const metric = id => METRICS.find(m => m[0] === id);
const valueOf = (id, a) => metric(id)[3](a);
const inBand = (v, t) => Number.isFinite(v) && v >= t[0] && v <= t[1];

/* ---------- time ---------- */
const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
function dayOf(t) {
  const d = new Date(t), now = new Date(), day = 864e5, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return t >= start ? 'Today' : t >= start - day ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const when = t => (dayOf(t) === 'Today' ? '' : dayOf(t) + ' ') + hm(t);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ---------- rulers for the four level metrics ---------- */
const RULERS = {
  peaks: P => ({ min: -36, max: 0, tick: 3, every: 4, band: P.peak, labels: [-36, -24, P.peak[0], P.peak[1], 0] }),
  speech: P => ({ min: -48, max: -6, tick: 3, every: 2, band: P.speech, labels: [-48, P.speech[0], P.speech[1], -6] }),
  snr: P => ({ min: 0, max: 60, tick: 5, every: 2, band: [P.snr, 60], labels: [0, P.snr, 60] }),
  noise: P => ({ min: -90, max: -40, tick: 5, every: 2, band: [-90, P.noise], labels: [-90, P.noise, -40] }),
  presence: () => ({ min: -36, max: -6, tick: 3, every: 2, band: [-22, -6], labels: [-36, -22, -6] }),
};
const target = (id, P) => metric(id)[4](P);
const val = (id, a) => { const v = valueOf(id, a); return Number.isFinite(v) ? fmt(v) : '—'; };

function levelsHtml(take, P, keys = ['peaks', 'speech', 'snr', 'noise']) {
  return keys.map(k => { const [, name, unit] = metric(k), v = valueOf(k, take.a);
    return `<div class="metric"><span class="name">${name}</span><span class="val${inBand(v, target(k, P)) ? '' : ' bad'}">${val(k, take.a)}<small>${unit}</small></span><div class="ru" data-k="${k}"></div></div>`; }).join('');
}
function drawLevels(root, take, P, prev) {
  root.querySelectorAll('.metric .ru').forEach(el => {
    const k = el.dataset.k, o = RULERS[k](P), v = valueOf(k, take.a), t = target(k, P), aim = v < t[0] ? t[0] : v > t[1] ? t[1] : null;
    ruler(el, { ...o, marks: [...(prev ? [{ v: valueOf(k, prev.a), ghost: true }] : []), { v }], arrow: aim != null ? [v, aim] : null });
  });
}
function minorHtml(a) {
  const item = (name, v, unit, bad) => `<span>${name}<b${bad ? ' class="bad"' : ''}>${v}${unit ? `<small>${unit}</small>` : ''}</b></span>`;
  return `<div class="minor">${item('Loudness', M(fmt(a.callLufs)), 'LUFS')}${item('Max peak', M(fmt(a.peak)), 'dBFS', a.peak > -3)}${item('Plosives', a.plosives.length, '', a.plosives.length > 3)}${item('Sibilance', M(fmtS(a.sibPeak)), 'dB', a.sibPeak > 3)}</div>`;
}

/* ---------- a run: score, verdict, levels, fixes or settings, the take and its spectrum ---------- */
const scoreClass = s => s >= 85 ? 'good' : s < 60 ? 'bad' : '';
function head(run, c) {
  const t = bestTake(run), s = c.score(run), m = t.meta, prev = c.prev, d = prev ? s - c.score(prev) : null;
  const meta = [`Run ${run.n}`, KINDS[run.kind], m.distance ? m.distance + ' in' : null, m.hw ? c.describeHw(m.hw, m.adapter) : m.device, when(run.created)].filter(Boolean);
  return `<div class="res-head">
    <div class="score" aria-label="Score ${s} of 100"><b class="num">${s}</b><span class="bar ${scoreClass(s)}"><i style="width:${s}%"></i></span></div>
    <div><h1>${esc(c.verdict(run).title)}</h1><div class="meta">${meta.map(x => `<span>${esc(x)}</span>`).join('')}${run.unsaved ? '<span class="dn">Not saved</span>' : ''}</div></div>
    ${d != null ? `<div class="delta ${d > 0 ? 'up' : d < 0 ? 'dn' : ''}"><b>${d > 0 ? '+' : ''}${M(d)}</b>vs Run ${prev.n}</div>` : '<div></div>'}
  </div>`;
}
function fixesHtml(rows) {
  if (!rows.length) return '';
  return rows.map((r, i) => `<div class="fix${r.cls ? ' ' + r.cls : ''}"><span class="i">${r.cls === 'note' ? icon('info') : i + 1}</span><div><div class="t">${esc(r.title)}</div>${r.detail ? `<div class="c">${esc(r.detail)}</div>` : ''}</div>
    <div class="acts">${r.actions.map(x => x.done ? `<span class="ok">${icon('check')}Applied</span>` : x.hand ? `<span class="hand">By hand</span>` : `<button class="btn line sm" data-act="fix" data-f="${x.f}" data-a="${x.a}" ${x.disabled ? `disabled title="${esc(x.why)}"` : ''}>${esc(x.label)}</button>`).join('')}</div></div>`).join('');
}
function settingsHtml(run, c) {
  const t = bestTake(run), h = t.meta.hw, rows = [['Mic', c.micName(t)]];
  if (h) {
    const { same } = diffSetups([t]), v = k => (same.find(x => x.key === k) || {}).values?.[0];
    rows.push(['Mode', v('mode')]);
    if (h.mode === 'auto') rows.push(['Position', v('position')], ['Tone', v('tone')]); else rows.push(['Gain', v('gain')], ['Compressor', v('comp')]);
    const filters = [['hp', 'High-pass'], ['hpf', null], ['pres', 'Presence'], ['denoise', 'Denoiser'], ['popper', 'Popper stopper'], ['limiter', 'Limiter']].filter(([k]) => v(k) && v(k) !== 'Off').map(([k, l]) => l || 'High-pass ' + v(k));
    rows.push(['Filters', filters.length ? [...new Set(filters)].join(' · ') : 'None']);
  }
  rows.push(['Distance', t.meta.distance ? t.meta.distance + ' in' : 'Not set'], ['Use', c.useLabel(run.use)]);
  return rows.filter(r => r[1] != null).map(([k, v]) => `<div class="chg-row"><span class="k">${k}</span><span class="vv">${esc(v)}</span></div>`).join('')
    + `<div class="btns">${h ? `<button class="btn primary sm" data-act="use" ${c.canUse ? '' : `disabled title="${esc(c.canUseWhy)}"`}>Use these settings</button>` : ''}${c.prev ? `<button class="btn line sm" data-act="cmp-prev">Compare with Run ${c.prev.n}</button>` : ''}</div>`;
}
function takeHtml(run, ti, c) {
  const t = run.takes[ti], dur = t.env ? t.env.rms.length / t.env.fps : t.a.dur, on = c.playing === `${run.id}:${ti}`;
  return `<div class="take">
    <button class="playbtn" data-act="play" data-t="${ti}" data-key="${run.id}:${ti}" aria-label="${on ? 'Pause' : 'Play'} run ${run.n}" ${t.audio || t.data ? '' : 'disabled'}>${icon(on ? 'pause' : 'play')}</button>
    <div class="wv" data-wave="${run.id}:${ti}" role="img" aria-label="Waveform of run ${run.n}. Click to play from a point."></div>
    <div class="side"><span class="time" data-time="${run.id}:${ti}">0:00 / ${mmss(dur)}</span><div>
      <button class="iconbtn sm" data-act="copy" aria-label="Copy report" title="Copy report">${icon('copy')}</button>
      <button class="iconbtn sm" data-act="wav" data-t="${ti}" aria-label="Save WAV" title="Save WAV">${icon('download')}</button>
      ${c.mode === 'runs' ? `<button class="iconbtn sm" data-act="del" aria-label="Delete run ${run.n}" title="Delete run">${icon('trash')}</button>` : ''}</div></div>
  </div>`;
}
function sweepHtml(run, c) {
  if (run.kind !== 'sweep') return '';
  const ranked = run.takes.map((t, i) => ({ t, i, s: c.takeScore(t) })).sort((a, b) => b.s - a.s);
  return `<div><div class="sect-h"><span class="cap">Settings tried</span></div><table class="steps"><tbody>${ranked.map(({ t, i, s }, k) => `<tr data-take="${i}" class="${k === 0 ? 'best' : ''}">
    <td class="i">${k + 1}</td><td>${esc(t.meta.step || t.name)}${i === run.best ? '<span class="tag">Kept</span>' : ''}${c.onMic(t) ? '<span class="tag">On the mic</span>' : ''}</td>
    <td class="cfg">${esc(c.describeHw(t.meta.hw, t.meta.adapter))}</td><td class="bar"><span><i style="width:${s}%"></i></span></td><td class="s">${s}</td>
    <td class="act"><button class="iconbtn sm" data-act="play" data-t="${i}" data-key="${run.id}:${i}" aria-label="Play ${esc(t.meta.step || t.name)}">${icon(c.playing === `${run.id}:${i}` ? 'pause' : 'play')}</button><button class="btn line sm" data-act="apply-take" data-t="${i}" ${c.canUse && !c.onMic(t) ? '' : 'disabled'}>Apply</button></td>
  </tr>`).join('')}</tbody></table></div>`;
}
const hotBands = v => [...new Set(v.findings.flatMap(f => ({ muffled: ['Presence'], boomy: ['Body'], sibilance: ['Sibilance'], rumble: ['Rumble'], plosives: [] })[f.id] || []))];
function runHtml(run, c) {
  const t = bestTake(run), side = c.mode === 'tune'
    ? `<div class="sect-h"><span class="cap">Fixes</span></div>${fixesHtml(c.fixRows(run)) || '<div class="fix good"><span class="i">' + icon('check') + '</span><div><div class="t">Nothing to fix</div></div><div></div></div>'}`
    : `<div class="sect-h"><span class="cap">Mic settings</span></div>${settingsHtml(run, c)}`;
  const legend = `<span class="legend"><i class="sw s-you"></i>Run ${run.n}${c.mode === 'runs' && c.prev ? `<i class="sw s-prev"></i>Run ${c.prev.n}` : ''}<i class="ln"></i>Average voice${c.mode === 'tune' ? '<i class="nz"></i>Room noise' : ''}</span>`;
  return `<div class="res">
    ${c.notice ? `<div class="notice">${icon('check')}<p>${esc(c.notice.text)}<span class="mono">${esc(c.notice.change)}</span></p><button class="btn quiet sm" data-act="undo">${icon('undo')}Undo</button></div>` : ''}
    ${head(run, c)}
    <div class="res-grid"><div><div class="sect-h"><span class="cap">Levels</span></div><div class="levels">${levelsHtml(t, c.P)}</div>${minorHtml(t.a)}</div><div>${side}</div></div>
    ${sweepHtml(run, c)}
    ${takeHtml(run, run.best, c)}
    ${c.mode === 'tune' ? `<div><div class="tabs" role="tablist">${[['spectrum', 'Spectrum'], ['segments', 'Segments'], ...(c.obsTab ? [['obs', 'OBS chain']] : [])].map(([k, l]) => `<button role="tab" data-act="tab" data-tab="${k}" aria-selected="${c.tab === k}">${l}</button>`).join('')}</div>
      <div data-pane="spectrum" ${c.tab === 'spectrum' ? '' : 'hidden'}><div class="sect-h" style="justify-content:flex-end">${legend}</div><div class="sp" data-spec></div></div>
      <div data-pane="segments" ${c.tab === 'segments' ? '' : 'hidden'}>${segmentsHtml(t)}</div>
      ${c.obsTab ? `<div data-pane="obs" ${c.tab === 'obs' ? '' : 'hidden'} id="obsPane"></div>` : ''}</div>`
    : `<div><div class="sect-h"><span class="cap">Spectrum</span><span class="spacer"></span>${legend}</div><div class="sp" data-spec style="height:190px"></div></div>`}
  </div>`;
}
function segmentsHtml(t) {
  const a = t.a;
  if (!a.phases.length) return '<div class="empty">Segments come with a Quick check, which records six short prompts.</div>';
  return `<table class="tbl"><thead><tr><th>Segment</th><th>Loudness LUFS</th><th>Speech peaks dBFS</th><th>Over noise dB</th></tr></thead><tbody>${a.phases.map(p => `<tr><td>${esc(p.label)}</td><td>${M(fmt(p.lufs))}</td><td>${M(fmt(p.peak))}</td><td>${M(fmt(p.speech - a.noise, 0))}</td></tr>`).join('')}</tbody></table>`;
}
function drawRun(root, run, c) {
  const t = bestTake(run), prevT = c.prev && bestTake(c.prev);
  drawLevels(root, t, c.P, prevT);
  const w = root.querySelector(`[data-wave="${run.id}:${run.best}"]`); if (w) wave(w, t, { h: 112, band: c.P.peak });
  const sp = [...root.querySelectorAll('[data-spec]')].find(e => e.offsetParent);
  if (sp) spec(sp, [{ pts: t.a.ltas, cls: 'you' }, ...(c.mode === 'runs' && prevT ? [{ pts: prevT.a.ltas, cls: 'prev' }] : [])], { h: sp.clientHeight, ref: t.a.ltas && refCurve(t.a.ltas), noise: c.mode === 'tune' ? t.a.noiseSpec : null, hot: hotBands(c.verdict(run)), fill: c.mode === 'tune' });
}

/* ---------- the run list ---------- */
function runListHtml(runs, c) {
  if (!runs.length) return `<div class="empty" style="padding:20px">No runs yet<button class="btn primary sm" data-act="go-tune">Record a check</button></div>`;
  let day = '';
  return runs.slice().reverse().map(r => {
    const d = c.prevScore(r), k = c.cmp.indexOf(r.id), s = c.score(r), dd = d == null ? null : s - d;
    const hd = dayOf(r.created) !== day ? `<div class="rl-day">${(day = dayOf(r.created))}</div>` : '';
    return hd + `<div class="run" data-run="${r.id}" ${c.open === r.id && !c.cmp.length ? 'aria-current="true"' : ''}>
      <button class="cb${k >= 0 ? ' s-' + c.series[k] : ''}" role="checkbox" aria-checked="${k >= 0}" data-act="tick" aria-label="Compare run ${r.n}">${k >= 0 ? icon('check') : ''}</button>
      <div style="min-width:0"><div class="l1"><span class="n">${r.n}</span>${KINDS[r.kind]}<span class="tm">${hm(r.created)}</span></div><div class="l2" title="${esc(c.line(r))}">${esc(c.line(r))}</div></div>
      <div class="sc">${s}<small class="${dd > 0 ? 'up' : dd < 0 ? 'dn' : 'dim'}">${dd == null ? '' : (dd > 0 ? '+' : '') + M(dd)}</small></div></div>`;
  }).join('');
}
function drawTrend(el, runs, c) {
  const pts = runs.slice(-24).map(r => ({ n: r.n, score: c.score(r) })), sel = c.cmp.length ? c.cmp.map(id => runs.find(r => r.id === id).n) : c.open ? [runs.find(r => r.id === c.open)?.n] : [];
  trend(el, pts, sel, c.cmp.length ? c.series : ['you']);
}

/* ---------- comparing two or three runs ---------- */
/* The newest run is always drawn in ink, the oldest in gray */
const seriesOf = n => n === 1 ? ['you'] : n === 2 ? ['prev', 'you'] : ['prev', 'c3', 'you'];
function compareHtml(runs, c) {
  const S = seriesOf(runs.length), takes = runs.map(bestTake), { changed, same } = diffSetups(takes), sc = runs.map(c.score), d = sc.at(-1) - sc[0];
  const letters = 'ABC', abBtn = runs.map((r, i) => `<button data-act="ab" data-i="${i}" class="${c.ab === i ? 'on' : ''}" aria-pressed="${c.ab === i}">${letters[i]} · ${r.n}</button>`).join('');
  const sameText = same.filter(x => !(x.key === 'proc' || x.key === 'muted') || x.values[0] !== 'Off').map(x => x.key === 'distance' ? x.values[0] : ['hp', 'pres', 'denoise', 'popper', 'limiter'].includes(x.key) ? (x.values[0] === 'On' ? x.label : null) : x.key === 'comp' ? `Compressor ${x.values[0]}` : x.values[0]).filter(Boolean);
  return `<div class="res">
    <div class="cmp-head">${runs.map((r, i) => `${i ? `<span class="dim">${icon('arrow')}</span>` : ''}<span class="chip"><i class="sw s-${S[i]}"></i>Run ${r.n}<button data-act="untick" data-run="${r.id}" aria-label="Remove run ${r.n} from the comparison">${icon('x')}</button></span>`).join('')}
      <span class="spacer"></span><div class="abctl"><div class="seg abseg" role="group" aria-label="Listen to">${abBtn}</div><button class="playbtn" data-act="ab-play" aria-label="${c.abOn ? 'Pause' : 'Play'} the comparison" ${c.abReady ? '' : 'disabled'}>${icon(c.abOn ? 'pause' : 'play')}</button></div></div>
    <div class="cmp-grid"><div>
      <div class="bigdelta"><span class="from">${sc.slice(0, -1).join(' → ')}</span><span class="arrow">→</span><b>${sc.at(-1)}</b><span class="chg ${d > 0 ? 'up' : d < 0 ? 'dn' : 'dim'}">${d > 0 ? '+' : ''}${M(d)}</span></div>
      <div class="sect-h" style="margin-top:22px"><span class="cap">What changed</span></div>
      ${changed.length ? changed.map(x => `<div class="chg-row"><span class="k">${esc(x.label)}</span><span class="vv">${x.values.map((v, i) => i < x.values.length - 1 ? `<s>${esc(v ?? '—')} →</s> ` : esc(v ?? '—')).join('')}</span></div>`).join('') : '<div class="chg-row"><span class="k">Nothing in the setup</span><span></span></div>'}
      ${sameText.length ? `<div class="chg-same">Same: ${esc(sameText.join(' · '))}</div>` : ''}
    </div><div>
      <div class="cm h" style="--n:${runs.length}"><div></div>${runs.map(r => `<div>Run ${r.n}</div>`).join('')}<div>Change</div><div></div></div>
      <div class="cmrows">${['peaks', 'speech', 'snr', 'noise', 'presence'].map(k => {
        const t = target(k, c.P), vs = takes.map(x => valueOf(k, x.a)), ch = vs.at(-1) - vs[0], off = v => !Number.isFinite(v) ? NaN : v < t[0] ? t[0] - v : v > t[1] ? v - t[1] : 0;
        const better = off(vs.at(-1)) < off(vs[0]) - .3, worse = off(vs.at(-1)) > off(vs[0]) + .3;
        return `<div class="cm" style="--n:${runs.length}"><span class="name">${metric(k)[1]}</span>${vs.map((v, i) => `<span class="${i === vs.length - 1 ? 'b' + (inBand(v, t) ? '' : ' bad') : 'a'}">${Number.isFinite(v) ? M(fmt(v)) : '—'}</span>`).join('')}<span class="d ${better ? 'up' : worse ? 'dn' : ''}">${Number.isFinite(ch) ? (ch > 0 ? '+' : '') + M(fmt(ch)) : '—'}</span><div class="ru" data-k="${k}"></div></div>`;
      }).join('')}</div>
    </div></div>
    <div><div class="sect-h"><span class="cap">Spectrum</span><span class="spacer"></span><span class="legend">${runs.map((r, i) => `<i class="sw s-${S[i]}"></i>Run ${r.n}`).join('')}<i class="ln"></i>Average voice</span></div><div class="sp" data-spec style="height:190px"></div></div>
    <div style="display:flex;flex-direction:column;gap:8px">${runs.map((r, i) => `<div class="abrow${c.ab === i ? ' on' : ''}"><span class="who"><i class="sw s-${S[i]}"></i>${letters[i]} · ${r.n}</span><div class="wv" data-wave="${r.id}:${r.best}" data-ab="${i}"></div></div>`).join('')}</div>
  </div>`;
}
function drawCompare(root, runs, c) {
  const S = seriesOf(runs.length), takes = runs.map(bestTake);
  root.querySelectorAll('.cm .ru').forEach(el => { const k = el.dataset.k; ruler(el, { ...RULERS[k](c.P), marks: takes.map((t, i) => ({ v: valueOf(k, t.a), s: S[i] })) }); });
  const sp = root.querySelector('[data-spec]');
  spec(sp, takes.map((t, i) => ({ pts: t.a.ltas, cls: S[i] })).reverse(), { h: 190, ref: takes.at(-1).a.ltas && refCurve(takes.at(-1).a.ltas) });
  root.querySelectorAll('.abrow .wv').forEach((el, i) => wave(el, takes[i], { h: c.ab === i ? 84 : 64, cls: S[i] === 'you' ? '' : S[i], labels: c.ab === i, band: c.ab === i ? c.P.peak : null, events: false }));
}

export { esc, hm, dayOf, when, mmss, RULERS, levelsHtml, drawLevels, runHtml, drawRun, runListHtml, drawTrend, compareHtml, drawCompare, seriesOf, PHASES };
