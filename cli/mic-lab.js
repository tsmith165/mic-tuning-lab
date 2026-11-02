#!/usr/bin/env node
/* mic-lab: measure recordings, keep them as runs, and change mic settings from a terminal. Run "mic-lab help" for usage. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, unlink, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, PHASES } from '../core/dsp.js';
import { PROFILES, fitScore, fmt } from '../core/advice.js';
import { report, reportMarkdown } from '../core/report.js';
import { decodeWav } from '../core/wav.js';
import { KINDS, kindOf, newRunId, isRunId, audioName, isAudioName, envelope, packRun, checkRun, unpackRun, runScore, runLine, compareRuns } from '../core/runs.js';
import { adapterById } from '../adapters/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `mic-lab: measure a voice recording and tune the mic

  mic-lab analyze <take.wav>... [--use calls|youtube|twitch] [--guided | --room-tone <s>]
                  [--distance <in>] [--mic] [--no-save] [--json]
      Measure WAV files and save each as a run. Files saved by the page carry their segments and mic settings.
      --guided         the file follows the page's 43 s guided script
      --room-tone <s>  the first <s> seconds are silence, the rest is normal speech
      --mic            read the connected mic so findings include fixes for it
      --no-save        measure only, without adding a run

  mic-lab runs [--use <use>] [--json]          every saved run, newest first, with what changed
  mic-lab runs show <run> [--use <use>] [--json]
  mic-lab runs compare <run> <run> [<run>] [--use <use>] [--json]
  mic-lab runs rm <run>... [--json]
      <run> is a run number or id. Runs live in ${runsDirLabel()}
      (set MIC_LAB_HOME to move them). The page saves there too when it runs from mic-lab serve.

  mic-lab device list [--json]               supported mics that are plugged in
  mic-lab device status [--json]             read the mic's settings
  mic-lab device set key=value... [--json]   change settings, read back to confirm
      MV7:  mode=manual|auto position=near|far tone=natural|dark|bright gain=0..36 (1.5 dB steps)
            comp=off|light|medium|heavy hp=on|off pres=on|off muted=on|off
      MV7+: mode gain=0..36 comp hp hpf=0|75|150 tone=-10..10 limiter denoise popper muted (untested)
      --mic <id|serial>  pick a mic when several are connected

  mic-lab serve [--port 8417]   serve the page on http://localhost for Chrome, sharing the runs folder

analyze --json prints a "mic-lab/report@1" report, and runs are "mic-lab/run@1" records. AGENTS.md describes both.`;

function parseArgs(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2), next = argv[i + 1];
    if (['json', 'guided', 'no-save'].includes(k) || (k === 'mic' && (next == null || next.startsWith('--') || /\.wav$/i.test(next)))) o[k] = true;
    else { if (next == null) throw usage(`--${k} needs a value`); o[k] = next; i++; }
  }
  return { pos, o };
}
const usage = m => Object.assign(new Error(m), { usage: true });
const FLAGS = { analyze: ['use', 'guided', 'room-tone', 'distance', 'mic', 'no-save', 'json'], runs: ['use', 'json'], device: ['mic', 'json'], serve: ['port'] };
function checkFlags(cmd, o) {
  const bad = Object.keys(o).find(k => !(FLAGS[cmd] || []).includes(k));
  if (bad) throw usage(`${cmd} has no --${bad} option`);
  if (o.guided && o['room-tone'] != null) throw usage('Use --guided or --room-tone, not both');
  if (o.use && !PROFILES[o.use]) throw usage(`--use is one of ${Object.keys(PROFILES).join(', ')}`);
}

/* A small file store so the MV7 adapter remembers the last Manual compressor and EQ between runs */
const STORE = join(homedir(), '.config', 'mic-lab', 'state.json');
async function fileStore() {
  let data = {}; try { data = JSON.parse(await readFile(STORE, 'utf8')); } catch { }
  return { get: k => data[k], set: (k, v) => { data[k] = v; mkdir(dirname(STORE), { recursive: true }).then(() => writeFile(STORE, JSON.stringify(data, null, 2))).catch(() => {}); } };
}
async function withMic(which, fn) {
  const { openMic } = await import('./node-hid.js');
  const { adapter, device } = await openMic(typeof which === 'string' ? which : null, { store: await fileStore() });
  try { return await fn(adapter, device); } finally { await device.close(); }
}

