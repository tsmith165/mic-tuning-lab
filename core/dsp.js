/* Measuring code shared by the page, the tests and the CLI. Pure functions over Float32Array samples. */
const dbA = v => 20 * Math.log10(Math.max(v, 1e-9));
const dbP = v => 10 * Math.log10(Math.max(v, 1e-12));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function pct(arr, p) {
  if (!arr || !arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const i = clamp((a.length - 1) * p, 0, a.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const powMean = dbs => dbs.length ? dbP(dbs.reduce((s, d) => s + Math.pow(10, d / 10), 0) / dbs.length) : -Infinity;

/* RBJ biquad designs, normalised by a0 */
function rbj(type, fs, f0, Q, gain = 0) {
  const A = Math.pow(10, gain / 40), w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q), sq = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lp': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    case 'peak': b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
    case 'hs': b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; break;
    case 'ls': b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
class BQ {
  constructor(c) { this.c = c; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  run(inp, out = new Float32Array(inp.length)) {
    const { b0, b1, b2, a1, a2 } = this.c; let { x1, x2, y1, y2 } = this;
    for (let i = 0; i < inp.length; i++) { const x = inp[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y; }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2; return out;
  }
}
/* ITU-R BS.1770 K-weighting (pre-filter shelf + RLB high-pass), any sample rate */
const kChain = fs => [new BQ(rbj('hs', fs, 1500, Math.SQRT1_2, 4)), new BQ(rbj('hp', fs, 38, 0.5))];
const filt = (x, chain) => chain.reduce((y, b) => b.run(y), x);

/* Gated integrated loudness over [a,b) using a prefix sum of K-weighted squares */
function integratedRange(cs, fs, a, b) {
  const bl = Math.round(0.4 * fs), hop = Math.round(0.1 * fs), L = m => -0.691 + 10 * Math.log10(m);
  const blocks = [];
  for (let s = a; s + bl <= b; s += hop) blocks.push((cs[s + bl] - cs[s]) / bl);
  const g1 = blocks.filter(m => L(m) > -70);
  if (!g1.length) return -Infinity;
  const rel = L(g1.reduce((x, y) => x + y, 0) / g1.length) - 10;
  const g2 = g1.filter(m => L(m) > rel);
  return g2.length ? L(g2.reduce((x, y) => x + y, 0) / g2.length) : -Infinity;
}
function loudness(x, fs) {
  const k = filt(x, kChain(fs)), N = k.length, cs = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + k[i] * k[i];
  const L = m => -0.691 + 10 * Math.log10(Math.max(m, 1e-15));
  const integrated = integratedRange(cs, fs, 0, N);
  const sl = 3 * fs, sh = Math.round(0.1 * fs), st = [];
  for (let s = 0; s + sl <= N; s += sh) st.push(L((cs[s + sl] - cs[s]) / sl));
  let lra = NaN; const stA = st.filter(v => v > -70);
  if (stA.length > 3) { const rel = powMean(stA) - 20, r = stA.filter(v => v > rel); lra = pct(r, .95) - pct(r, .10); }
  return { integrated, lra, cs };
}

/* In-place radix-2 FFT */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
/* Averaged one-sided power spectral density (dB re 1/Hz), so spectra with different FFT lengths compare directly */
function avgSpectrum(x, starts, n, fs) {
  if (!starts.length) return null;
  const w = new Float64Array(n); let w2 = 0; for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); w2 += w[i] * w[i]; }
  const acc = new Float64Array(n / 2 + 1), re = new Float64Array(n), im = new Float64Array(n), norm = fs * w2 / 2;
  for (const s of starts) {
    for (let i = 0; i < n; i++) { re[i] = (x[s + i] || 0) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / norm;
  }
  for (let k = 0; k <= n / 2; k++) acc[k] /= starts.length;
  return { pow: acc, n };
}
/* 1/6-octave smoothing onto log-spaced points */
function smoothSpec(sp, fs, pts = 170, f0 = 30, f1 = 16000, frac = 1 / 6) {
  if (!sp) return null;
  const { pow, n } = sp, bw = fs / n, out = [];
  for (let i = 0; i < pts; i++) {
    const f = f0 * Math.pow(f1 / f0, i / (pts - 1));
    let lo = Math.floor(f * Math.pow(2, -frac / 2) / bw), hi = Math.ceil(f * Math.pow(2, frac / 2) / bw);
    lo = clamp(lo, 1, n / 2); hi = clamp(Math.max(hi, lo), 1, n / 2);
    let s = 0; for (let k = lo; k <= hi; k++) s += pow[k];
    out.push({ f, db: dbP(s / (hi - lo + 1)) });
  }
  return out;
}
const REF_LTASS = [[63, 38.6], [80, 43.5], [100, 54.4], [125, 57.7], [160, 56.8], [200, 58.2], [250, 59.7], [315, 60.0], [400, 62.4], [500, 62.6], [630, 60.6], [800, 55.7], [1000, 53.1], [1250, 53.7], [1600, 52.3], [2000, 48.7], [2500, 48.9], [3150, 47.0], [4000, 46.0], [5000, 44.4], [6300, 43.3], [8000, 42.4], [10000, 41.9], [12500, 39.8], [16000, 40.4]];
/* The reference as density (band level minus 10 log10 of the 1/3-octave bandwidth), shifted to match a measured curve over 500 Hz to 2 kHz */
function refCurve(ltas) {
  if (!ltas) return null;
  const dens = REF_LTASS.map(([f, l]) => ({ f, db: l - 10 * Math.log10(0.2316 * f) }));
  const at = f => { const i = ltas.findIndex(p => p.f >= f); return i <= 0 ? ltas[0].db : ltas[i - 1].db + (ltas[i].db - ltas[i - 1].db) * Math.log(f / ltas[i - 1].f) / Math.log(ltas[i].f / ltas[i - 1].f); };
  const mid = dens.filter(p => p.f >= 500 && p.f <= 2000), off = mid.reduce((s, p) => s + at(p.f) - p.db, 0) / mid.length;
  return dens.map(p => ({ f: p.f, db: p.db + off }));
}
const BANDS = [['Rumble', 30, 80], ['Body', 80, 250], ['Mud', 250, 500], ['Mid', 500, 2000], ['Presence', 2000, 5000], ['Sibilance', 5000, 9000], ['Air', 9000, 16000]];
function bandLevels(sm) {
  if (!sm) return null;
  const out = {};
  for (const [name, lo, hi] of BANDS) { const p = sm.filter(q => q.f >= lo && q.f < hi); out[name] = p.length ? p.reduce((s, q) => s + q.db, 0) / p.length : NaN; }
  const mid = out.Mid; const rel = {}; for (const k in out) rel[k] = out[k] - mid;
  return { abs: out, rel };
}
function detectHum(sp, fs) {
  if (!sp) return null;
  const { pow, n } = sp, bw = fs / n, res = [];
  for (const f0 of [50, 60]) {
    let hits = 0, worst = 0;
    for (let h = 1; h <= 5; h++) {
      const f = f0 * h, c = Math.round(f / bw);
      let pk = 0; for (let k = c - 1; k <= c + 1; k++) pk = Math.max(pk, pow[k] || 0);
      const nb = []; for (let k = Math.round((f - 18) / bw); k <= Math.round((f + 18) / bw); k++) if (Math.abs(k * bw - f) > 6) nb.push(pow[k] || 1e-15);
      const prom = dbP(pk) - dbP(pct(nb, .5));
      if (prom > 10) { hits++; worst = Math.max(worst, prom); }
    }
    res.push({ f0, hits, worst });
  }
  const best = res.sort((a, b) => b.hits - a.hits || b.worst - a.worst)[0];
  return best.hits >= 2 ? best : null;
}

const PHASES = [
  { id: 'silence', label: 'Room tone', dur: 5, text: 'Stay silent. Hands off the keyboard and mouse.' },
  { id: 'normal', label: 'Normal voice', dur: 14, text: "I'm testing my microphone from where I normally sit. This is the voice I use on calls all day, and it should sound clear, warm and easy to understand without anyone reaching for the volume." },
  { id: 'quiet', label: 'Quiet voice', dur: 7, text: "Now softly, almost a whisper: can you still hear every word I'm saying?" },
  { id: 'plosive', label: 'Plosives', dur: 6, text: 'Peter picked a perfect purple pepper. Bob bought a big blue boat.' },
  { id: 'sibilant', label: 'Sibilance', dur: 6, text: 'She sells sea shells. Sixty-six sizzling sausages, sister.' },
  { id: 'loud', label: 'Projected', dur: 5, text: "And now with energy, like a big moment on stream: let's go, that was amazing!" },
];

function analyze(x, fs, marks) {
  const N = x.length, F = Math.round(fs * 0.02), nF = Math.max(1, Math.floor(N / F));
  let sum = 0, mx = 0, clips = 0, inClip = false;
  for (let i = 0; i < N; i++) { const v = x[i], a = Math.abs(v); sum += v; if (a > mx) mx = a; if (a >= 0.999) { if (!inClip) clips++; inClip = true; } else inClip = false; }
  const low = new BQ(rbj('lp', fs, 150, Math.SQRT1_2)).run(x);
  const sib = new BQ(rbj('lp', fs, 10000, Math.SQRT1_2)).run(new BQ(rbj('hp', fs, 5000, Math.SQRT1_2)).run(x));
  const fr = { db: new Float32Array(nF), pk: new Float32Array(nF), low: new Float32Array(nF), sib: new Float32Array(nF), ph: new Int8Array(nF).fill(-1) };
  for (let f = 0; f < nF; f++) {
    let s = 0, sl = 0, ss = 0, p = 0;
    for (let i = f * F, e = Math.min(N, i + F); i < e; i++) { const v = x[i]; s += v * v; sl += low[i] * low[i]; ss += sib[i] * sib[i]; const a = Math.abs(v); if (a > p) p = a; }
    fr.db[f] = dbP(s / F); fr.pk[f] = dbA(p); fr.low[f] = dbP(sl / F); fr.sib[f] = dbP(ss / F);
  }
  const phaseIdx = id => PHASES.findIndex(p => p.id === id);
  if (marks && marks.length) for (const m of marks) {
    const pi = phaseIdx(m.id), a = Math.floor(m.start * fs / F), b = Math.min(nF, Math.floor(m.end * fs / F));
    for (let f = a; f < b; f++) fr.ph[f] = pi;
  }
  const all = Array.from(fr.db);
  const p10 = pct(all, .10);
  let noise = p10, noiseContaminated = false, silA = 0, silB = 0;
  const sil = marks && marks.find(m => m.id === 'silence');
  if (sil) {
    silA = Math.floor((sil.start + 0.5) * fs / F); silB = Math.floor((sil.end - 0.25) * fs / F);
    const sv = all.slice(silA, silB);
    if (sv.length > 10) { noise = powMean(sv.filter(v => v <= pct(sv, .9))); noiseContaminated = pct(sv, .9) > noise + 12; }
  }
  const top = pct(all, .95);
  const thrAct = Math.max(noise + 10, top - 35, -80);
  const active = [];
  for (let f = 0; f < nF; f++) if (fr.ph[f] !== 0 && fr.db[f] > thrAct) active.push(f);
  /* Level of a stretch of frames: frames above the activity gate when there are enough,
     otherwise the loudest 30%, so quiet speech below the gate is still measured */
  const levelOf = frames => {
    if (!frames.length) return { speech: -Infinity, peak: -Infinity, activeFrac: 0 };
    const act = frames.filter(f => fr.db[f] > thrAct);
    const cut = pct(frames.map(f => fr.db[f]), .7), use = act.length >= frames.length * 0.15 ? act : frames.filter(f => fr.db[f] >= cut);
    return { speech: powMean(use.map(f => fr.db[f])), peak: pct(use.map(f => fr.pk[f]), .95), activeFrac: act.length / frames.length };
  };
  /* The call level comes from normal speech only. Projected and quiet segments are checked on their own. */
  const ni = phaseIdx('normal'), normalMark = marks && marks.find(m => m.id === 'normal');
  const callFrames = []; for (let f = 0; f < nF; f++) if (normalMark ? fr.ph[f] === ni : fr.ph[f] !== 0) callFrames.push(f);
  const call = levelOf(callFrames), speech = call.speech, typPeak = call.peak;
  const L = loudness(x, fs);
  /* per-phase */
  const phases = [];
  if (marks && marks.length) for (const m of marks) {
    if (m.id === 'silence') continue;
    const a = Math.floor(m.start * fs), b = Math.min(N, Math.floor(m.end * fs));
    const fa = Math.floor(a / F), fb = Math.floor(b / F);
    const frames = []; for (let f = fa; f < fb; f++) frames.push(f);
    phases.push({ id: m.id, label: (PHASES[phaseIdx(m.id)] || {}).label || m.id, lufs: integratedRange(L.cs, fs, a, b), ...levelOf(frames) });
  }
  /* plosives: low-frequency bursts well above the voice's usual low end */
  const lowMed = pct(active.map(f => fr.low[f]), .5);
  const plosives = []; let lastP = -99;
  for (let f = 0; f < nF; f++) {
    if (fr.ph[f] === 0) continue;
    if (fr.low[f] > lowMed + 12 && fr.low[f] > fr.db[f] - 3 && fr.low[f] > noise + 20) {
      if (f - lastP > 8) plosives.push({ t: f * F / fs, excess: fr.low[f] - lowMed, lvl: fr.low[f] }); else { const e = plosives[plosives.length - 1]; e.excess = Math.max(e.excess, fr.low[f] - lowMed); }
      lastP = f;
    }
  }
  /* sibilance: 5-10 kHz energy compared with the average speech level */
  const qi = phaseIdx('quiet');
  const sibAct = active.filter(f => fr.ph[f] !== qi);
  const sibPeak = pct(sibAct.map(f => fr.sib[f]), .98) - speech;
  const sibEvents = []; let lastS = -99;
  for (const f of sibAct) if (fr.sib[f] > speech + 1 && fr.sib[f] - fr.db[f] > -3) { if (f - lastS > 5) sibEvents.push({ t: f * F / fs, lvl: fr.sib[f] - speech }); lastS = f; }
  /* spectra */
  const hop = 2048, n1 = 4096, starts = [];
  for (let s = 0; s + n1 <= N; s += hop) { const f = Math.floor((s + n1 / 2) / F); if (fr.ph[f] !== 0 && fr.ph[f] !== qi && fr.db[f] > thrAct) starts.push(s); }
  const ltas = smoothSpec(avgSpectrum(x, starts, n1, fs), fs);
  const n2 = 16384, nStarts = [];
  for (let s = 0; s + n2 <= N; s += n2 / 2) {
    const fa = Math.floor(s / F), fb = Math.floor((s + n2) / F);
    let ok = true; for (let f = fa; f < fb && ok; f++) { if (sil) ok = f >= silA && f < silB; else ok = fr.db[f] <= noise + 4; }
    if (ok) nStarts.push(s);
  }
  const nSpRaw = avgSpectrum(x, nStarts, n2, fs), noiseSpec = smoothSpec(nSpRaw, fs);
  /* Loudness range of normal speech only: the guided script varies effort on purpose */
  const lra = normalMark ? loudness(x.subarray(Math.floor(normalMark.start * fs), Math.min(N, Math.floor(normalMark.end * fs))), fs).lra : L.lra;
  const nb = noiseSpec && bandLevels(noiseSpec);
  const phaseMax = id => { const m = marks && marks.find(q => q.id === id); if (!m) return NaN; let v = 0; for (let i = Math.floor(m.start * fs), e = Math.min(N, Math.floor(m.end * fs)); i < e; i++) v = Math.max(v, Math.abs(x[i])); return dbA(v); };
  return {
    dur: N / fs, fs, peak: dbA(mx), clips, dc: sum / N, noise, noiseContaminated, speech, typPeak,
    snr: speech - noise, crest: dbA(mx) - speech, integrated: L.integrated, lra, lraScope: normalMark ? 'normal voice' : 'whole take',
    callLufs: normalMark ? (phases.find(p => p.id === 'normal') || {}).lufs : L.integrated, loudPeak: phaseMax('loud'),
    rumbleShape: nb ? nb.abs.Rumble - nb.abs.Mid : NaN,
    activeFrac: active.length / nF, phases, plosives, sibPeak, sibEvents, ltas, noiseSpec, hum: detectHum(nSpRaw, fs),
    bands: bandLevels(ltas), frames: { F, db: fr.db }, thrAct,
  };
}

/* ---------- processing chain: a preview of the OBS filters with the same controls.
   Written from the filters' documented behaviour, so levels match closely but not sample for sample. ---------- */
/* Noise gate: a 10 ms peak envelope opens it above `open` and, after `hold` ms under `close`, it shuts.
   The gain ramps linearly over `attack` and `release` ms. */
function gate(x, fs, s) {
  const out = new Float32Array(x.length), open = Math.pow(10, s.open / 20), close = Math.pow(10, s.close / 20);
  const up = 1000 / (s.attack * fs), down = 1000 / (s.release * fs), holdN = s.hold / 1000 * fs, k = Math.exp(-1 / (0.01 * fs));
  let env = 0, g = 0, on = false, under = 0;
  for (let i = 0; i < x.length; i++) {
    env = Math.max(Math.abs(x[i]), env * k);
    if (env >= open) { on = true; under = 0; } else if (on && env < close && ++under > holdN) on = false;
    g = on ? Math.min(1, g + up) : Math.max(0, g - down);
    out[i] = x[i] * g;
  }
  return out;
}
/* 3-band EQ: `mid` dB overall, with shelves that move the band under 800 Hz to `low` dB and the band over 5 kHz to `high` dB */
function eq3(x, fs, s) {
  const y = filt(x, [new BQ(rbj('ls', fs, 800, Math.SQRT1_2, s.low - s.mid)), new BQ(rbj('hs', fs, 5000, Math.SQRT1_2, s.high - s.mid))]), m = Math.pow(10, s.mid / 20);
  for (let i = 0; i < y.length; i++) y[i] *= m;
  return y;
}
/* Compressor and limiter: peak envelope with attack and release, hard knee, no lookahead.
   The limiter is the same with an infinite ratio and a near-instant attack. */
function dynamics(x, fs, thr, slope, attMs, relMs) {
  const out = new Float32Array(x.length), aA = Math.exp(-1 / (fs * attMs / 1000)), aR = Math.exp(-1 / (fs * relMs / 1000));
  let env = 0, grSum = 0, grN = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = env < a ? a + aA * (env - a) : a + aR * (env - a);
    const gdb = Math.min(0, slope * (thr - dbA(env)));
    out[i] = x[i] * Math.pow(10, gdb / 20);
    if (gdb < -0.1) { grSum += gdb; grN++; }
  }
  return { out, avgGR: grN ? grSum / grN : 0 };
}
const compress = (x, fs, s) => dynamics(x, fs, s.threshold, 1 - 1 / s.ratio, s.attack, s.release);
const limit = (x, fs, s) => dynamics(x, fs, s.threshold, 1, 0.001, s.release).out;
/* Chain in OBS order: Noise Gate, 3-Band EQ, Compressor, Gain, Limiter.
   Gain is solved so the output lands on the target loudness. */
function processChain(x, fs, ch) {
  let y = ch.gateOn ? gate(x, fs, { open: ch.gateOpen, close: ch.gateOpen - 6, attack: 25, hold: 200, release: 150 }) : x;
  if (ch.eqLow || ch.eqMid || ch.eqHigh) y = eq3(y, fs, { low: ch.eqLow, mid: ch.eqMid, high: ch.eqHigh });
  let comp = { avgGR: 0 };
  if (ch.compOn) { comp = compress(y, fs, { threshold: ch.thr, ratio: ch.ratio, attack: ch.att, release: ch.rel }); y = comp.out; }
  const pre = loudness(y, fs).integrated;
  /* The limiter shaves loudness off peaky takes, so correct the gain a few times.
     Stop when more gain no longer adds loudness: the take is limited by its peaks. */
  let gain = Number.isFinite(pre) ? ch.target - pre : 0, best = null;
  const render = g => { const m = Math.pow(10, g / 20), z = new Float32Array(y.length); for (let i = 0; i < y.length; i++) z[i] = y[i] * m; const o = limit(z, fs, { threshold: ch.ceil, release: 60 }); return { g, o, l: loudness(o, fs).integrated }; };
  for (let pass = 0; pass < 4; pass++) {
    const r = render(gain);
    if (!Number.isFinite(r.l)) { best = r; break; }
    if (best && r.l - best.l < 0.3 && r.g > best.g) break;
    if (!best || Math.abs(r.l - ch.target) < Math.abs(best.l - ch.target)) best = r;
    if (Math.abs(r.l - ch.target) < 0.15) break;
    gain += clamp(ch.target - r.l, -6, 6);
  }
  const out = best.o; gain = Math.round(best.g * 10) / 10;
  const peakLimited = Number.isFinite(best.l) && ch.target - best.l > 1;
  return { data: out, makeup: gain, avgGR: comp.avgGR, peakLimited };
}

export { dbA, dbP, clamp, pct, powMean, rbj, BQ, kChain, filt, integratedRange, loudness, fft, avgSpectrum, smoothSpec, REF_LTASS, refCurve, BANDS, bandLevels, detectHum, PHASES, analyze, gate, eq3, compress, limit, processChain };
