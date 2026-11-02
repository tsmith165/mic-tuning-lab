/* The page: Tune (input, mic settings, recording and the latest result) and Runs (every run, one at a time or two
   or three side by side). Runs are saved in the browser, and in the runs folder too when mic-lab serve runs the page. */
import { analyze, processChain, PHASES, kChain, filt, dbA, dbP, pct } from '../core/dsp.js';
import { PROFILES, profileOf, CHAIN_PRESETS, fmt, fmtS, verdict, fitScore, sweepPlan, sweepNote, suggestChain } from '../core/advice.js';
import { report, reportMarkdown } from '../core/report.js';
import { encodeWav, decodeWav, quantize16 } from '../core/wav.js';
import { obsFilters, obsRecipe, ObsClient } from '../core/obs.js';
import { kindOf, newRunId, audioName, isAudioName, envelope, packRun, unpackRun, checkRun, bestTake, runScore, previousRun, diffSetups, changeLine, runLine } from '../core/runs.js';
import { ADAPTERS, adapterFor, adapterById } from '../adapters/index.js';
import { webhidTransport, findDevice, usable } from '../adapters/webhid.js';
import { store as db } from './store.js';
import { tar, untar } from './tar.js';
import { M, wave, playhead, liveSpec, meter, icon, icons } from './charts.js';
import { esc, mmss, runHtml, drawRun, runListHtml, drawTrend, compareHtml, drawCompare, seriesOf } from './views.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prefs = { get: k => { try { return JSON.parse(localStorage.getItem('mic-lab.' + k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('mic-lab.' + k, JSON.stringify(v)); } catch { } } };
const DISTANCES = [1, 2, 3, 4, 6, 8, 10, 12, 18, 24];
const S = {
  ctx: null, stream: null, src: null, an: null, worklet: null, kc: null, fs: 48000, track: null, starting: false, useWorklet: false,
  live: { peak: -120, hold: -120, holdT: 0, rms: [], kms: [], hist: [], vp: [], noise: NaN, zeroMs: 0, lastNum: 0, sp: null, spT: 0 },
  rec: null, sweep: null, runs: [], cur: null, open: null, cmp: [], ab: 0, tab: 'spectrum', view: 'tune',
  profile: profileOf(prefs.get('profile')).id, dist: DISTANCES.includes(prefs.get('distance')) ? prefs.get('distance') : 4, proc: false,
  mic: null, chain: null, tuned: null, play: null, abp: null, applied: new Map(), obs: new ObsClient(), audio: new Map(), menu: false, showLog: false, log: [],
};
S.chain = { ...CHAIN_PRESETS[S.profile] };
const toast = (m, ms = 3200) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); };

/* ---------------- hardware context ---------------- */
const inputLabel = () => (S.track && S.track.label) || ($('#dev').selectedOptions[0] || {}).textContent || '';
/* Mic control counts for runs and fixes only while the input being measured is that mic */
const ctl = () => S.mic && S.mic.adapter.labelMatch.test(inputLabel()) ? S.mic : null;
const nowState = () => ctl() && ctl().device.state;
const describeHw = (hw, adapterId) => { const a = adapterById(adapterId) || (S.mic && S.mic.adapter); return hw ? (a ? a.describe(hw) : 'Settings unknown') : 'No mic control'; };
const hwKey = hw => hw ? describeHw(hw) + (hw.muted ? ' · muted' : '') : '';
const adviceCtx = () => { const m = ctl(); return { profile: S.profile, adapter: m && m.adapter, caps: m && m.adapter.caps, now: m && m.device.state, describe: m ? m.adapter.describe : h => describeHw(h), describeHw }; };
/* Hardware writes wait while a sweep owns the mic */
const freeMic = () => { if (S.sweep) { toast('Wait for the sweep to finish, or press Stop.'); return null; } return S.mic; };
const streamLive = () => !!(S.stream && S.stream.getAudioTracks().some(t => t.readyState === 'live'));
const settable = (adapter, hw) => { const keys = adapter.caps.settable; return Object.fromEntries(Object.entries(hw).filter(([k]) => keys.includes(k) && !(k === 'gain' && hw.mode === 'auto'))); };
const micName = t => (t.meta.adapter && (adapterById(t.meta.adapter) || {}).name) || t.meta.device || 'Unknown input';

/* ---------------- audio engine ---------------- */
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0}
process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===1024){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(1024);this.n=0}}}return true}}
registerProcessor('cap',Cap);`;
async function ensureCtx() {
  if (S.ctx) { if (S.ctx.state !== 'running') await S.ctx.resume(); return S.ctx; }
  S.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); S.fs = S.ctx.sampleRate;
  try { await S.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))); S.useWorklet = true; } catch { S.useWorklet = false; }
  return S.ctx;
}
async function listDevices() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'), sel = $('#dev'), cur = sel.value;
  sel.innerHTML = devs.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone')}</option>`).join('') || '<option value="">Default input</option>';
  /* the device itself, not Chrome's Default or Communications alias for it */
  const known = devs.find(d => !/^(default|communications)$/.test(d.deviceId) && ADAPTERS.some(a => a.labelMatch && a.labelMatch.test(d.label)));
  if (cur && devs.some(d => d.deviceId === cur)) sel.value = cur; else if (known) sel.value = known.deviceId;
  renderRail();
}
async function startMic(again) {
  await ensureCtx();
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  const p = S.proc, id = $('#dev').value;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: p, noiseSuppression: p, autoGainControl: p, channelCount: 1, sampleRate: 48000 } });
  } catch (e) {
    S.stream = null; S.track = null; renderRail();
    toast(`The browser could not open the microphone: ${e.message}. Allow it in the address bar, then try again.`, 6000); throw e;
  }
  const firstRun = !$('#dev').value || $('#dev').options.length < 2;
  await listDevices();
  const tr = S.stream.getAudioTracks()[0];
  /* Before permission the list has no names, so the first start may open the default input instead of the mic picked once names appear */
  if (!again && firstRun && $('#dev').value && tr.getSettings().deviceId !== $('#dev').value) return startMic(true);
  S.track = { ...tr.getSettings(), label: tr.label };
  if (S.src) S.src.disconnect();
  S.src = S.ctx.createMediaStreamSource(S.stream);
  if (!S.an) { const node = S.ctx.createAnalyser(); node.fftSize = 8192; node.smoothingTimeConstant = 0.6; S.an = { node, freq: new Float32Array(node.frequencyBinCount), fs: S.fs }; }
  if (!S.worklet) {
    if (S.useWorklet) { S.worklet = new AudioWorkletNode(S.ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }); S.worklet.port.onmessage = e => onChunk(e.data); }
    else { S.worklet = S.ctx.createScriptProcessor(1024, 1, 1); S.worklet.onaudioprocess = e => onChunk(Float32Array.from(e.inputBuffer.getChannelData(0))); }
    const z = S.ctx.createGain(); z.gain.value = 0; S.worklet.connect(z).connect(S.ctx.destination);
  }
  S.src.connect(S.an.node); S.src.connect(S.worklet);
  S.kc = kChain(S.fs); Object.assign(S.live, { rms: [], kms: [], hist: [], vp: [], zeroMs: 0, sp: null });
  renderAll();
}
function onChunk(buf) {
  const r = S.rec, L = S.live, now = performance.now();
  let pk = 0, s = 0;
  const env = r && r.active && !r.sweep ? r : null;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i], a = v < 0 ? -v : v; s += v * v; if (a > pk) pk = a;
    if (env) { env.es += v * v; if (a > env.em) env.em = a; if (++env.ek === env.F) { env.env.rms.push(Math.max(-120, dbP(env.es / env.F))); env.env.peak.push(Math.max(-120, dbA(env.em))); env.es = env.em = env.ek = 0; } }
  }
  if (r && r.active) {
    r.chunks.push(buf); r.n += buf.length;
    if (r.limit) { if (r.n >= r.limit) { S.rec = null; r.done(joinChunks(r.chunks, r.limit)); } }
    else if (r.guided && r.n >= r.total) stopRec();
    else if (!r.guided && r.n >= S.fs * FREE_MAX) stopRec();
  }
  const pdb = dbA(pk), rdb = dbP(s / buf.length);
  L.zeroMs = pk === 0 ? L.zeroMs + 1000 * buf.length / S.fs : 0;
  const k = filt(buf, S.kc); let ks = 0; for (let i = 0; i < k.length; i++) ks += k[i] * k[i];
  L.peak = Math.max(pdb, L.peak - 1.2);
  if (pdb >= L.hold || now - L.holdT > 2500) { L.hold = pdb; L.holdT = now; }
  L.rms.push(s / buf.length); L.kms.push(ks / buf.length); L.hist.push(rdb); L.vp.push({ t: now, pk: pdb, rms: rdb });
  if (L.rms.length > 141) L.rms.shift(); if (L.kms.length > 141) L.kms.shift(); if (L.hist.length > 470) L.hist.shift();
  while (L.vp.length && now - L.vp[0].t > 4000) L.vp.shift();
}
/* The rail's big number: speech peaks over the last 4 s, measured like a run (95th percentile of peaks while talking) */
function updateLiveNumbers() {
  const L = S.live, now = performance.now(), P = PROFILES[S.profile];
  if (now - L.lastNum < 150) return; L.lastNum = now;
  const live = streamLive();
  if (live && L.hist.length > 60) L.noise = pct(L.hist, .08);
  const thr = Math.max((Number.isFinite(L.noise) ? L.noise : -90) + 10, -70), voice = live ? L.vp.filter(x => x.rms > thr) : [];
  if (voice.length >= 15) { L.sp = pct(voice.map(x => x.pk), .95); L.spT = now; }
  const n = $('#lvNum'), st = $('#lvSt'), v = live ? L.sp : null;
  n.textContent = v == null ? '—' : M(fmt(v)); n.classList.toggle('stale', v != null && now - L.spT > 3000);
  if (S.rec || S.sweep) { st.textContent = 'Live'; st.className = 'st'; }
  else if (v == null) { st.textContent = live ? 'Say something' : ''; st.className = 'st'; }
  else { const off = v < P.peak[0] ? P.peak[0] - v : v > P.peak[1] ? v - P.peak[1] : 0; st.textContent = off ? `${M(fmt(off))} dB ${v < P.peak[0] ? 'low' : 'high'}` : 'On target'; st.className = 'st ' + (off ? 'bad' : 'good'); }
  /* exact zeros mean nothing feeds the device, e.g. a virtual mic whose app is closed */
  const silent = live && L.zeroMs > 1500, muted = !!(nowState() && nowState().muted), w = $('#liveWarn');
  w.hidden = !silent && !muted;
  w.textContent = muted ? 'The mic is muted. Turn Mute off under Mic settings.' : silent ? `${inputLabel() || 'This input'} sends digital silence. A virtual mic stays silent while its app is closed. Pick your real mic above.` : '';
}

