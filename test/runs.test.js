/* Runs: the record format, what changed between runs, the runs folder and the endpoints mic-lab serve adds */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../core/dsp.js';
import { fitScore, verdict } from '../core/advice.js';
import { encodeWav, quantize16 } from '../core/wav.js';
import { newRunId, isRunId, isAudioName, envelope, packRun, unpackRun, checkRun, diffSetups, changeLine, runLine, compareRuns } from '../core/runs.js';
import { tar, untar } from '../app/tar.js';
import { FS, guidedTake } from './helpers.js';

const hw = { mode: 'manual', gain: 27, comp: 2, hp: true, pres: false, position: 'near', tone: 'natural' };
const take = (o = {}) => {
  const { data, marks } = guidedTake({ gain: o.gain ?? 0.12 }), x = quantize16(data);
  return { name: 'T1', created: o.created ?? Date.UTC(2026, 10, 2, 11, 42), fs: FS, marks: o.free ? null : marks, a: analyze(x, FS, o.free ? null : marks), env: envelope(x, FS), meta: { mode: o.free ? 'free' : 'guided', hw: o.hw ?? hw, adapter: 'shure-mv7', device: 'Shure MV7', distance: o.distance ?? 4, proc: {} } };
};
const run = (n, t, kind = 'check') => ({ id: newRunId(t.created, () => n / 10), n, created: t.created, kind, use: 'calls', best: 0, takes: [t] });

test('run ids sort by time and only safe names pass', () => {
  const id = newRunId(Date.UTC(2026, 10, 2, 11, 42, 8), () => 0.5);
  assert.equal(id, '20261102-114208-iiii'); assert.ok(isRunId(id));
  for (const bad of ['../20261102-114208-iiii', '20261102-114208-IIII', '20261102-114208-iiii.json', '']) assert.equal(isRunId(bad), false, bad);
  assert.ok(isAudioName(id + '-1.wav', id));
  assert.equal(isAudioName('../' + id + '-1.wav'), false); assert.equal(isAudioName(id + '-1.wav', '20261102-114208-zzzz'), false);
});

test('a run survives JSON with the same score, verdict and missing values', () => {
  const t = take({ free: true }), r = run(1, t, 'free');
  assert.ok(Number.isNaN(t.a.loudPeak), 'a free take has no projected segment');
  const back = unpackRun(JSON.parse(JSON.stringify(packRun(r))));
  const b = back.takes[0];
  assert.ok(Number.isNaN(b.a.loudPeak), 'NaN comes back as NaN, not null');
  assert.equal(fitScore(b.a, 'youtube'), fitScore(t.a, 'youtube'));
  assert.deepEqual(verdict(b, { profile: 'twitch' }).findings.map(f => f.id), verdict(t, { profile: 'twitch' }).findings.map(f => f.id));
  assert.equal(b.env.rms.length, Math.ceil(t.a.dur * 25));
  assert.equal(back.created, r.created);
  assert.throws(() => checkRun({ ...packRun(r), takes: [{ ...packRun(r).takes[0], audio: '../../etc/passwd' }] }), /bad audio name/);
});

test('the run list says what changed since the run before on the same mic', () => {
  const a = take(), b = take({ hw: { ...hw, gain: 36 }, distance: 3, created: a.created + 6e5 }), c = take({ hw: { ...hw, gain: 36, pres: true }, distance: 3, created: a.created + 12e5 });
  const runs = [run(1, a), run(2, b), run(3, c)];
  assert.equal(runLine(runs, runs[0]), 'First run on this mic');
  assert.equal(runLine(runs, runs[1]), 'Gain 27 → 36 · 4 → 3 in');
  assert.equal(runLine(runs, runs[2]), 'Presence on');
  const auto = take({ hw: { mode: 'auto', position: 'near', tone: 'dark', gain: 20, comp: 2, hp: true, pres: false }, created: a.created + 18e5, distance: 3 });
  assert.equal(changeLine(diffSetups([c, auto]).changed, auto.meta.hw), 'Auto Level Near · Dark');
  const { changed, same } = diffSetups([a, c]);
  assert.deepEqual(changed.map(x => x.key), ['gain', 'pres', 'distance']);
  assert.ok(same.some(x => x.key === 'comp' && x.values[0] === 'Medium'));
});