/* ---------------- the runs folder: <id>.json beside <id>-1.wav, <id>-2.wav ---------------- */
function runsDir() {
  const env = process.env;
  return env.MIC_LAB_HOME ? join(resolve(env.MIC_LAB_HOME), 'runs') : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mic-lab', 'runs');
}
function runsDirLabel() { const d = runsDir(), h = homedir(); return d.startsWith(h + sep) ? '~' + d.slice(h.length) : d; }
async function writeAtomic(path, data) { const tmp = `${path}.tmp-${process.pid}-${Date.now()}`; await writeFile(tmp, data); await rename(tmp, path); }
async function loadRuns() {
  const dir = runsDir(), runs = [], skipped = [];
  let names = []; try { names = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const f of names.filter(n => /^\d{8}-\d{6}-[a-z0-9]{4}\.json$/.test(n)).sort()) {
    try { const rec = checkRun(JSON.parse(await readFile(join(dir, f), 'utf8'))); runs.push({ rec, run: unpackRun(rec) }); }
    catch (e) { skipped.push({ file: f, error: e.message }); }
  }
  runs.sort((a, b) => a.run.created - b.run.created);
  return { dir, runs, skipped };
}
async function saveRun(rec, audio = []) {
  const dir = runsDir(); await mkdir(dir, { recursive: true });
  for (const { name, bytes } of audio) await writeAtomic(join(dir, name), bytes);
  await writeAtomic(join(dir, rec.id + '.json'), JSON.stringify(rec, null, 1));
}
async function removeRun(id) {
  const dir = runsDir(); let n = 0;
  for (const f of await readdir(dir).catch(() => [])) if (f === id + '.json' || isAudioName(f, id)) { await unlink(join(dir, f)); n++; }
  return n > 0;
}
function findRun(runs, ref) {
  const r = /^\d+$/.test(ref) ? runs.find(x => x.run.n === Number(ref)) : runs.find(x => x.run.id === ref);
  if (!r) throw new Error(`No run ${ref}. "mic-lab runs" lists them.`);
  return r;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function marksFor(o, dur, info) {
  if (o.guided) { let t = 0; return PHASES.map(p => { const m = { id: p.id, start: t, end: Math.min(t + p.dur, dur) }; t += p.dur; return m; }); }
  if (o['room-tone'] != null) { const s = Number(o['room-tone']); if (!(s > 0 && s < dur)) throw usage('--room-tone must be a number of seconds shorter than the file'); return [{ id: 'silence', start: 0, end: s }, { id: 'normal', start: s, end: dur }]; }
  return info && Array.isArray(info.marks) ? info.marks : null;
}

/* Files from one sweep become one run. Every other file is a run of its own. A file already in a run is not added again. */
async function saveAnalyzed(takes, use, ctx) {
  const { runs } = await loadRuns(), saved = [];
  let n = runs.reduce((m, r) => Math.max(m, r.run.n), 0);
  const groups = [];
  for (const t of takes) { const g = t.meta.sweepId && groups.find(x => x[0].meta.sweepId === t.meta.sweepId); g ? g.push(t) : groups.push([t]); }
  for (const g of groups) {
    const dup = g.map(t => runs.find(r => r.run.takes.some(x => x.sha256 && x.sha256 === t.sha256))).find(Boolean);
    if (dup) { saved.push({ n: dup.run.n, id: dup.run.id, added: false }); continue; }
    const created = Math.min(...g.map(t => t.created)), id = newRunId(created), kind = g.length > 1 ? 'sweep' : g[0].kind;
    g.forEach((t, i) => { t.audio = audioName(id, i); });
    const best = g.reduce((b, t, i) => fitScore(t.a, use) > fitScore(g[b].a, use) ? i : b, 0);
    const rec = packRun({ id, n: ++n, created, kind, use, best, takes: g }, ctx);
    await saveRun(rec, g.map(t => ({ name: t.audio, bytes: t.bytes })));
    runs.push({ rec, run: unpackRun(rec) });
    saved.push({ n: rec.n, id, added: true });
  }
  return saved;
}

async function cmdAnalyze(files, o) {
  if (!files.length) throw usage('analyze needs at least one WAV file');
  const takes = [];
  for (const f of files) {
    const bytes = await readFile(f), w = decodeWav(bytes), info = w.info || {}, dur = w.data.length / w.fs, meta = { mode: 'file', ...(info.meta || {}) };
    if (o.distance != null) meta.distance = Number(o.distance);
    if (o.guided) meta.mode = 'guided';
    const marks = marksFor(o, dur, info);
    takes.push({
      name: info.name || basename(f).replace(/\.wav$/i, ''), created: info.created || (await stat(f)).mtimeMs, fs: w.fs, marks, meta,
      a: analyze(w.data, w.fs, marks), env: envelope(w.data, w.fs), bytes, sha256: sha256(bytes), kind: kindOf(meta.mode),
    });
  }
  const use = o.use || takes[0].meta.use || 'calls';
  const describeHw = (h, id) => { const a = adapterById(id) || adapterById(takes[0].meta.adapter); return a ? a.describe(h) : null; };
  const ctxFor = (adapter, now) => ({ profile: use, adapter, caps: adapter && adapter.caps, now, describe: adapter ? adapter.describe : h => describeHw(h), describeHw });
  const { rep, ctx } = o.mic ? await withMic(o.mic, async (adapter, d) => { const ctx = ctxFor(adapter, d.state); return { rep: report(takes, ctx), ctx }; })
    : (c => ({ rep: report(takes, c), ctx: c }))(ctxFor(null, null));
  if (!o['no-save']) rep.savedRuns = await saveAnalyzed(takes, use, ctx);
  const savedText = (rep.savedRuns || []).map(s => s.added ? `Saved as run ${s.n} in ${runsDirLabel()}` : `Already saved as run ${s.n}`).join('\n');
  return { rep, text: () => reportMarkdown(rep).replace(/\n```json[\s\S]*$/, '') + (savedText ? '\n' + savedText : '') };
}

async function cmdRuns([sub = 'list', ...refs], o) {
  const { dir, runs, skipped } = await loadRuns(), all = runs.map(r => r.run), use = o.use;
  const row = ({ rec, run }) => ({ n: run.n, id: run.id, createdAt: rec.createdAt, kind: run.kind, use: use || run.use, score: runScore(run, use), verdict: rec.verdict, mic: rec.mic ? rec.mic.text : null, input: rec.input, distanceIn: rec.distanceIn, changes: runLine(all, run), takes: run.takes.length });
  if (sub === 'list') {
    const out = runs.slice().reverse().map(row), w = Math.max(2, ...out.map(r => String(r.n).length));
    return {
      rep: { dir, runs: out, skipped },
      text: () => out.length ? out.map(r => `${String(r.n).padStart(w)}  ${when(r.createdAt)}  ${KINDS[r.kind].padEnd(13)} ${String(r.score).padStart(3)}  ${r.changes}`).join('\n') + (skipped.length ? `\n${skipped.length} file(s) skipped: ${skipped.map(s => s.file).join(', ')}` : '')
        : `No runs yet in ${runsDirLabel()}. Record on the page served by "mic-lab serve", or run "mic-lab analyze <file.wav>".`,
    };
  }
  if (sub === 'show') {
    if (refs.length !== 1) throw usage('runs show takes one run number or id');
    const r = findRun(runs, refs[0]), rec = use && use !== r.run.use ? packRun({ ...r.run, use }, { profile: use }) : r.rec;
    const files = { json: join(dir, r.run.id + '.json'), audio: r.run.takes.map(t => t.audio && join(dir, t.audio)) };
    const rep = report(r.run.takes, { profile: use || r.run.use, describeHw: (h, id) => { const a = adapterById(id); return a ? a.describe(h) : null; } });
    return { rep: { ...rec, files }, text: () => `Run ${r.run.n} · ${KINDS[r.run.kind]} · ${when(r.run.created)} · ${runLine(all, r.run)}\n` + reportMarkdown(rep).replace(/\n```json[\s\S]*$/, '').split('\n').slice(3).join('\n') + `\nFiles: ${files.json}` };
  }
  if (sub === 'compare') {
    if (refs.length < 2 || refs.length > 3) throw usage('runs compare takes two or three runs');
    const c = compareRuns(refs.map(x => findRun(runs, x).run), use);
    const v = x => x == null ? '—' : fmt(x, Number.isInteger(x) ? 0 : 1);
    return {
      rep: c,
      text: () => [`Runs ${c.runs.map(r => r.n).join(' → ')} for ${PROFILES[c.use].label}`, `Score ${c.runs.map(r => r.score).join(' → ')}`,
        c.changed.length ? 'Changed: ' + c.changed.map(x => `${x.label} ${x.values.map(y => y ?? '—').join(' → ')}`).join(' · ') : 'Changed: nothing in the setup',
        ...c.metrics.map(m => `  ${m.label.padEnd(17)} ${m.values.map(v).join(' → ').padEnd(20)} ${m.unit.padEnd(5)}${m.closer === true ? ' closer to target' : m.closer === false ? ' further from target' : ''}`)].join('\n'),
    };
  }
  if (sub === 'rm') {
    if (!refs.length) throw usage('runs rm takes one or more run numbers or ids');
    const targets = refs.map(x => findRun(runs, x).run), removed = [];
    for (const r of targets) if (await removeRun(r.id)) removed.push({ n: r.n, id: r.id });
    return { rep: { removed }, text: () => `Removed run${removed.length > 1 ? 's' : ''} ${removed.map(r => r.n).join(', ')}` };
  }
  throw usage('runs takes list, show, compare or rm');
}