/* ---------------- runs ---------------- */
const runById = id => S.runs.find(r => r.id === id);
const allTakes = () => S.runs.flatMap(r => r.takes);
const nextN = () => S.runs.reduce((m, r) => Math.max(m, r.n), 0) + 1;
const scoreOf = r => runScore(r, S.profile);
const takeScore = t => fitScore(t.a, S.profile);
const prevOf = r => previousRun(S.runs, r);
async function sha256(bytes) { try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); } catch { return null; } }
const wavInfo = (run, t) => ({ name: t.name, created: t.created, marks: t.marks, meta: { ...t.meta, use: run.use } });
/* Saves a run with its audio: 16-bit WAVs of the samples it was measured on, or the bytes of an imported file */
async function saveRun(run) {
  const audio = [];
  for (const [i, t] of run.takes.entries()) {
    t.audio = audioName(run.id, i);
    const bytes = t.bytes || encodeWav(t.data, t.fs, wavInfo(run, t), { bits: 16 });
    t.sha256 = await sha256(bytes); audio.push({ name: t.audio, bytes });
  }
  run.rec = packRun(run, adviceCtx());
  S.runs.push(run); S.runs.sort((a, b) => a.created - b.created);
  try { await db.put(run.rec, audio); run.takes.forEach(t => { S.audio.set(t.audio, t.data || decodeWav(t.bytes).data); delete t.data; delete t.bytes; }); }
  catch (e) { run.unsaved = true; toast(`Run ${run.n} was not saved (${e.message}). Save its WAV to keep it.`, 7000); }
  trimAudioCache();
  return run;
}
const trimAudioCache = () => { while (S.audio.size > 8) S.audio.delete(S.audio.keys().next().value); };
async function loadAudio(t) {
  if (t.data) return t.data;
  if (S.audio.has(t.audio)) return S.audio.get(t.audio);
  const bytes = t.audio && await db.audio(t.audio).catch(() => null);
  if (!bytes) throw new Error('This run has no audio in this browser.');
  const x = decodeWav(bytes).data; S.audio.set(t.audio, x); trimAudioCache();
  return x;
}
async function reloadRuns() {
  const keep = new Map(S.runs.filter(r => r.unsaved).map(r => [r.id, r]));
  S.runs = [];
  for (const rec of await db.all()) { try { const r = unpackRun(rec); r.rec = rec; S.runs.push(r); } catch (e) { console.warn('Skipped a stored run:', e.message); } }
  S.runs.push(...keep.values()); S.runs.sort((a, b) => a.created - b.created);
  if (!runById(S.cur)) S.cur = S.runs.length ? S.runs.at(-1).id : null;
}
function makeTake(x, marks, meta, created = Date.now()) {
  const st = S.track || {}, m = ctl();
  return {
    name: '', created, fs: S.fs, marks, data: x, a: analyze(x, S.fs, marks), env: envelope(x, S.fs),
    meta: { distance: S.dist, note: '', device: st.label || inputLabel(), proc: { ec: !!st.echoCancellation, ns: !!st.noiseSuppression, agc: !!st.autoGainControl }, adapter: m ? m.adapter.id : null, ...meta },
  };
}

/* ---------------- recording ---------------- */
const TOTAL = PHASES.reduce((s, p) => s + p.dur, 0), FREE_MAX = 180;
const SWEEP_LINE = 'Quick update from me: the plan is simple, we ship it on Tuesday, and the price stays exactly the same.';
const SWEEP_QUIET = 1.5, SWEEP_TALK = 6.5;
const joinChunks = (chunks, n) => { const d = new Float32Array(n); let o = 0; for (const c of chunks) { if (o >= n) break; d.set(c.subarray(0, Math.min(c.length, n - o)), o); o += c.length; } return d; };
const plannedMarks = (dur = TOTAL) => { let a = 0; return PHASES.map(p => { const m = { id: p.id, start: a, end: Math.min(a + p.dur, dur) }; a += p.dur; return m; }).filter(m => m.end - m.start >= 1); };
function countdown(n, stopped) {
  const say = $('#rvSay'), show = () => { say.textContent = n; say.className = 'say count'; };
  show();
  return new Promise(res => { const iv = setInterval(() => { if (stopped()) { clearInterval(iv); return res(false); } if (--n > 0) show(); else { clearInterval(iv); res(true); } }, 800); });
}
async function startRec(kind) {
  if (S.starting || S.rec || S.sweep) return;
  S.starting = true;
  try { if (!streamLive()) await startMic(); stopAll(); if (ctl()) await ctl().device.read().catch(() => { }); }
  catch { return; } finally { S.starting = false; }
  const hw = nowState(), r = S.rec = { kind, active: false, chunks: [], n: 0, guided: kind === 'check', total: Math.round(TOTAL * S.fs), hw: hw ? { ...hw } : null, env: { fps: 25, rms: [], peak: [] }, es: 0, em: 0, ek: 0, F: Math.round(S.fs / 25), t0: Date.now(), pi: -1 };
  renderAll();
  if (await countdown(3, () => S.rec !== r) && S.rec === r) { r.active = true; r.t0 = Date.now(); }
}
async function stopRec() {
  const r = S.rec; if (!r) return; S.rec = null;
  if (!r.active || r.n < S.fs * 1.5) { renderAll(); if (r.active) toast('Too short to measure. Record at least a few seconds.'); return; }
  const x = quantize16(joinChunks(r.chunks, r.n)), dur = r.n / S.fs;
  const take = makeTake(x, r.guided ? plannedMarks(dur) : null, { mode: r.guided ? 'guided' : 'free', hw: r.hw, hwChanged: !!(r.hwChanged || (r.hw && nowState() && hwKey(r.hw) !== hwKey(nowState()))) }, r.t0);
  const run = { id: newRunId(r.t0), n: nextN(), created: r.t0, kind: r.kind, use: S.profile, best: 0, takes: [take] };
  take.name = `Run ${run.n}`;
  await saveRun(run);
  S.cur = run.id; S.tuned = null;
  renderAll();
}
function renderPrompter() {
  if (S.sweep) return renderSweepPrompter();
  const r = S.rec; if (!r) return;
  const set = (sel, v, html) => { const e = $(sel); if (html ? e.innerHTML !== v : e.textContent !== v) html ? e.innerHTML = v : e.textContent = v; };
  if (!r.active) { set('#rvPhase', r.guided ? 'Get ready · room tone first' : 'Get ready'); set('#rvNext', ''); set('#rvTime', ''); return; }
  const t = r.n / S.fs;
  if (!r.guided) {
    set('#rvPhase', 'Free talk'); set('#rvNext', 'Press Stop or Space when you are done.');
    if (r.pi !== 0) { r.pi = 0; $('#rvSay').textContent = 'Talk the way you will on calls or stream.'; $('#rvSay').className = 'say'; }
    set('#rvTime', `${mmss(t)} <span>/ ${mmss(FREE_MAX)}</span>`, true); return;
  }
  let acc = 0, i = 0; while (i < PHASES.length - 1 && t >= acc + PHASES[i].dur) { acc += PHASES[i].dur; i++; }
  const p = PHASES[i];
  if (r.pi !== i) { r.pi = i; set('#rvPhase', p.label); $('#rvSay').textContent = p.text; $('#rvSay').className = 'say' + (p.id === 'silence' ? ' quiet' : ''); set('#rvNext', PHASES[i + 1] ? `Next: ${PHASES[i + 1].label}` : 'Last one'); }
  set('#rvTime', `${mmss(t)} <span>/ ${mmss(TOTAL)}</span>`, true);
}

