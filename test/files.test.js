/* WAV files, the JSON report, and the CLI that reads them */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../core/dsp.js';
import { encodeWav, decodeWav, quantize16 } from '../core/wav.js';
import { report, reportMarkdown, takeSummary, SCHEMA } from '../core/report.js';
import mv7 from '../adapters/shure-mv7.js';
import { FS, guidedTake } from './helpers.js';

const hw = { mode: 'manual', gain: 27, comp: 1, hp: true, pres: false, position: 'near', tone: 'natural' };

test('a saved take round-trips its samples and its segments', () => {
  const { data, marks } = guidedTake({ gain: 0.3 });
  const w = decodeWav(encodeWav(data, FS, { name: 'T1', marks, meta: { mode: 'guided', hw, adapter: 'shure-mv7', distance: 4 } }));
  assert.equal(w.fs, FS); assert.equal(w.data.length, data.length);
  assert.ok(w.data.every((v, i) => v === data[i]), 'float samples are exact');
  assert.deepEqual(w.info.marks, marks); assert.equal(w.info.meta.adapter, 'shure-mv7');
});

test('a 16-bit run file holds exactly the samples the page measured', () => {
  const { data, marks } = guidedTake({ gain: 0.3 }), x = quantize16(data), w = decodeWav(encodeWav(data, FS, { name: 'T1', marks }, { bits: 16 }));
  assert.equal(w.bits, 16); assert.deepEqual(w.info.marks, marks);
  assert.ok(w.data.every((v, i) => v === x[i]));
  assert.equal(analyze(w.data, FS, marks).typPeak, analyze(x, FS, marks).typPeak);
});

test('16-bit stereo PCM is read and mixed to mono', () => {
  const n = 100, b = new ArrayBuffer(44 + n * 4), v = new DataView(b), tag = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 44100 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, 16384, true); v.setInt16(46 + i * 4, 0, true); }
  const w = decodeWav(new Uint8Array(b));
  assert.equal(w.fs, 44100); assert.equal(w.channels, 2); assert.equal(w.data[5], 0.25);
});

test('the report carries metrics with units, findings and the command for each fix', () => {
  const { data, marks } = guidedTake({ gain: 0.12 }), t = { name: 'T1', created: 0, a: analyze(data, FS, marks), meta: { mode: 'guided', distance: 4, proc: {}, hw, adapter: 'shure-mv7' } };
  const rep = report([t], { profile: 'calls', adapter: mv7, caps: mv7.caps, now: hw, describe: mv7.describe });
  assert.equal(rep.schema, SCHEMA);
  const s = rep.takes[0];
  assert.equal(s.mic.text, 'Manual 27 dB · Comp Light · HPF');
  assert.ok(Number.isFinite(s.metrics.speechPeaksDbfs) && Number.isFinite(s.metrics.noiseFloorDbfs));
  const quiet = s.findings.find(f => f.id === 'too-quiet');
  assert.match(quiet.fixes[0].command, /^mic-lab device set mode=manual gain=\d+/);
  const md = reportMarkdown(rep);
  assert.ok(md.includes('```json') && JSON.parse(md.split('```json\n')[1].split('\n```')[0]).takes.length === 1);
  assert.equal(takeSummary(t, {}).findings.every(f => !f.fixes.length), true, 'no fixes without a connected mic');
});

/* Runs go to a scratch folder, never the real one */
const env = { ...process.env, MIC_LAB_HOME: mkdtempSync(join(tmpdir(), 'mic-lab-home-')) };
const cli = (...args) => spawnSync(process.execPath, [new URL('../cli/mic-lab.js', import.meta.url).pathname, ...args], { encoding: 'utf8', env });

test('mic-lab analyze reads a saved take and prints the same JSON the page copies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mic-lab-')), { data, marks } = guidedTake({ gain: 0.12 }), file = join(dir, 't1.wav');
  writeFileSync(file, encodeWav(data, FS, { name: 'T1', marks, meta: { mode: 'guided', hw, adapter: 'shure-mv7', distance: 4, proc: {} } }));
  const r = cli('analyze', file, '--json');
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout), s = rep.takes[0];
  assert.equal(s.take, 'T1'); assert.equal(s.mic.text, 'Manual 27 dB · Comp Light · HPF');
  assert.equal(s.metrics.speechPeaksDbfs, Math.round(analyze(data, FS, marks).typPeak * 10) / 10);
  assert.equal(s.segments.length, 5);
  const text = cli('analyze', file);
  assert.match(text.stdout, /score \d+/);
});

test('mic-lab analyze takes raw files with --guided or --room-tone, and explains bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mic-lab-')), { data } = guidedTake(), file = join(dir, 'raw.wav');
  writeFileSync(file, encodeWav(data, FS));
  assert.equal(JSON.parse(cli('analyze', file, '--guided', '--json').stdout).takes[0].segments.length, 5);
  assert.equal(JSON.parse(cli('analyze', file, '--room-tone', '5', '--use', 'twitch', '--json').stdout).use, 'twitch');
  const bad = cli('analyze', file, '--use', 'radio');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--use is one of calls, youtube, twitch/);
  assert.match(JSON.parse(cli('analyze', join(dir, 'missing.wav'), '--json').stdout).error, /ENOENT|no such file/);
});

test('mic-lab serve answers bad and outside paths without stopping', async () => {
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, [new URL('../cli/mic-lab.js', import.meta.url).pathname, 'serve', '--port', '0'], { env });
  try {
    const base = await new Promise((res, rej) => { p.stdout.on('data', d => { const m = /http:\/\/localhost:\d+\//.exec(String(d)); if (m) res(m[0]); }); p.on('exit', c => rej(new Error('exit ' + c))); });
    const get = path => new Promise((res, rej) => import('node:http').then(h => h.get(base.replace('localhost', '127.0.0.1') + path, r => { r.resume(); res(r.statusCode); }).on('error', rej)));
    assert.equal(await get('%'), 400);
    assert.equal(await get('..%2fpackage.json'), 403);
    assert.equal(await get(''), 200, 'still serving the page after both');
  } finally { p.kill(); }
});