test('compare reports the score and which way each metric moved for the chosen use', () => {
  const quiet = run(1, take({ gain: 0.05 })), loud = run(2, take({ gain: 0.2, hw: { ...hw, gain: 36 }, created: Date.UTC(2026, 10, 2, 12) }));
  const c = compareRuns([quiet, loud], 'youtube');
  assert.equal(c.use, 'youtube'); assert.equal(c.runs.length, 2);
  const pk = c.metrics.find(m => m.id === 'peaks');
  assert.deepEqual(pk.target, [-12, -6]);
  assert.ok(pk.values[1] > pk.values[0] && pk.closer === true, JSON.stringify(pk));
  assert.equal(c.metrics.find(m => m.id === 'snr').target[1], null, 'an open end is null in JSON');
  assert.deepEqual(c.changed.map(x => x.key), ['gain']);
});

/* ---------------- the CLI and its runs folder ---------------- */
const CLI = new URL('../cli/mic-lab.js', import.meta.url).pathname;
const home = () => mkdtempSync(join(tmpdir(), 'mic-lab-home-'));
const cli = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, MIC_LAB_HOME: env } });
function wavFile(dir, name, o = {}) {
  const { data, marks } = guidedTake({ gain: o.gain ?? 0.12 }), file = join(dir, name);
  const meta = { mode: 'guided', hw: o.hw ?? hw, adapter: 'shure-mv7', device: 'Shure MV7', distance: o.distance ?? 4, proc: {} };
  writeFileSync(file, encodeWav(data, FS, { name: name.replace('.wav', ''), created: o.created ?? Date.UTC(2026, 10, 2, 11, 42), marks, meta }, { bits: 16 }));
  return file;
}

test('analyze saves each file as a run once, and runs lists, shows, compares and removes them', () => {
  const H = home(), f1 = wavFile(H, 'a.wav'), f2 = wavFile(H, 'b.wav', { gain: 0.2, hw: { ...hw, gain: 36 }, distance: 3, created: Date.UTC(2026, 10, 2, 12) });
  const first = JSON.parse(cli(H, 'analyze', f1, '--json').stdout);
  assert.deepEqual(first.savedRuns.map(s => [s.n, s.added]), [[1, true]]);
  assert.deepEqual(JSON.parse(cli(H, 'analyze', f1, '--json').stdout).savedRuns.map(s => [s.n, s.added]), [[1, false]], 'the same file is not added twice');
  assert.equal(JSON.parse(cli(H, 'analyze', f2, '--no-save', '--json').stdout).savedRuns, undefined);
  cli(H, 'analyze', f2, '--json');
  const files = readdirSync(join(H, 'runs')).sort();
  assert.equal(files.filter(f => f.endsWith('.json')).length, 2); assert.equal(files.filter(f => f.endsWith('.wav')).length, 2);

  const list = JSON.parse(cli(H, 'runs', '--json').stdout);
  assert.deepEqual(list.runs.map(r => r.n), [2, 1], 'newest first');
  assert.equal(list.runs[0].changes, 'Gain 27 → 36 · 4 → 3 in'); assert.equal(list.runs[0].kind, 'check');
  assert.match(cli(H, 'runs').stdout, /^ {1,2}2 .*Quick check .*Gain 27 → 36/m);

  const shown = JSON.parse(cli(H, 'runs', 'show', '2', '--use', 'twitch', '--json').stdout);
  assert.equal(shown.schema, 'mic-lab/run@1'); assert.equal(shown.use, 'twitch'); assert.equal(shown.takes[0].use, 'twitch');
  assert.ok(shown.files.audio[0].endsWith('-1.wav'));

  const cmp = JSON.parse(cli(H, 'runs', 'compare', '1', '2', '--json').stdout);
  assert.deepEqual(cmp.runs.map(r => r.n), [1, 2]); assert.ok(cmp.metrics.find(m => m.id === 'peaks').closer);
  assert.match(cli(H, 'runs', 'compare', '1', '2').stdout, /Changed: Gain 27 dB → 36 dB · Distance 4 in → 3 in/);

  assert.equal(cli(H, 'runs', 'show', '9').status, 1);
  assert.equal(cli(H, 'runs', 'compare', '1').status, 2);
  assert.deepEqual(JSON.parse(cli(H, 'runs', 'rm', '1', '--json').stdout).removed.map(r => r.n), [1]);
  assert.equal(readdirSync(join(H, 'runs')).length, 2, 'run 1 and its WAV are gone');
});