/* ---------------- settings sweep ---------------- */
const sweepCtx = m => ({ caps: m.adapter.caps, start: m.device.state || {}, distance: S.dist, profile: S.profile, takes: allTakes(), lastManual: m.device.lastManual });
/* One reading. Audio that stops arriving, such as an unplugged input, ends it instead of stalling the sweep. */
const capture = sec => new Promise(done => {
  const r = S.rec = { active: true, chunks: [], n: 0, limit: Math.round(sec * S.fs), done, sweep: true };
  setTimeout(() => { if (S.rec === r) { S.rec = null; done(null); } }, (sec + 3) * 1000);
});
function abortSweep() { const sw = S.sweep; if (!sw) return; sw.abort = true; const r = S.rec; if (r && r.sweep) { S.rec = null; r.done(null); } }
async function runSweep() {
  const m = ctl();
  if (!m) { toast(S.mic ? `Pick the ${S.mic.adapter.name} as the input. The sweep measures the mic it changes.` : 'Connect mic control first. The sweep changes mic settings between readings.', 5000); return; }
  if (S.starting || S.rec || S.sweep) return;
  let sw;
  S.starting = true;
  try {
    stopAll();
    const prevProc = S.proc;
    if (S.proc) { S.proc = false; toast('The sweep measures the raw mic, so browser processing is off until it ends.', 4000); }
    if (!streamLive() || prevProc) await startMic();
    await m.device.read();
    sw = S.sweep = { mic: m, prevProc, id: crypto.randomUUID(), plan: sweepPlan(sweepCtx(m)), i: 0, phase: 'ready', takes: [], cfg: [], scores: [], skipped: [], abort: false, start: { ...m.device.state }, t0: Date.now() };
  } catch (e) { toast(e.message, 5000); return; }
  finally { S.starting = false; }
  renderAll();
  if (!(await countdown(3, () => sw.abort))) return endSweep(sw);
  const dev = m.device, seen = new Map();
  try {
    await dev.batch(async () => {
      for (let i = 0; i < sw.plan.length && !sw.abort; i++) {
        sw.i = i; sw.phase = 'apply'; renderSteps();
        await dev.apply(sw.plan[i].target(sw.takes));
        const key = describeHw(dev.state); sw.cfg[i] = key;
        if (seen.has(key)) { sw.skipped[i] = seen.get(key) + 1; renderSteps(); continue; }
        seen.set(key, i);
        await sleep(500);
        if (sw.abort) break;
        sw.phase = 'rec'; renderSteps();
        const data = await capture(SWEEP_QUIET + SWEEP_TALK);
        if (!data || sw.abort) break;
        const t = makeTake(quantize16(data), [{ id: 'silence', start: 0, end: SWEEP_QUIET }, { id: 'normal', start: SWEEP_QUIET, end: SWEEP_QUIET + SWEEP_TALK }],
          { mode: 'sweep', sweepId: sw.id, step: sw.plan[i].label, note: sw.plan[i].label, hw: { ...dev.state }, adapter: m.adapter.id });
        sw.takes.push(t); sw.scores[i] = takeScore(t); renderSteps();
      }
    });
  } catch (e) { toast(e.message, 5000); sw.abort = true; }
  await endSweep(sw);
}
/* The sweep owns the mic until it ends: it keeps the best reading, or puts the starting settings back.
   Two or more readings are saved as a run either way. */
async function endSweep(sw) {
  S.sweep = null; S.rec = null;
  if (sw.prevProc && !S.proc) { S.proc = true; startMic().catch(() => { }); }
  const { device: dev, adapter } = sw.mic, back = () => dev.apply(settable(adapter, sw.start));
  const best = sw.takes.reduce((b, t, i) => takeScore(t) > takeScore(sw.takes[b]) ? i : b, 0);
  if (sw.takes.length >= 2) {
    const run = { id: newRunId(sw.t0), n: nextN(), created: sw.t0, kind: 'sweep', use: S.profile, best, takes: sw.takes };
    run.takes.forEach((t, i) => { t.name = `Run ${run.n} · ${i + 1}`; });
    await saveRun(run); S.cur = run.id; S.tuned = null;
  }
  if (S.mic !== sw.mic) {
    S.pendingRestore = { adapter: adapter.id, settings: sw.start };
    toast('The mic disconnected during the sweep. Connect it again, then press Restore under Mic settings.', 7000);
    renderAll(); return;
  }
  if (sw.abort || sw.takes.length < 2) {
    try { await back(); toast(sw.takes.length >= 2 ? 'Sweep stopped. Your settings are back, and the readings so far are saved.' : 'Sweep stopped. Your settings are back.'); }
    catch (e) { toast(`Could not restore your settings. ${e.message} Press Restore under Mic settings.`, 7000); }
    renderAll(); return;
  }
  const win = sw.takes[best];
  try { await dev.apply(settable(adapter, win.meta.hw)); toast(`Kept the best: ${win.meta.step}`); }
  catch (e) {
    try { await back(); toast(`Could not set the best settings, so your starting settings are back. ${e.message}`, 7000); }
    catch { toast(`Could not set the best settings or put yours back. ${e.message} Press Restore under Mic settings.`, 8000); }
  }
  renderAll();
}
function renderSteps() {
  const sw = S.sweep; if (!sw) return;
  const done = sw.scores.filter(Number.isFinite), top = done.length ? Math.max(...done) : null;
  $('#steps').innerHTML = `<tbody>${sw.plan.map((p, i) => {
    const s = sw.scores[i], cur = i === sw.i && sw.phase !== 'ready' && s == null && !sw.skipped[i], todo = i > sw.i || sw.phase === 'ready';
    return `<tr class="${cur ? 'cur' : todo ? 'todo' : ''}${s != null && s === top ? ' best' : ''}"><td class="i">${i + 1}</td><td>${esc(p.label)}${s != null && s === top ? '<span class="tag">Best so far</span>' : ''}</td>
      <td class="cfg">${sw.skipped[i] ? `Same as step ${sw.skipped[i]}` : esc(sw.cfg[i] || '')}</td><td class="bar"><span><i style="width:${s != null ? s : 0}%"></i></span></td>
      <td class="s">${s != null ? s : cur ? `<span class="rec">${sw.phase === 'rec' ? 'REC' : '…'}</span>` : '—'}</td></tr>`;
  }).join('')}</tbody>`;
}
function renderSweepPrompter() {
  const sw = S.sweep, set = (sel, v) => { const e = $(sel); if (e.textContent !== v) e.textContent = v; };
  if (sw.phase === 'ready') { set('#rvPhase', 'Get ready'); set('#rvNext', 'Read one sentence after each settings change.'); return; }
  const r = S.rec, t = r && r.sweep ? r.n / S.fs : 0, step = sw.plan[sw.i], say = $('#rvSay');
  const tm = `Step ${sw.i + 1} <span>of ${sw.plan.length}</span>`; if ($('#rvTime').innerHTML !== tm) $('#rvTime').innerHTML = tm;
  let text = SWEEP_LINE, cls = 'say';
  if (sw.phase === 'apply') { set('#rvPhase', step.label); text = 'Switching settings…'; cls = 'say quiet'; }
  else if (t < SWEEP_QUIET) { set('#rvPhase', `${step.label} · room tone`); text = 'Stay quiet'; cls = 'say quiet'; }
  else set('#rvPhase', `${step.label} · ${mmss(t - SWEEP_QUIET)} of ${mmss(SWEEP_TALK)}`);
  if (say.textContent !== text) say.textContent = text;
  if (say.className !== cls) say.className = cls;
  set('#rvNext', sw.plan[sw.i + 1] ? `Next: ${sw.plan[sw.i + 1].label}` : 'Last step');
  const bar = $('#steps tr.cur td.bar i'); if (bar) bar.style.width = (sw.phase === 'rec' ? 100 * Math.min(1, t / (SWEEP_QUIET + SWEEP_TALK)) : 0) + '%';
}

