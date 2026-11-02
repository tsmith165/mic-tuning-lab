/* Runs: one recording session and its takes. The page (in the browser) and the CLI (a folder of JSON and WAV
   files) save them in one format, "mic-lab/run@1". Each take carries its report@1 summary for people and agents,
   plus the measurement the page needs to score it again for another use and to draw it without its audio. */
import { dbA, dbP } from './dsp.js';
import { fitScore, verdict, profileOf, fmt, fmtS } from './advice.js';
import { takeSummary } from './report.js';

const RUN_SCHEMA = 'mic-lab/run@1';
const KINDS = { check: 'Quick check', sweep: 'Best settings', free: 'Free talk', file: 'File' };
const kindOf = mode => ({ guided: 'check', sweep: 'sweep', free: 'free' })[mode] || 'file';

/* Ids sort by time and are safe as file names: 20261102-114208-k3x9 (UTC) */
const pad = n => String(n).padStart(2, '0');
function newRunId(t = Date.now(), rand = Math.random) {
  const d = new Date(t), A = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-`
    + Array.from({ length: 4 }, () => A[Math.floor(rand() * 36)]).join('');
}
const isRunId = id => typeof id === 'string' && /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);
const audioName = (id, i) => `${id}-${i + 1}.wav`;
const isAudioName = (name, id) => typeof name === 'string' && /^\d{8}-\d{6}-[a-z0-9]{4}-\d{1,3}\.wav$/.test(name) && (!id || name.startsWith(id + '-'));

/* Level per 40 ms, enough to draw a take before its audio loads */
function envelope(x, fs, fps = 25) {
  const F = Math.max(1, Math.round(fs / fps)), n = Math.ceil(x.length / F), rms = [], peak = [], r1 = v => Math.round(Math.max(-120, v) * 10) / 10;
  for (let f = 0; f < n; f++) {
    let s = 0, m = 0; const a = f * F, b = Math.min(x.length, a + F);
    for (let i = a; i < b; i++) { const v = x[i]; s += v * v; if (v > m) m = v; else if (-v > m) m = -v; }
    rms.push(r1(dbP(s / (b - a)))); peak.push(r1(dbA(m)));
  }
  return { fps, rms, peak };
}

/* JSON has no NaN or Infinity, and the advice treats a missing value differently from zero, so they travel as strings */
const NONFINITE = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };
const enc = v => typeof v === 'number' ? (Number.isFinite(v) ? v : String(v)) : Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v, enc)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
const dec = v => typeof v === 'string' && Object.hasOwn(NONFINITE, v) ? NONFINITE[v] : Array.isArray(v) ? v.map(dec)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)])) : v;
const measureOf = a => { const { frames, ...rest } = a; return enc(rest); };

/* run: { id, n, created, kind, use, best, takes: [{ name, created, fs, marks, meta, a, env, audio, sha256 }] }
   ctx: as for takeSummary, with the mic as it is now */
function packRun(run, ctx = {}) {
  const use = profileOf(run.use).id, best = run.takes[run.best] ? run.best : 0, sum = run.takes.map(t => takeSummary(t, { ...ctx, profile: use })), b = sum[best];
  return {
    schema: RUN_SCHEMA, id: run.id, n: run.n, createdAt: new Date(run.created).toISOString(), kind: run.kind, use,
    score: b.score, verdict: b.verdict, distanceIn: b.recording.distanceIn, input: b.recording.inputDevice, mic: b.mic, best,
    takes: run.takes.map((t, i) => ({
      ...sum[i], audio: t.audio || audioName(run.id, i), sha256: t.sha256 || null,
      measure: { fs: t.fs, marks: t.marks || null, meta: t.meta || {}, analysis: measureOf(t.a), envelope: t.env || null },
    })),
  };
}

function checkRun(rec) {
  const bad = m => { throw new Error(`Not a ${RUN_SCHEMA} record: ${m}`); };
  if (!rec || typeof rec !== 'object') bad('not an object');
  if (rec.schema !== RUN_SCHEMA) bad(`schema is ${rec.schema}`);
  if (!isRunId(rec.id)) bad(`bad id ${rec.id}`);
  if (!Number.isInteger(rec.n) || rec.n < 1) bad('bad run number');
  if (!KINDS[rec.kind]) bad(`bad kind ${rec.kind}`);
  if (!Array.isArray(rec.takes) || !rec.takes.length) bad('no takes');
  for (const t of rec.takes) {
    if (!t || !t.measure || !t.measure.analysis || !(t.measure.fs > 0)) bad('a take has no measurement');
    if (t.audio != null && !isAudioName(t.audio, rec.id)) bad(`bad audio name ${t.audio}`);
  }
  return rec;
}

function unpackRun(rec) {
  checkRun(rec);
  const takes = rec.takes.map(t => ({
    name: t.take, created: Date.parse(t.createdAt) || null, fs: t.measure.fs, marks: t.measure.marks, meta: t.measure.meta || {},
    a: dec(t.measure.analysis), env: t.measure.envelope, audio: t.audio, sha256: t.sha256 || null,
  }));
  return { id: rec.id, n: rec.n, created: Date.parse(rec.createdAt), kind: rec.kind, use: rec.use, best: takes[rec.best] ? rec.best : 0, takes };
}

const bestTake = run => run.takes[run.best] || run.takes[0];
const runScore = (run, profile) => fitScore(bestTake(run).a, profile ?? run.use);
const micKey = take => (take.meta && (take.meta.adapter || take.meta.device)) || '';
/* The latest earlier run on the same mic, which "what changed" compares against */
function previousRun(runs, run) {
  let p = null; const k = micKey(bestTake(run));
  for (const r of runs) if (r.created < run.created && micKey(bestTake(r)) === k && (!p || r.created > p.created)) p = r;
  return p;
}

/* ---------- what changed between setups ---------- */
const COMP = ['Off', 'Light', 'Medium', 'Heavy'];
const onOff = v => v ? 'On' : 'Off', cap = s => s ? s[0].toUpperCase() + s.slice(1) : '?';
const SETTINGS = [
  ['mode', 'Mode', v => v === 'auto' ? 'Auto Level' : 'Manual'], ['position', 'Position', cap], ['tone', 'Tone', cap],
  ['gain', 'Gain', v => `${fmt(v, Number.isInteger(v) ? 0 : 1)} dB`], ['comp', 'Compressor', v => COMP[v] ?? String(v)],
  ['hp', 'High-pass', onOff], ['hpf', 'High-pass', v => v ? `${v} Hz` : 'Off'], ['pres', 'Presence boost', onOff], ['toneLevel', 'Tone', v => fmtS(v, 0)],
  ['denoise', 'Denoiser', onOff], ['popper', 'Popper stopper', onOff], ['limiter', 'Limiter', onOff], ['muted', 'Mute', onOff],
];
/* A setting counts only in the mode that uses it: Auto Level picks its own gain, and the MV7's Auto Level has no EQ */
const shown = (k, s) => s[k] != null && !(s.mode === 'auto' && (k === 'gain' || k === 'comp' || k === 'pres' || (k === 'hp' && 'position' in s))) && !(s.mode === 'manual' && (k === 'position' || k === 'tone'));
function setupOf(take) {
  const m = take.meta || {};
  return { mic: micKey(take) || null, device: m.device || null, hw: m.hw || null, distance: m.distance ?? null, proc: !!(m.proc && (m.proc.ec || m.proc.ns || m.proc.agc)) };
}
/* For two or more takes: the settings that differ (one value per take, null where a setting does not apply) and the ones they share */
function diffSetups(takes) {
  const S = takes.map(setupOf), changed = [], same = [], row = (key, label, values) => (values.every(v => v === values[0]) ? same : changed).push({ key, label, values });
  const oneMic = S.every(s => s.mic === S[0].mic);
  if (!oneMic) row('mic', 'Mic', S.map(s => s.device || 'Unknown input'));
  else if (S.every(s => s.hw)) {
    const modeChanged = new Set(S.map(s => s.hw.mode)).size > 1;
    for (const [k, label, f] of SETTINGS) {
      const values = S.map(s => shown(k, s.hw) ? f(s.hw[k]) : null);
      if (values.every(v => v == null) || (modeChanged && values.at(-1) == null)) continue;
      row(k, label, values);
    }
  }
  row('distance', 'Distance', S.map(s => s.distance != null ? `${s.distance} in` : '?'));
  row('proc', 'Browser processing', S.map(s => onOff(s.proc)));
  return { changed, same };
}
const SHORT = { pres: 'Presence', hp: 'High-pass' };
const num = v => v == null ? '?' : v.replace(/ (dB|in|Hz)$/, '');
/* One line for the run list: "Gain 27 → 36 · 4 → 3 in" */
function changeLine(changed, lastHw) {
  const mode = changed.find(c => c.key === 'mode'), out = [];
  for (const { key, label, values: [a, b] } of changed) {
    if (mode && key !== 'mode' && ['position', 'tone', 'gain'].includes(key)) continue;
    if (key === 'mode') out.push(b === 'Auto Level' ? 'Auto Level' + (lastHw && lastHw.position ? ' ' + cap(lastHw.position) : '') + (lastHw && lastHw.tone ? ' · ' + cap(lastHw.tone) : '')
      : 'Manual' + (lastHw && lastHw.gain != null ? ` ${fmt(lastHw.gain, Number.isInteger(lastHw.gain) ? 0 : 1)} dB` : ''));
    else if (b === 'On' || b === 'Off') out.push(`${SHORT[key] || label} ${b.toLowerCase()}`);
    else if (key === 'distance') out.push(`${num(a)} → ${b}`);
    else if (key === 'gain') out.push(`Gain ${num(a)} → ${num(b)}`);
    else out.push(`${SHORT[key] || label} ${a ?? '—'} → ${b ?? '—'}`);
  }
  return out.join(' · ');
}
/* What the run list says under each run */
function runLine(runs, run) {
  if (run.kind === 'sweep') return `${run.takes.length} settings tried`;
  const t = bestTake(run), p = previousRun(runs, run);
  if (!p) return t.meta.hw ? 'First run on this mic' : t.meta.device || 'No mic control';
  const line = changeLine(diffSetups([bestTake(p), t]).changed, t.meta.hw);
  return line || (t.meta.hw ? 'Same settings' : t.meta.device || 'No mic control');
}

/* ---------- comparing runs ---------- */
const METRICS = [
  ['peaks', 'Speech peaks', 'dBFS', a => a.typPeak, P => P.peak],
  ['speech', 'Speech level', 'dBFS', a => a.speech, P => P.speech],
  ['snr', 'Voice over noise', 'dB', a => a.snr, P => [P.snr, Infinity]],
  ['noise', 'Noise floor', 'dBFS', a => a.noise, P => [-Infinity, P.noise]],
  ['presence', 'Presence', 'dB', a => a.bands ? a.bands.rel.Presence : NaN, () => [-22, Infinity]],
  ['body', 'Body', 'dB', a => a.bands ? a.bands.rel.Body : NaN, () => [-Infinity, 16]],
  ['loudness', 'Loudness', 'LUFS', a => a.callLufs, () => null],
  ['maxPeak', 'Max peak', 'dBFS', a => a.peak, () => [-Infinity, -3]],
  ['plosives', 'Plosives', '', a => a.plosives.length, () => [0, 0]],
  ['sibilance', 'Sibilance', 'dB', a => a.sibPeak, () => [-Infinity, 3]],
];
const offBy = (v, t) => !t || !Number.isFinite(v) ? NaN : v < t[0] ? t[0] - v : v > t[1] ? v - t[1] : 0;
const r1 = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
/* Runs side by side for one use: scores, what changed in the setup, and each metric with which way it moved */
function compareRuns(runs, profile) {
  const P = profileOf(profile ?? runs[0].use), takes = runs.map(bestTake), { changed, same } = diffSetups(takes);
  return {
    use: P.id,
    runs: runs.map(r => ({ id: r.id, n: r.n, kind: r.kind, createdAt: new Date(r.created).toISOString(), score: runScore(r, P.id), verdict: verdict(bestTake(r), { profile: P.id }).title })),
    changed, same,
    metrics: METRICS.map(([id, label, unit, get, tgt]) => {
      const target = tgt(P), values = takes.map(t => get(t.a)), d0 = offBy(values[0], target), d1 = offBy(values.at(-1), target);
      return { id, label, unit, target: target && target.map(v => Number.isFinite(v) ? v : null), values: values.map(r1), change: r1(values.at(-1) - values[0]), closer: Number.isFinite(d0) && Number.isFinite(d1) && Math.abs(d1 - d0) > 0.3 ? d1 < d0 : null };
    }),
  };
}

export {
  RUN_SCHEMA, KINDS, kindOf, newRunId, isRunId, audioName, isAudioName, envelope, enc, dec, packRun, checkRun, unpackRun,
  bestTake, runScore, previousRun, diffSetups, changeLine, runLine, METRICS, compareRuns,
};