/* ---------------- mic-lab serve /api ---------------- */
function serve(H) {
  const p = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env: { ...process.env, MIC_LAB_HOME: H } });
  const port = new Promise((res, rej) => { p.stdout.on('data', d => { const m = /localhost:(\d+)\//.exec(String(d)); if (m) res(Number(m[1])); }); p.on('exit', c => rej(new Error('exit ' + c))); });
  return { p, port };
}
const call = (port, method, path, { host = `127.0.0.1:${port}`, origin = `http://127.0.0.1:${port}`, type, body, length } = {}) => new Promise((res, rej) => {
  const headers = { host, ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}), ...(length != null ? { 'content-length': length } : {}) };
  const q = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); });
  q.on('error', e => e.code === 'ECONNRESET' || e.code === 'EPIPE' ? res({ status: 413 }) : rej(e));
  if (body != null && length == null) q.end(body); else q.end();
});

test('serve shares the runs folder with its own page and refuses everyone else', async () => {
  const H = home(), { p, port: portP } = serve(H);
  try {
    const port = await portP, t = take(), rec = packRun(run(1, t)), wav = Buffer.from(encodeWav(guidedTake({ gain: 0.12 }).data, FS, null, { bits: 16 }));
    const put = (path, o) => call(port, 'PUT', path, o);
    assert.equal((await call(port, 'GET', '/api/runs', { host: 'evil.example:80' })).status, 403, 'DNS rebinding');
    assert.equal((await call(port, 'GET', '/api/runs', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await put('/api/runs/' + rec.id, { origin: null, type: 'application/json', body: JSON.stringify(rec) })).status, 403, 'writes need an origin');
    assert.equal((await put('/api/runs/' + rec.id, { origin: 'http://localhost:1', type: 'application/json', body: JSON.stringify(rec) })).status, 403);
    assert.equal((await put('/api/runs/' + rec.id, { type: 'text/plain', body: JSON.stringify(rec) })).status, 415);
    assert.equal((await put('/api/runs/' + rec.id, { type: 'application/json', body: '{"schema":"other"}' })).status, 400);
    assert.equal((await put('/api/runs/..%2F' + rec.id, { type: 'application/json', body: JSON.stringify(rec) })).status, 404);
    assert.equal((await put('/api/audio/' + rec.id + '-1.wav', { type: 'audio/wav', length: 21 << 20 })).status, 413);
    assert.equal((await put('/api/audio/' + rec.id + '-1.wav', { type: 'audio/wav', body: 'not a wav file at all, but long enough to pass the size check' })).status, 400);

    assert.equal((await put('/api/runs/' + rec.id, { type: 'application/json', body: JSON.stringify(rec) })).status, 200);
    assert.equal((await put('/api/audio/' + rec.id + '-1.wav', { type: 'audio/wav', body: wav })).status, 200);
    const list = JSON.parse((await call(port, 'GET', '/api/runs', { host: `localhost:${port}`, origin: null })).body);
    assert.deepEqual(list.runs.map(r => r.id), [rec.id]);
    assert.ok((await call(port, 'GET', '/api/audio/' + rec.id + '-1.wav')).body.equals(wav));
    assert.equal(JSON.parse(cli(H, 'runs', '--json').stdout).runs[0].id, rec.id, 'the CLI sees what the page saved');
    assert.equal((await call(port, 'DELETE', '/api/runs/' + rec.id)).status, 200);
    assert.deepEqual(readdirSync(join(H, 'runs')), []);
  } finally { p.kill(); }
});

test('an export unpacks to the same files, and anything else is refused', () => {
  const files = [{ name: '20261102-114208-iiii.json', bytes: new TextEncoder().encode('{"n":1}') }, { name: '20261102-114208-iiii-1.wav', bytes: new Uint8Array(1300).map((_, i) => i % 251) }];
  const back = untar(tar(files));
  assert.deepEqual(back.map(f => f.name), files.map(f => f.name));
  back.forEach((f, i) => assert.deepEqual(f.bytes, files[i].bytes));
  assert.throws(() => untar(new Uint8Array(1024).fill(7)), /Not a tar file/);
});
