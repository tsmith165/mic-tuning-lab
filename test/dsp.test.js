import test from 'node:test';
import assert from 'node:assert/strict';
import { loudness, analyze, processChain, avgSpectrum, refCurve, bandLevels, REF_LTASS } from '../core/dsp.js';
import { FS, rng, sine, guidedTake } from './helpers.js';

test('BS.1770 loudness matches the reference tones', () => {
  assert.ok(Math.abs(loudness(sine(0.1, 1000, 5), FS).integrated - -23.0) < 0.1, '1 kHz at -20 dBFS reads -23.0 LUFS');
  assert.ok(Math.abs(loudness(sine(1, 1000, 5), FS).integrated - -3.01) < 0.05, 'full-scale 1 kHz reads -3.01 LUFS');
});

test('a guided take: hum, plosives and segment levels are found', () => {
  const { data, marks } = guidedTake(), a = analyze(data, FS, marks);
  assert.equal(a.hum && a.hum.f0, 60);
  assert.ok(a.plosives.length >= 15, `plosives ${a.plosives.length}`);
  assert.ok(a.noise < -62 && a.noise > -72, `noise ${a.noise}`);
  assert.equal(a.lraScope, 'normal voice');
  assert.deepEqual(a.phases.map(p => p.id), ['normal', 'quiet', 'plosive', 'sibilant', 'loud']);
  assert.ok(a.loudPeak > a.typPeak, 'projected segment peaks above normal speech');
});

test('the call level comes from normal speech, not the loud segment', () => {
  const { data, marks } = guidedTake(), a = analyze(data, FS, marks), loud = analyze(data, FS, null);
  assert.ok(a.typPeak < loud.typPeak - 3, `normal ${a.typPeak} vs whole take ${loud.typPeak}`);
});

test('noise spectra with different FFT sizes read the same density', () => {
  const r = rng(7), x = new Float32Array(FS * 4); for (let i = 0; i < x.length; i++) x[i] = r() * 0.01;
  const at = (n, k) => { const starts = []; for (let s = 0; s + n <= x.length; s += n / 2) starts.push(s); const sp = avgSpectrum(x, starts, n, FS); return 10 * Math.log10(sp.pow[Math.round(k * n / FS)]); };
  assert.ok(Math.abs(at(4096, 1000) - at(16384, 1000)) < 1.5);
});

test('the published speech average does not read as boomy or muffled', () => {
  const pts = []; for (let i = 0; i < 170; i++) pts.push({ f: 30 * Math.pow(16000 / 30, i / 169), db: 0 });
  const ref = refCurve(pts), interp = f => { const i = ref.findIndex(p => p.f >= f); return i <= 0 ? ref[0].db : ref[i - 1].db + (ref[i].db - ref[i - 1].db) * Math.log(f / ref[i - 1].f) / Math.log(ref[i].f / ref[i - 1].f); };
  const b = bandLevels(pts.map(p => ({ f: p.f, db: interp(Math.min(Math.max(p.f, REF_LTASS[0][0]), 16000)) })));
  assert.ok(b.rel.Body < 16 && b.rel.Presence > -22, JSON.stringify(b.rel));
});

test('the software chain lands on its loudness target and respects the ceiling', () => {
  const { data, marks } = guidedTake(), ch = { gateOn: true, gateOpen: -55, eqLow: -1, eqMid: 0, eqHigh: 1.5, compOn: true, thr: -22, ratio: 3, att: 6, rel: 80, target: -14, ceil: -1 };
  const r = processChain(data, FS, ch), b = analyze(r.data, FS, marks);
  assert.ok(Math.abs(b.integrated - -14) < 1 || r.peakLimited, `out ${b.integrated}`);
  assert.ok(b.peak <= -0.5, `peak ${b.peak}`);
});