/* ---------------- advice for a run ---------------- */
/* Fixes are worked out from the settings the run was recorded with, so they stay put after one is applied */
function adviceFor(t) {
  const m = S.mic, own = m && t.meta.adapter === m.adapter.id && t.meta.hw;
  return verdict(t, own ? { profile: S.profile, adapter: m.adapter, caps: m.adapter.caps, now: t.meta.hw, describe: m.adapter.describe, describeHw }
    : { profile: S.profile, describeHw, describe: h => describeHw(h, t.meta.adapter) });
}
function fixRows(run) {
  const t = bestTake(run), v = adviceFor(t), m = ctl(), now = nowState(), applied = S.applied.get(run.id) || new Set();
  const matches = set => now && Object.entries(set).every(([k, x]) => now[k] === x), stale = now && hwKey(now) !== hwKey(t.meta.hw);
  const rows = v.fixes.map((f, fi) => ({
    title: f.title, detail: f.detail,
    actions: f.fixes.length ? f.fixes.map((x, ai) => applied.has(x.label) && matches(x.set) ? { done: true } : {
      f: fi, a: ai, label: x.label,
      disabled: !m || m.adapter.id !== t.meta.adapter || !!S.sweep || !!S.rec || ('gain' in x.set && stale),
      why: !m ? `Connect the ${micName(t)} and pick it as the input to apply this.` : 'gain' in x.set && stale ? 'The mic has changed since this run. Record again for a gain that fits.' : 'Not available while recording.',
    }) : [{ hand: true }],
  }));
  for (const n of v.notes) rows.push({ cls: 'note', title: n.title, detail: n.detail, actions: [] });
  const close = run.kind === 'sweep' && sweepNote(run.takes.map(x => ({ take: x, score: takeScore(x) })).sort((a, b) => b.score - a.score));
  if (close) rows.push({ cls: 'note', title: 'Close call', detail: close, actions: [] });
  return rows;
}
function noticeFor(run) {
  const t = bestTake(run), m = ctl(), now = nowState();
  if (!m || !now || !t.meta.hw || t.meta.adapter !== m.adapter.id || hwKey(now) === hwKey(t.meta.hw)) return null;
  const change = changeLine(diffSetups([t, { meta: { ...t.meta, hw: now } }]).changed, now);
  return change ? { text: 'Mic changed after this run', change } : null;
}
const onMic = t => { const m = ctl(), now = nowState(); return !!(m && now && t.meta.hw && t.meta.adapter === m.adapter.id && hwKey(now) === hwKey(t.meta.hw)); };
function ctxFor(run, mode) {
  const m = ctl(), t = bestTake(run), own = !!(m && t.meta.hw && t.meta.adapter === m.adapter.id);
  return {
    mode, P: PROFILES[S.profile], prev: prevOf(run), tab: S.tab === 'obs' && S.profile === 'calls' ? 'spectrum' : S.tab, obsTab: S.profile !== 'calls', playing: S.play && S.play.key, score: scoreOf, takeScore, describeHw, micName,
    verdict: r => adviceFor(bestTake(r)), useLabel: u => profileOf(u).label, fixRows, notice: mode === 'tune' ? noticeFor(run) : null, onMic,
    canUse: own && !S.sweep && !S.rec, canUseWhy: !t.meta.hw ? '' : !m ? `Connect the ${micName(t)} and pick it as the input to use these settings.` : !own ? 'This run was recorded on another mic.' : 'Not available while recording.',
  };
}

/* ---------------- rendering ---------------- */
function renderAll() { renderTop(); renderRail(); renderTune(); renderRuns(); }
function renderTop() {
  for (const [el, v] of [[$('#navTune'), 'tune'], [$('#navRuns'), 'runs']]) if (S.view === v) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  $('#runCount').textContent = S.runs.length || '';
  $$('#profSeg button').forEach(b => { b.classList.toggle('on', b.dataset.v === S.profile); b.setAttribute('aria-pressed', b.dataset.v === S.profile); });
  $('#brand').classList.toggle('rec', !!(S.rec || S.sweep));
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#themeBtn').innerHTML = icon(dark ? 'sun' : 'moon'); $('#themeBtn').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
}
function renderRail() {
  const live = streamLive(), sel = $('#dev');
  $('#micBtn').hidden = live || !!S.stream; $('#picker').hidden = !live && !S.stream;
  $('#devName').textContent = (sel.selectedOptions[0] || {}).textContent || inputLabel() || 'Default input';
  $('#liveDot').className = 'live' + (S.rec || S.sweep ? ' rec' : live ? ' on' : '');
  $('#picker').title = live ? `${(S.fs / 1000).toFixed(1)} kHz${S.proc ? ' · browser processing on' : ''}` : '';
  const i = DISTANCES.indexOf(S.dist);
  $('#distV').textContent = `${S.dist} in`; $('#distDn').disabled = i <= 0; $('#distUp').disabled = i >= DISTANCES.length - 1;
  $('#procSw').setAttribute('aria-checked', S.proc); $('#procSw').disabled = !!(S.rec || S.sweep);
  renderHw();
}
function renderTune() {
  const busy = !!(S.rec || S.sweep), run = runById(S.cur);
  $('#recbar').hidden = busy; $('#recView').hidden = !busy; $('#idle').hidden = busy || !!run; $('#result').hidden = busy || !run;
  $('#recSweep').setAttribute('aria-disabled', !ctl());
  $('#recLbl').textContent = run && noticeFor(run) ? 'Record again' : 'Record check';
  $('#idleSpec').hidden = !streamLive();
  if (busy) {
    $('#rvTitle').textContent = S.sweep ? 'Best settings' : S.rec.kind === 'check' ? 'Quick check' : 'Free talk';
    $('#steps').hidden = !S.sweep; $('#wvRec').hidden = !!S.sweep; $('#recSpecBox').hidden = !!S.sweep;
    if (S.sweep) renderSteps(); else drawRecWave(true);
  }
  if (S.view !== 'tune' || busy || !run) return;
  const el = $('#result'), c = ctxFor(run, 'tune');
  el.innerHTML = runHtml(run, c); drawRun(el, run, c);
  if (c.tab === 'obs') renderObsPane();
}
function drawRecWave(force) {
  const r = S.rec; if (!r || r.sweep) return;
  const now = performance.now(); if (!force && now - (r.drawn || 0) < 100) return; r.drawn = now;
  const t = r.active ? r.n / S.fs : 0, dur = r.guided ? TOTAL : Math.max(30, Math.ceil((t + 5) / 30) * 30);
  wave($('#wvRec'), { env: r.env, marks: r.guided ? plannedMarks() : null }, { h: 150, dur, upto: t, cur: r.pi, band: PROFILES[S.profile].peak, events: false });
}
async function renderFoot() {
  const n = S.runs.length, mb = (await db.bytesUsed()) / 1e6;
  $('#rlFoot').textContent = n ? `${n} run${n > 1 ? 's' : ''} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB in this browser${db.remote ? ` · also in ${db.remote.dir}` : ''}` : db.remote ? `Runs folder ${db.remote.dir}` : '';
}
function renderRuns() {
  $('#rlCount').textContent = S.runs.length || '';
  if (S.view !== 'runs') return;
  S.cmp = S.cmp.filter(runById);
  if (!runById(S.open)) S.open = S.runs.length ? S.runs.at(-1).id : null;
  const lc = { score: scoreOf, prevScore: r => { const p = prevOf(r); return p ? scoreOf(p) : null; }, cmp: S.cmp, series: seriesOf(S.cmp.length), open: S.open, line: r => runLine(S.runs, r) };
  $('#runlist').innerHTML = runListHtml(S.runs, lc);
  $('#trendBox').hidden = S.runs.length < 2;
  if (S.runs.length >= 2) drawTrend($('#trend'), S.runs, lc);
  renderFoot();
  const d = $('#detail');
  if (S.cmp.length >= 2) {
    const runs = S.cmp.map(runById), c = { P: PROFILES[S.profile], score: scoreOf, ab: Math.min(S.ab, runs.length - 1), abOn: !!S.abp, abReady: runs.every(r => bestTake(r).audio || bestTake(r).data) };
    d.innerHTML = compareHtml(runs, c); drawCompare(d, runs, c);
  } else if (S.open) { const run = runById(S.open), c = ctxFor(run, 'runs'); d.innerHTML = runHtml(run, c); drawRun(d, run, c); }
  else d.innerHTML = '';
}