async function cmdDevice([sub, ...rest], o) {
  if (sub === 'list') {
    const { listMics } = await import('./node-hid.js'), mics = await listMics();
    const out = mics.map(m => ({ adapter: m.adapter.id, name: m.adapter.name, tested: m.adapter.tested, product: m.product, serial: m.serial }));
    return { rep: { mics: out }, text: () => out.length ? out.map(m => `${m.name}${m.tested ? '' : ' (adapter untested)'} · ${m.adapter}${m.serial ? ' · serial ' + m.serial : ''}`).join('\n') : 'No supported mic is plugged in.' };
  }
  if (sub === 'status' || sub === 'set') {
    return withMic(o.mic, async (adapter, d) => {
      let state = d.state;
      if (sub === 'set') {
        if (!rest.length) throw usage('device set needs key=value settings');
        let target; try { target = adapter.parseSettings(rest); } catch (e) { throw usage(e.message); }
        state = await d.apply(target);
      }
      const rep = { mic: { adapter: adapter.id, name: adapter.name, tested: adapter.tested, settings: state, text: adapter.describe(state) } };
      return { rep, text: () => `${adapter.name}${adapter.tested ? '' : ' (adapter untested)'}: ${adapter.describe(state)}${state.locked ? ' · lock on' : ''}${state.muted ? ' · muted' : ''}${state.fw ? ' · firmware ' + state.fw : ''}` };
    });
  }
  throw usage('device takes list, status or set');
}