/* ---------------- playback ---------------- */
async function playData(key, x, fs, from = 0, gain = 1) {
  await ensureCtx(); stopAll();
  const buf = S.ctx.createBuffer(1, x.length, fs); buf.copyToChannel(x, 0);
  const src = S.ctx.createBufferSource(), g = S.ctx.createGain(); src.buffer = buf; g.gain.value = gain; src.connect(g).connect(S.ctx.destination);
  const off = Math.max(0, Math.min(.999, from)) * buf.duration; src.start(0, off);
  S.play = { key, src, t0: S.ctx.currentTime - off, dur: buf.duration };
  src.onended = () => { if (S.play && S.play.src === src) { S.play = null; updatePlayUi(); } };
  updatePlayUi();
}
async function play(run, ti, from) {
  const key = `${run.id}:${ti}`;
  if (S.play && S.play.key === key && from == null) { stopAll(); return; }
  try { await playData(key, await loadAudio(run.takes[ti]), run.takes[ti].fs, from || 0); } catch (e) { toast(e.message); }
}
function stopPlay() { if (S.play) { try { S.play.src.stop(); } catch { } S.play = null; } }
function stopAb() { if (S.abp) { S.abp.srcs.forEach(s => { try { s.stop(); } catch { } }); S.abp = null; } }
function stopAll() { const was = S.play || S.abp; stopPlay(); stopAb(); if (was) updatePlayUi(); }
function updatePlayUi() {
  $$('[data-act=play][data-key]').forEach(b => { const on = S.play && S.play.key === b.dataset.key; b.innerHTML = icon(on ? 'pause' : 'play'); });
  $$('[data-wave]').forEach(el => playhead(el, null));
  const t = $('#playTuned'); if (t) t.innerHTML = `${icon(S.play && S.play.key === 'tuned' ? 'pause' : 'play')}Tuned`;
  const ab = $('[data-act=ab-play]'); if (ab) { ab.innerHTML = icon(S.abp ? 'pause' : 'play'); ab.setAttribute('aria-label', `${S.abp ? 'Pause' : 'Play'} the comparison`); }
}
/* A/B: every run in the comparison plays in step and only the chosen one is heard, so switching lands on the same words */
async function abToggle() {
  if (S.abp) { stopAll(); return; }
  const runs = S.cmp.map(runById); let xs;
  try { xs = await Promise.all(runs.map(r => loadAudio(bestTake(r)))); } catch (e) { toast(e.message); return; }
  await ensureCtx(); stopAll();
  const at = S.ctx.currentTime + 0.08, dur = Math.min(...xs.map((x, i) => x.length / bestTake(runs[i]).fs)), srcs = [], gains = [];
  xs.forEach((x, i) => {
    const b = S.ctx.createBuffer(1, x.length, bestTake(runs[i]).fs); b.copyToChannel(x, 0);
    const s = S.ctx.createBufferSource(), g = S.ctx.createGain(); s.buffer = b; g.gain.value = i === S.ab ? 1 : 0;
    s.connect(g).connect(S.ctx.destination); s.start(at); s.stop(at + dur); srcs.push(s); gains.push(g);
  });
  S.abp = { srcs, gains, t0: at, dur };
  srcs[0].onended = () => { if (S.abp && S.abp.srcs === srcs) { S.abp = null; updatePlayUi(); } };
  updatePlayUi();
}
function abSwitch(i) {
  if (i >= S.cmp.length) return;
  S.ab = i;
  if (S.abp) S.abp.gains.forEach((g, k) => g.gain.setTargetAtTime(k === i ? 1 : 0, S.ctx.currentTime, 0.008));
  const d = $('#detail'), runs = S.cmp.map(runById);
  $$('#detail [data-act=ab]').forEach(b => { const on = +b.dataset.i === i; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $$('#detail .abrow').forEach((row, k) => row.classList.toggle('on', k === i));
  drawCompare(d, runs, { P: PROFILES[S.profile], ab: i });
}
function playheads() {
  const P = S.play, A = S.abp;
  if (P) {
    const pos = S.ctx.currentTime - P.t0, f = pos / P.dur;
    $$(`[data-wave="${P.key}"]`).forEach(el => { if (!el.closest('.abrow')) playhead(el, f); });
    const tm = $(`[data-time="${P.key}"]`); if (tm) tm.textContent = `${mmss(Math.min(pos, P.dur))} / ${mmss(P.dur)}`;
  }
  if (A) { const f = (S.ctx.currentTime - A.t0) / A.dur; $$('.abrow .wv').forEach(el => playhead(el, f >= 0 ? f : 0)); }
}

/* ---------------- streaming chain and OBS ---------------- */
const CHAIN_UI = [
  ['Noise gate', 'gateOn', [['gateOpen', 'Opens above', -80, -20, 1, 'dB']]],
  ['EQ', null, [['eqLow', 'Low, under 800 Hz', -12, 12, 0.5, 'dB'], ['eqMid', 'Mid', -12, 12, 0.5, 'dB'], ['eqHigh', 'High, over 5 kHz', -12, 12, 0.5, 'dB']]],
  ['Compressor', 'compOn', [['thr', 'Threshold', -50, 0, 1, 'dB'], ['ratio', 'Ratio', 1, 10, 0.5, ':1'], ['att', 'Attack', 1, 100, 1, 'ms'], ['rel', 'Release', 10, 500, 10, 'ms']]],
  ['Output', null, [['target', 'Target loudness', -30, -10, 0.5, 'LUFS'], ['ceil', 'Limiter ceiling', -6, 0, 0.5, 'dBFS']]],
];
const chainVal = (k, u) => (k === 'ratio' ? S.chain[k].toFixed(1) : fmt(S.chain[k], Number.isInteger(S.chain[k]) ? 0 : 1)) + (u[0] === ':' ? '' : ' ') + u;
const rangePct = (v, a, b) => `${((v - a) / (b - a) * 100).toFixed(1)}%`;
function renderObsPane() {
  const el = $('#obsPane'); if (!el) return;
  el.innerHTML = `<div class="obs-top"><button class="btn line sm" data-obs="suggest">Suggest from this run</button><button class="btn quiet sm" data-obs="preset">Preset</button><span class="spacer"></span>
      <button class="btn line sm" id="playTuned" data-obs="play">${icon(S.play && S.play.key === 'tuned' ? 'pause' : 'play')}Tuned</button><label class="chk"><input type="checkbox" id="matchLoud" ${prefs.get('matchLoud') === false ? '' : 'checked'}>Match loudness</label>
      <button class="iconbtn sm" data-obs="wav" aria-label="Save tuned WAV" title="Save tuned WAV">${icon('download')}</button></div>
    <div class="chain">${CHAIN_UI.map(([title, tog, ctls]) => `<div class="grp"><div class="gh">${title}${tog ? `<span class="spacer"></span><button class="switch" role="switch" data-c="${tog}" aria-checked="${!!S.chain[tog]}" aria-label="${title}"></button>` : ''}</div>
      ${ctls.map(([k, l, a, b, st, u]) => `<div class="ctl"><div class="lbl"><label for="c_${k}">${l}</label><output id="o_${k}">${chainVal(k, u)}</output></div><input type="range" id="c_${k}" data-c="${k}" data-u="${u}" min="${a}" max="${b}" step="${st}" value="${S.chain[k]}" style="--p:${rangePct(S.chain[k], a, b)}"></div>`).join('')}</div>`).join('')}</div>
    <div class="obs-grid"><div><div class="sect-h"><span class="cap">After the chain</span></div><div id="tunedRows"><div class="note">Working…</div></div></div>
      <div><div class="sect-h"><span class="cap">OBS filters</span></div><pre id="obs"></pre>
        <div class="obs-conn"><input class="field mono" id="obsUrl" value="${esc(prefs.get('obsUrl') || 'ws://127.0.0.1:4455')}" aria-label="OBS WebSocket address"><input class="field" type="password" id="obsPass" placeholder="WebSocket password" autocomplete="off" aria-label="OBS WebSocket password">
          <button class="btn line sm" id="obsConnect"></button><select class="field" id="obsSource" aria-label="OBS audio source"><option value="">Audio source</option></select>
          <button class="btn primary sm" id="obsPush" style="grid-column:1 / -1">Push to OBS</button><div class="status" id="obsStatus" role="status"></div></div></div></div>`;
  renderObsText(); renderObsConn(); scheduleTune(0);
}
function scheduleTune(ms = 220) { clearTimeout(scheduleTune.t); scheduleTune.t = setTimeout(runTune, ms); }
/* The chain runs only while its tab is open, or when you play the tuned version */
async function runTune() {
  const run = runById(S.cur); if (!run) return;
  const t = bestTake(run); let x;
  try { x = await loadAudio(t); } catch (e) { const r = $('#tunedRows'); if (r) r.innerHTML = `<div class="note">${esc(e.message)}</div>`; return; }
  const r = processChain(x, t.fs, S.chain);
  S.tuned = { key: run.id, data: r.data, fs: t.fs, makeup: r.makeup, avgGR: r.avgGR, peakLimited: r.peakLimited, a: analyze(r.data, t.fs, t.marks) };
  renderTuned(); renderObsText();
}
function renderTuned() {
  const el = $('#tunedRows'); if (!el || !S.tuned) return;
  const a = S.tuned.a, P = PROFILES[S.profile], row = (k, v, u, note, bad) => `<div class="chg-row"><span class="k">${k}</span><span class="vv${bad ? ' dn' : ''}">${v} ${u}<span class="dim" style="margin-left:10px">${note}</span></span></div>`;
  el.innerHTML = row('Loudness', fmt(a.integrated), 'LUFS', `target ${fmt(P.final, 0)}`, Math.abs(a.integrated - P.final) > 1)
    + row('Max peak', fmt(a.peak), 'dBFS', `ceiling ${fmt(S.chain.ceil)}`, a.peak > S.chain.ceil + 0.1)
    + row('Noise floor', fmt(a.noise), 'dBFS', 'after the gate', a.noise > -50) + row('Loudness range', fmt(a.lra), 'LU', `at most ${P.lra}`, a.lra > P.lra)
    + row('OBS gain', fmtS(S.tuned.makeup), 'dB', `compression ${fmt(S.tuned.avgGR)} dB`)
    + (S.tuned.peakLimited ? `<div class="note dn" style="margin-top:10px">Peaks hit the limiter before the voice reaches ${fmt(S.chain.target)} LUFS. Lower the compressor threshold or raise the ratio.</div>` : '');
}
const makeup = () => S.tuned && S.tuned.key === S.cur ? S.tuned.makeup : null;
function renderObsText() {
  const el = $('#obs'); if (!el) return;
  const run = runById(S.cur), t = run && bestTake(run), hw = t && t.meta.hw;
  el.textContent = obsRecipe(S.chain, makeup()) + `\n\nResult: ${fmt(S.chain.target)} LUFS integrated${hw ? `, with the mic at ${describeHw(hw, t.meta.adapter)}` : ''}${t && t.meta.distance ? ` and ${t.meta.distance} in` : ''}.`;
}
function renderObsConn() {
  const b = $('#obsConnect'); if (!b) return;
  const on = S.obs.connected;
  b.textContent = on ? 'Disconnect' : 'Connect OBS';
  $('#obsSource').disabled = !on; $('#obsPush').disabled = !on || makeup() == null; $('#obsUrl').disabled = on; $('#obsPass').disabled = on;
}
S.obs.onClose = () => { const s = $('#obsStatus'); if (s) s.textContent = 'OBS disconnected'; renderObsConn(); };
async function obsConnect() {
  if (S.obs.connected) { S.obs.close(); renderObsConn(); return; }
  const url = $('#obsUrl').value.trim() || 'ws://127.0.0.1:4455', status = $('#obsStatus');
  try {
    await S.obs.connect(url, $('#obsPass').value); prefs.set('obsUrl', url);
    const names = await S.obs.audioInputs(), sel = $('#obsSource'), keep = sel.value || prefs.get('obsSource');
    sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('') || '<option value="">No audio inputs in OBS</option>';
    const pick = names.find(n => n === keep) || names.find(n => ADAPTERS.some(a => a.labelMatch && a.labelMatch.test(n))) || names.find(n => /mic/i.test(n));
    if (pick) sel.value = pick;
    status.textContent = 'Connected';
  } catch (e) { status.textContent = e.message; }
  renderObsConn();
}
async function obsPush() {
  const status = $('#obsStatus'); $('#obsPush').disabled = true;
  try {
    const src = $('#obsSource').value; if (!src) throw new Error('Pick the OBS audio source for your mic');
    prefs.set('obsSource', src);
    status.textContent = `Pushed ${await S.obs.push(src, obsFilters(S.chain, makeup()))} filters to "${src}"`;
  } catch (e) { status.textContent = e.message; }
  renderObsConn();
}
async function playTuned() {
  if (S.play && S.play.key === 'tuned') { stopAll(); return; }
  const run = runById(S.cur); if (!run) return;
  if (!S.tuned || S.tuned.key !== run.id) await runTune();
  if (!S.tuned) return;
  const own = S.tuned.a.integrated, raw = bestTake(run).a.integrated, ref = Math.min(own, raw);
  /* Matched playback only turns the tuned version down, so it can never jump in volume */
  const g = $('#matchLoud') && $('#matchLoud').checked && Number.isFinite(ref) && Number.isFinite(own) ? Math.pow(10, Math.min(0, ref - own) / 20) : 1;
  playData('tuned', S.tuned.data, S.tuned.fs, 0, g);
}
function obsClick(e) {
  const b = e.target.closest('[data-obs]'), sw = e.target.closest('.switch[data-c]');
  if (sw) { S.chain[sw.dataset.c] = !S.chain[sw.dataset.c]; sw.setAttribute('aria-checked', S.chain[sw.dataset.c]); renderObsText(); scheduleTune(); return; }
  if (e.target.id === 'obsConnect') return obsConnect();
  if (e.target.id === 'obsPush') return obsPush();
  if (!b) return;
  const run = runById(S.cur), act = b.dataset.obs;
  if (act === 'suggest' && run) { S.chain = suggestChain(bestTake(run).a, S.profile); renderObsPane(); toast('Chain set from this run'); }
  if (act === 'preset') { S.chain = { ...CHAIN_PRESETS[S.profile] }; renderObsPane(); }
  if (act === 'play') playTuned();
  if (act === 'wav' && run && S.tuned) { const t = bestTake(run); download(encodeWav(S.tuned.data, t.fs, { name: t.name + ' tuned', created: t.created, marks: t.marks, meta: { ...t.meta, mode: 'tuned', hw: null, adapter: null, chain: { ...S.chain }, makeupDb: S.tuned.makeup, use: S.profile } }), `mic-lab-run-${run.n}-tuned.wav`, 'audio/wav'); }
}
function obsInput(e) {
  const k = e.target.dataset && e.target.dataset.c;
  if (e.target.id === 'matchLoud') { prefs.set('matchLoud', e.target.checked); return; }
  if (!k || e.target.type !== 'range') return;
  S.chain[k] = Number(e.target.value); $('#o_' + k).textContent = chainVal(k, e.target.dataset.u);
  e.target.style.setProperty('--p', rangePct(S.chain[k], +e.target.min, +e.target.max));
  renderObsText(); scheduleTune();
}

/* ---------------- mic control over WebHID ---------------- */
function hidLog(kind, text) {
  for (const ln of String(text).split(/\r?\n/)) if (ln) S.log.push({ kind, text: (kind === 'tx' ? '→ ' : kind === 'rx' ? '← ' : '! ') + ln });
  if (S.log.length > 200) S.log.splice(0, S.log.length - 200);
  const el = $('#hwLog'); if (el) { el.innerHTML = S.log.map(l => `<div class="${l.kind}">${esc(l.text)}</div>`).join(''); el.scrollTop = el.scrollHeight; }
}
function onHwState(s) {
  if (S.rec && S.rec.hw && hwKey(s) !== hwKey(S.rec.hw)) S.rec.hwChanged = true;
  cancelAnimationFrame(onHwState.f); onHwState.f = requestAnimationFrame(() => { if (S.sweep) { renderRail(); renderSteps(); } else renderAll(); });
}
async function attach(dev) {
  const adapter = adapterFor(dev); if (!adapter) return;
  const t = webhidTransport(dev);
  try { await t.open(); } catch (e) { toast(`Could not open the ${adapter.name}. Quit MOTIV or any other app using it, then try again.`, 6000); hidLog('er', e.message); return; }
  try {
    const device = await adapter.open(t, { log: hidLog, store: prefs });
    S.mic = { adapter, device, dev };
    device.onState = onHwState;
    device.onNotify = () => { clearTimeout(attach.n); attach.n = setTimeout(() => device.read().catch(() => { }), 300); };
    if (S.pendingRestore && S.pendingRestore.adapter === adapter.id) { device.atConnect = { ...device.atConnect, ...S.pendingRestore.settings }; S.pendingRestore = null; toast('Press Restore under Mic settings to put back the settings from before the sweep.', 7000); }
    if (!adapter.tested) toast(`${adapter.name} control is untested. Every change is read back, and Restore puts back the settings you connected with.`, 7000);
  } catch (e) { toast(e.message, 5000); await t.close(); return; }
  renderAll();
}
async function connectMic() {
  if (!('hid' in navigator)) { toast('Mic control needs Chrome or Edge on a computer.', 4000); return; }
  try { const d = await findDevice(navigator.hid, { ask: true }); if (d) await attach(d); } catch (e) { toast(e.message, 4000); }
}
async function disconnectMic() { if (!S.mic) return; const m = S.mic; S.mic = null; await m.device.close(); renderAll(); }
/* The settings panel is built from what the adapter can change */
function renderHw() {
  const el = $('#hw'), hid = 'hid' in navigator, guess = ADAPTERS.find(a => a.labelMatch && a.labelMatch.test(inputLabel()));
  if (!S.mic && !guess) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (!S.mic) {
    el.innerHTML = `<div class="hw-head"><span class="k">Mic settings</span></div>` + (hid ? `<button class="btn line wide" data-hw="connect">${icon('usb')}Connect ${esc(guess.name)}</button>` : `<div class="note">Changing ${esc(guess.name)} settings needs Chrome or Edge on a computer.</div>`);
    return;
  }
  if (S.hwDrag) return;
  const { adapter: a, device: d } = S.mic, s = d.state || {}, c = a.caps, man = !c.mode || s.mode === 'manual', busy = !!(S.rec || S.sweep), on = ctl();
  const tag = busy ? ['Held while recording', ''] : !on ? ['Not the selected input', 'bad'] : !a.tested ? ['Untested', 'bad'] : null;
  const seg = (label, key, opts) => `<div class="ctl"><div class="lbl"><span class="k">${label}</span></div><div class="seg fill" data-k="${key}" role="group" aria-label="${label}">${opts.map(([v, l]) => { const is = String(s[key]) === String(v); return `<button data-v="${v}" class="${is ? 'on' : ''}" aria-pressed="${is}">${l}</button>`; }).join('')}</div></div>`;
  const sw = (label, key) => `<div class="row"><span class="k">${label}</span><span class="spacer"></span><button class="switch" role="switch" data-k="${key}" aria-checked="${!!s[key]}" aria-label="${label}"></button></div>`;
  const range = (label, key, r, show) => `<div class="ctl"><div class="lbl"><span class="k">${label}</span><span class="v" data-show="${key}">${show(s[key])}</span></div><input type="range" data-k="${key}" min="${r.min}" max="${r.max}" step="${r.step || 1}" value="${s[key] ?? r.min}" style="--p:${rangePct(s[key] ?? r.min, r.min, r.max)}" aria-label="${label}"></div>`;
  const body = [
    c.mode && seg('Mode', 'mode', [['manual', 'Manual'], ['auto', 'Auto Level']]),
    !man && c.position && seg('Position', 'position', [['near', 'Near'], ['far', 'Far']]),
    !man && c.tones && seg('Tone', 'tone', c.tones.map(t => [t, t[0].toUpperCase() + t.slice(1)])),
    man && c.gain && range('Gain', 'gain', c.gain, v => v != null ? `${fmt(v, Number.isInteger(v) ? 0 : 1)} dB` : '—'),
    c.toneLevel && range('Tone', 'toneLevel', c.toneLevel, v => v != null ? fmtS(v, 0) : '—'),
    man && c.comp && seg('Compressor', 'comp', c.comp.map((n, i) => [i, n])),
  ].filter(Boolean).join('');
  const rows = [c.hp && (man || !c.position) && sw('High-pass', 'hp'), man && c.pres && sw('Presence boost', 'pres'), c.popper && sw('Popper stopper', 'popper'), c.denoise && sw('Denoiser', 'denoise'), c.limiter && sw('Limiter', 'limiter'), sw('Mute', 'muted')].filter(Boolean).join('');
  const back = d.atConnect && hwKey(d.atConnect) !== hwKey(s) ? changeLine(diffSetups([{ meta: { hw: s } }, { meta: { hw: d.atConnect } }]).changed, d.atConnect) : '';
  el.innerHTML = `<div class="hw-head"><span class="k">Mic settings</span>${tag ? `<span class="tag ${tag[1]}">${tag[0]}</span>` : ''}${s.locked ? `<span class="lock" title="Settings lock on: the mic's touch panel is locked">${icon('lock')}</span>` : ''}
      <button class="iconbtn sm" data-hw="menu" aria-label="More mic actions" aria-expanded="${S.menu}">${icon('more')}</button></div>
    ${S.menu ? `<div class="menu" role="menu"><button role="menuitem" data-hw="refresh">Read settings again</button><button role="menuitem" data-hw="log">${S.showLog ? 'Hide' : 'Show'} USB log</button><button role="menuitem" data-hw="disconnect">Disconnect ${esc(a.name)}</button></div>` : ''}
    <div class="hwbody${busy ? ' held' : ''}">${body}<div class="rows">${rows}</div></div>
    ${back ? `<div class="hw-foot"><button class="btn line sm" data-hw="restore" title="Put back the settings the mic had when you connected">${icon('undo')}Restore</button><span class="note mono" style="align-self:center">${esc(back)}</span></div>` : ''}
    ${S.showLog ? `<div class="log" id="hwLog"></div>` : ''}
    ${s.fw ? `<div class="note mono dim" style="font-size:11.5px">${esc(a.name)} · firmware ${esc(s.fw)}</div>` : ''}`;
  if (S.showLog) hidLog('', '');
}
const hwSet = set => { const m = freeMic(); if (m) m.device.apply(set).catch(e => toast(e.message, 5000)).finally(renderAll); else renderRail(); };
function hwClick(e) {
  const act = e.target.closest('[data-hw]'), segBtn = e.target.closest('.seg[data-k] button'), sw = e.target.closest('.switch[data-k]');
  const mv7 = S.mic && S.mic.adapter.id === 'shure-mv7';
  if (act) {
    const a = act.dataset.hw; if (a !== 'menu') S.menu = false;
    if (a === 'connect') connectMic();
    if (a === 'menu') { S.menu = !S.menu; renderHw(); }
    if (a === 'refresh') { const m = freeMic(); if (m) m.device.read().catch(err => toast(err.message)); renderHw(); }
    if (a === 'log') { S.showLog = !S.showLog; renderHw(); }
    if (a === 'disconnect') disconnectMic();
    if (a === 'restore') { const m = freeMic(); if (m) m.device.restore().then(() => toast('Settings restored')).catch(err => toast(err.message, 5000)); }
    return;
  }
  if (segBtn && !segBtn.disabled) {
    const k = segBtn.parentElement.dataset.k, raw = segBtn.dataset.v, v = k === 'comp' ? +raw : raw, set = { [k]: v };
    if (k === 'position' || k === 'tone') set.mode = 'auto';
    if (k === 'comp' && mv7) set.mode = 'manual';
    hwSet(set); return;
  }
  if (sw) { const k = sw.dataset.k, set = { [k]: sw.getAttribute('aria-checked') !== 'true' }; if ((k === 'hp' || k === 'pres') && mv7) set.mode = 'manual'; hwSet(set); }
}
function hwInput(e) {
  const k = e.target.dataset && e.target.dataset.k; if (!k || e.target.type !== 'range') return;
  const v = +e.target.value, show = $(`[data-show="${k}"]`);
  if (show) show.textContent = k === 'gain' ? `${fmt(v, Number.isInteger(v) ? 0 : 1)} dB` : fmtS(v, 0);
  e.target.style.setProperty('--p', rangePct(v, +e.target.min, +e.target.max));
  S.hwDrag = e.type === 'input';
  if (e.type === 'change') hwSet(k === 'gain' && S.mic.adapter.caps.mode ? { mode: 'manual', gain: v } : { [k]: v });
}

/* ---------------- runs: report, files, import and export ---------------- */
function download(data, name, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const buildReport = run => run ? report(run.takes, adviceCtx()) : null;
async function copyReport(run) {
  const md = reportMarkdown(buildReport(run), S.tuned && S.tuned.key === run.id && $('#obs') ? 'OBS chain:\n' + $('#obs').textContent : '');
  try { await navigator.clipboard.writeText(md); toast('Copied. Paste it into a chat or an issue.'); }
  catch { download(md, `mic-lab-run-${run.n}.md`, 'text/markdown'); toast('The clipboard is blocked, so the report was saved as a file.'); }
}
async function saveWav(run, ti) {
  const t = run.takes[ti], bytes = (t.audio && await db.audio(t.audio).catch(() => null)) || (t.data && encodeWav(t.data, t.fs, wavInfo(run, t), { bits: 16 }));
  if (!bytes) { toast('This run has no audio in this browser.'); return; }
  download(bytes, `mic-lab-run-${run.n}${run.takes.length > 1 ? '-' + (ti + 1) : ''}.wav`, 'audio/wav');
}
async function deleteRun(run) {
  if (!confirm(`Delete run ${run.n} and its recording?`)) return;
  stopAll();
  try { await db.del(run.id); } catch (e) { toast(e.message); return; }
  S.runs = S.runs.filter(r => r !== run); S.cmp = S.cmp.filter(id => id !== run.id); S.applied.delete(run.id);
  run.takes.forEach(t => S.audio.delete(t.audio));
  if (S.cur === run.id) S.cur = S.runs.length ? S.runs.at(-1).id : null;
  if (S.open === run.id) S.open = S.runs.length ? S.runs.at(-1).id : null;
  toast(`Run ${run.n} deleted`); renderAll();
}
async function exportRuns() {
  if (!S.runs.length) { toast('No runs to export yet'); return; }
  const files = [];
  for (const run of S.runs) {
    if (!run.rec) continue;
    files.push({ name: run.id + '.json', bytes: new TextEncoder().encode(JSON.stringify(run.rec, null, 1)), mtime: run.created });
    for (const t of run.takes) { const b = t.audio && await db.audio(t.audio).catch(() => null); if (b) files.push({ name: t.audio, bytes: b, mtime: t.created || run.created }); }
  }
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  download(tar(files), `mic-lab-runs-${stamp}.tar`, 'application/x-tar');
}
/* Accepts an export (.tar), run records (.json) with their WAVs, or any WAV, which becomes a run of its own */
async function importFiles(list) {
  const recs = [], wavs = new Map(), loose = [], td = new TextDecoder(); let added = 0, skipped = 0;
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      if (/\.tar$/i.test(f.name)) for (const x of untar(bytes)) { if (/\.json$/.test(x.name)) recs.push(JSON.parse(td.decode(x.bytes))); else if (isAudioName(x.name)) wavs.set(x.name, x.bytes); }
      else if (/\.json$/i.test(f.name)) { const j = JSON.parse(td.decode(bytes)); recs.push(...(Array.isArray(j) ? j : [j])); }
      else if (isAudioName(f.name)) wavs.set(f.name, bytes);
      else loose.push({ name: f.name, bytes });
    } catch { skipped++; }
  }
  for (const rec of recs) {
    try {
      checkRun(rec);
      if (runById(rec.id)) { skipped++; continue; }
      if (S.runs.some(r => r.n === rec.n)) rec.n = nextN();
      const run = unpackRun(rec); run.rec = rec;
      await db.put(rec, run.takes.filter(t => wavs.has(t.audio)).map(t => ({ name: t.audio, bytes: wavs.get(t.audio) })));
      S.runs.push(run); S.runs.sort((a, b) => a.created - b.created); added++;
    } catch { skipped++; }
  }
  const hashes = new Set(allTakes().map(t => t.sha256).filter(Boolean));
  for (const f of loose) {
    try {
      const w = decodeWav(f.bytes), info = w.info || {}, meta = { mode: 'file', ...(info.meta || {}) }, h = await sha256(f.bytes);
      if (h && hashes.has(h)) { skipped++; continue; }
      const created = info.created || Date.now(), marks = Array.isArray(info.marks) ? info.marks : null;
      const take = { name: info.name || f.name.replace(/\.wav$/i, ''), created, fs: w.fs, marks, meta, a: analyze(w.data, w.fs, marks), env: envelope(w.data, w.fs), data: w.data, bytes: f.bytes };
      await saveRun({ id: newRunId(created), n: nextN(), created, kind: kindOf(meta.mode), use: profileOf(meta.use || S.profile).id, best: 0, takes: [take] }); added++;
    } catch { skipped++; }
  }
  toast(`Imported ${added} run${added === 1 ? '' : 's'}${skipped ? `. Skipped ${skipped} that ${skipped === 1 ? 'was' : 'were'} already here or not a run.` : ''}`, 5000);
  renderAll();
}

/* ---------------- actions in a run, the list and the comparison ---------------- */
async function runAction(e, run) {
  const b = e.target.closest('[data-act]');
  const wv = !b && e.target.closest('.wv[data-wave]');
  if (wv && run && !wv.closest('.abrow')) { const r = wv.getBoundingClientRect(), ti = +wv.dataset.wave.split(':')[1]; return play(run, ti, (e.clientX - r.left) / r.width); }
  const row = !b && e.target.closest('tr[data-take]');
  if (row && run) return play(run, +row.dataset.take);
  if (!b) return;
  const act = b.dataset.act, t = run && bestTake(run);
  if (act === 'play') return play(run, +b.dataset.t);
  if (act === 'copy') return copyReport(run);
  if (act === 'wav') return saveWav(run, +b.dataset.t);
  if (act === 'del') return deleteRun(run);
  if (act === 'tab') { S.tab = b.dataset.tab; renderTune(); return; }
  if (act === 'go-tune') { location.hash = '#tune'; return; }
  if (act === 'cmp-prev') { const p = prevOf(run); if (p) location.hash = `#compare/${p.n},${run.n}`; return; }
  if (act === 'fix') {
    const x = adviceFor(t).fixes[+b.dataset.f].fixes[+b.dataset.a], m = ctl() && freeMic(); if (!m) return;
    b.disabled = true;
    m.device.apply(x.set).then(() => { if (!S.applied.has(run.id)) S.applied.set(run.id, new Set()); S.applied.get(run.id).add(x.label); toast('Applied. Record again to hear the difference.'); })
      .catch(err => toast(String(err.message || err), 5000)).finally(renderAll);
    return;
  }
  if (act === 'undo' || act === 'use' || act === 'apply-take') {
    const take = act === 'apply-take' ? run.takes[+b.dataset.t] : t, m = ctl() && freeMic(); if (!m || !take.meta.hw) return;
    b.disabled = true;
    m.device.apply(settable(m.adapter, take.meta.hw)).then(s => toast(`Mic set to ${m.adapter.describe(s || m.device.state)}`)).catch(err => toast(err.message, 5000)).finally(renderAll);
  }
}
function setHash(h) { if (location.hash !== h) history.replaceState(null, '', h); }
function listClick(e) {
  const b = e.target.closest('[data-act]'), row = e.target.closest('.run[data-run]');
  if (b && b.dataset.act === 'go-tune') { location.hash = '#tune'; return; }
  if (!row) return;
  const id = row.dataset.run;
  if (b && b.dataset.act === 'tick') {
    stopAll();
    if (S.cmp.includes(id)) S.cmp = S.cmp.filter(x => x !== id);
    else if (S.cmp.length >= 3) { toast('Compare up to three runs. Untick one first.'); return; }
    else S.cmp = [...S.cmp, id].sort((a, c) => runById(a).created - runById(c).created);
    if (S.cmp.length === 1) S.open = S.cmp[0];
    S.ab = Math.min(S.ab, Math.max(0, S.cmp.length - 1));
    setHash(S.cmp.length >= 2 ? `#compare/${S.cmp.map(x => runById(x).n).join(',')}` : `#runs/${runById(S.open).n}`);
    renderRuns(); return;
  }
  S.cmp = []; S.open = id; stopAll(); setHash(`#runs/${runById(id).n}`); renderRuns();
}
function detailClick(e) {
  const b = e.target.closest('[data-act]');
  if (S.cmp.length >= 2) {
    if (!b) return;
    if (b.dataset.act === 'ab') return abSwitch(+b.dataset.i);
    if (b.dataset.act === 'ab-play') return abToggle();
    if (b.dataset.act === 'untick') { stopAll(); S.cmp = S.cmp.filter(x => x !== b.dataset.run); if (S.cmp.length === 1) S.open = S.cmp[0]; setHash(S.cmp.length >= 2 ? `#compare/${S.cmp.map(x => runById(x).n).join(',')}` : `#runs/${runById(S.open).n}`); renderRuns(); }
    return;
  }
  runAction(e, runById(S.open));
}

/* ---------------- routing and wiring ---------------- */
function route() {
  const [v, arg] = decodeURIComponent(location.hash.slice(1)).split('/'), byN = n => S.runs.find(r => String(r.n) === n);
  stopAb();
  if (v === 'runs' || v === 'compare') {
    S.view = 'runs';
    if (v === 'runs' && arg && byN(arg)) { S.open = byN(arg).id; S.cmp = []; }
    if (v === 'compare' && arg) { S.cmp = arg.split(',').map(byN).filter(Boolean).sort((a, b) => a.created - b.created).map(r => r.id).slice(0, 3); if (S.cmp.length) S.open = S.cmp.at(-1); }
    if (v === 'runs' && !arg) S.cmp = [];
  } else S.view = 'tune';
  $('#vTune').hidden = S.view !== 'tune'; $('#vRuns').hidden = S.view !== 'runs';
  renderAll();
}
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('mic-lab.theme', t); } catch { } renderTop(); }

$('#profSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.profile) return;
  S.profile = b.dataset.v; prefs.set('profile', S.profile); S.chain = { ...CHAIN_PRESETS[S.profile] }; S.tuned = null; renderAll();
});
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => { let saved = null; try { saved = localStorage.getItem('mic-lab.theme'); } catch { } if (!saved) { document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'; renderTop(); } });
$('#micBtn').onclick = () => startMic().catch(() => { });
$('#dev').onchange = () => { renderAll(); if (S.stream) startMic().catch(() => { }); };
$('#distDn').onclick = () => { S.dist = DISTANCES[Math.max(0, DISTANCES.indexOf(S.dist) - 1)]; prefs.set('distance', S.dist); renderRail(); };
$('#distUp').onclick = () => { S.dist = DISTANCES[Math.min(DISTANCES.length - 1, DISTANCES.indexOf(S.dist) + 1)]; prefs.set('distance', S.dist); renderRail(); };
$('#procSw').onclick = () => { if (S.rec || S.sweep) return; S.proc = !S.proc; renderRail(); if (S.stream) startMic().catch(() => { }); };
$('#recCheck').onclick = () => startRec('check');
$('#recFree').onclick = () => startRec('free');
$('#recSweep').onclick = () => runSweep();
$('#stopBtn').onclick = () => { if (S.sweep) abortSweep(); else if (S.rec && S.rec.active) stopRec(); else if (S.rec) { S.rec = null; renderAll(); } };
$('#hw').addEventListener('click', hwClick);
$('#hw').addEventListener('input', hwInput);
$('#hw').addEventListener('change', hwInput);
$('#result').addEventListener('click', e => { if (e.target.closest('#obsPane')) return obsClick(e); runAction(e, runById(S.cur)); });
$('#result').addEventListener('input', obsInput);
$('#runlist').addEventListener('click', listClick);
$('#detail').addEventListener('click', detailClick);
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f); };
$('#exportBtn').onclick = () => exportRuns();
document.addEventListener('click', e => { if (S.menu && !e.target.closest('#hw')) { S.menu = false; renderHw(); } });
document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.view === 'runs' && S.cmp.length >= 2) {
    const i = 'abc'.indexOf(e.key.toLowerCase());
    if (i >= 0) { e.preventDefault(); abSwitch(i); return; }
    if (e.code === 'Space') { e.preventDefault(); abToggle(); }
    return;
  }
  if (e.code === 'Space' && S.view === 'tune' && document.activeElement.tagName !== 'BUTTON') {
    e.preventDefault();
    if (S.sweep) abortSweep(); else if (S.rec && S.rec.active) stopRec(); else if (!S.rec) startRec('check');
  }
});
window.addEventListener('hashchange', route);
let resizeT; window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { renderTune(); renderRuns(); }, 120); });
if ('hid' in navigator) navigator.hid.addEventListener('disconnect', e => { if (S.mic && e.device === S.mic.dev) { S.mic = null; abortSweep(); if (!S.sweep) toast('Mic control disconnected'); renderAll(); } });