/* ---------------- serve: the page, plus /api for the runs folder ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const LIMIT = { json: 2 << 20, wav: 20 << 20 };
const fail = (status, message) => Object.assign(new Error(message), { status });
function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) return Promise.reject(fail(413, `Larger than ${max >> 20} MB`));
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { rej(fail(413, `Larger than ${max >> 20} MB`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
  });
}
/* Only the page this server serves may use the API: the Host must be this server (no DNS rebinding), and a
   browser request must come from the same origin. Writes need an Origin, so other sites can never send one. */
function guard(req, port) {
  const own = [`localhost:${port}`, `127.0.0.1:${port}`], origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if (!own.includes(req.headers.host)) throw fail(403, 'Wrong host');
  if (origin != null && !own.some(h => origin === 'http://' + h)) throw fail(403, 'Wrong origin');
  if (site != null && site !== 'same-origin' && site !== 'none') throw fail(403, 'Cross-site request');
  if (req.method !== 'GET' && origin == null) throw fail(403, 'Writes need the page\'s origin');
}
async function api(req, res, path, port) {
  guard(req, port);
  const dir = runsDir(), json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const [, kind, name] = /^\/api\/(runs|audio)(?:\/([^/]+))?$/.exec(path) || [];
  if (kind === 'runs' && !name && req.method === 'GET') { const { runs, skipped } = await loadRuns(); return json(200, { dir: runsDirLabel(), runs: runs.map(r => r.rec), skipped }); }
  if (kind === 'runs' && isRunId(name)) {
    if (req.method === 'PUT') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw fail(415, 'Send JSON');
      let rec; try { rec = checkRun(JSON.parse(await readBody(req, LIMIT.json))); } catch (e) { throw e.status ? e : fail(400, e.message); }
      if (rec.id !== name) throw fail(400, 'The id in the path and the record differ');
      await mkdir(dir, { recursive: true }); await writeAtomic(join(dir, name + '.json'), JSON.stringify(rec, null, 1));
      return json(200, { saved: name });
    }
    if (req.method === 'DELETE') return (await removeRun(name)) ? json(200, { removed: name }) : json(404, { error: 'No such run' });
  }
  if (kind === 'audio' && isAudioName(name)) {
    if (req.method === 'GET') { try { return res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }).end(await readFile(join(dir, name))); } catch { return json(404, { error: 'No such file' }); } }
    if (req.method === 'PUT') {
      const body = await readBody(req, LIMIT.wav);
      if (body.length < 44 || body.toString('latin1', 0, 4) !== 'RIFF' || body.toString('latin1', 8, 12) !== 'WAVE') throw fail(400, 'Not a WAV file');
      await mkdir(dir, { recursive: true }); await writeAtomic(join(dir, name), body);
      return json(200, { saved: name });
    }
  }
  throw fail(404, 'No such endpoint');
}
function cmdServe(o) {
  const want = Number(o.port ?? 8417);
  const srv = createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('Bad request'); return; }
    if (path.startsWith('/api/')) {
      try { await api(req, res, path, srv.address().port); }
      catch (e) {
        /* An unread body would be taken for the next request, so a refused upload closes the connection */
        if (e.status === 413) res.on('finish', () => req.destroy());
        if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'application/json', ...(e.status === 413 ? { connection: 'close' } : {}) }).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    const file = normalize(join(ROOT, path.replace(/\/$/, '/index.html')));
    if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body); }
    catch { res.writeHead(404).end('Not found'); }
  });
  srv.listen(want, '127.0.0.1', () => console.log(`Mic Tuning Lab: http://localhost:${srv.address().port}/  (Ctrl+C to stop)\nRuns folder: ${runsDirLabel()}`));
  return new Promise((_, reject) => srv.on('error', e => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${want} is in use. Try --port ${want + 1}.` : e.message))));
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2), { pos, o } = parseArgs(argv);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  if (FLAGS[cmd]) checkFlags(cmd, o);
  const r = cmd === 'analyze' ? await cmdAnalyze(pos, o) : cmd === 'runs' ? await cmdRuns(pos, o) : cmd === 'device' ? await cmdDevice(pos, o) : cmd === 'serve' ? await cmdServe(o) : (() => { throw usage(`Unknown command "${cmd}"`); })();
  console.log(o.json ? JSON.stringify(r.rep, null, 2) : r.text());
}

main().catch(e => {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: e.message }));
  else console.error((e.usage ? '' : 'Error: ') + e.message + (e.usage ? '\n\n' + HELP : ''));
  process.exit(e.usage ? 2 : 1);
});