function frame() {
  const L = S.live, live = streamLive();
  const rms = live && L.rms.length ? dbP(L.rms.slice(-4).reduce((a, b) => a + b, 0) / Math.min(4, L.rms.length)) : null;
  meter($('#meter'), { rms, pk: live ? L.hold : null, band: PROFILES[S.profile].peak });
  updateLiveNumbers(); renderPrompter(); drawRecWave();
  const sp = S.view !== 'tune' || !live || !S.an ? null : S.rec && !S.sweep ? $('#spRec') : !$('#idle').hidden ? $('#spLive') : null;
  if (sp && sp.offsetParent) { S.an.node.getFloatFrequencyData(S.an.freq); liveSpec(sp, S.an); }
  if (S.play || S.abp) playheads();
  requestAnimationFrame(frame);
}
(async function init() {
  icons();
  $('#script').innerHTML = PHASES.map(p => `<div class="nm">${p.label}</div><div class="d">${p.dur} s</div><div class="tx">${esc(p.text)}</div>`).join('');
  try { await db.open(); await reloadRuns(); }
  catch (e) { console.warn(e); toast('This browser blocks storage, so runs last only until the tab closes.', 6000); }
  route();
  db.sync().then(async r => { if (r && (r.pulled || r.removed)) { await reloadRuns(); renderAll(); } else renderFoot(); }).catch(e => console.warn(e));
  try { await listDevices(); } catch { }
  try { if ((await navigator.permissions.query({ name: 'microphone' })).state === 'granted') await startMic(); } catch { }
  if ('hid' in navigator) { try { const d = await findDevice(navigator.hid); if (d && usable(d)) await attach(d); } catch { } }
  requestAnimationFrame(frame);
  window.micLab = { S, report: () => buildReport(runById(S.cur)), store: db, runById };
})();
