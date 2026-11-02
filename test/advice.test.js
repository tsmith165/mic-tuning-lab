import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../core/dsp.js';
import { findingsFor, fitScore, verdict, sweepPlan, snapGain, profileOf } from '../core/advice.js';
import mv7 from '../adapters/shure-mv7.js';
import mv7plus from '../adapters/shure-mv7plus.js';
import { FS, guidedTake } from './helpers.js';

const quiet = (() => { const { data, marks } = guidedTake({ gain: 0.12 }); return analyze(data, FS, marks); })();
const take = (a, hw, extra = {}) => ({ a, meta: { distance: 4, proc: { ec: false, ns: false, agc: false }, hw, ...extra } });
const ctx = now => ({ profile: 'calls', caps: mv7.caps, now, describe: mv7.describe });
const manual27 = { mode: 'manual', gain: 27, comp: 1, hp: true, pres: false, position: 'near', tone: 'natural' };

test('a quiet take at the current settings offers a gain fix', () => {
  const f = findingsFor(take(quiet, manual27), ctx(manual27)).find(x => x.id === 'too-quiet');
  assert.ok(f, 'too-quiet finding');
  assert.equal(f.sev, 'bad');
  assert.equal(f.fixes[0].set.mode, 'manual');
  assert.ok(f.fixes[0].set.gain > 27 && f.fixes[0].set.gain <= 36);
});

test('an old take never offers a gain change once the mic has moved on', () => {
  const now = { ...manual27, gain: 33 }, fs = findingsFor(take(quiet, manual27), ctx(now));
  assert.ok(fs.some(x => x.id === 'mic-changed'));
  assert.ok(!fs.find(x => x.id === 'too-quiet').fixes.length);
  const auto = { mode: 'auto', position: 'near', tone: 'natural', comp: 0 };
  assert.ok(findingsFor(take(quiet, manual27), ctx(auto)).every(x => x.fixes.every(fx => fx.set.gain == null)));
});

test('without hardware control the advice is in words only', () => {
  const fs = findingsFor(take(quiet, null), { profile: 'calls' });
  assert.ok(fs.length && fs.every(f => !f.fixes.length));
  assert.match(fs.find(f => f.id === 'too-quiet').detail, /Raise input gain about \d+ dB/);
});

test('fixes change one setting and use the mic as it is now', () => {
  const now = { ...manual27, hp: false, pres: true }, fs = findingsFor(take(quiet, now), ctx(now));
  const hp = fs.flatMap(f => f.fixes).find(x => x.label === 'High-pass on');
  assert.deepEqual(hp.set, { mode: 'manual', hp: true });
});

test('MV7+ fixes use its own controls', () => {
  const now = { mode: 'manual', gain: 30, comp: 1, hp: true, hpf: 75, popper: false, denoise: false, toneLevel: 0 };
  const fs = findingsFor(take(quiet, now), { profile: 'calls', caps: mv7plus.caps, now, describe: mv7plus.describe });
  const sets = fs.flatMap(f => f.fixes).map(x => x.set);
  assert.ok(sets.some(s => s.popper === true), 'popper stopper for plosives');
  assert.ok(sets.every(s => s.pres == null && s.position == null), 'no MV7-only settings');
  assert.equal(snapGain(30.7, mv7plus.caps), 30);
  assert.equal(snapGain(30.7, mv7.caps), 30);
  assert.equal(snapGain(31.6, mv7.caps), 31.5);
});

test('score falls with distance from the target, and the verdict leads with the worst problem', () => {
  const { data, marks } = guidedTake({ gain: 3 }), good = analyze(data, FS, marks);
  assert.ok(fitScore(good, 'calls') > fitScore(quiet, 'calls'));
  const v = verdict(take(quiet, manual27), ctx(manual27));
  assert.equal(v.title, 'Too quiet for calls');
  assert.ok(v.fixes.length <= 3);
  assert.equal(profileOf('meet').id, 'calls', 'old "meet" profile id still works');
});

test('the MV7 sweep keeps its seven steps', () => {
  const steps = sweepPlan({ caps: mv7.caps, start: manual27, distance: 4, profile: 'calls', takes: [] });
  assert.deepEqual(steps.map(s => s.label), ['Current settings', 'Auto Level Near · Natural', 'Auto Level Near · Dark', 'Auto Level Near · Bright', 'Manual · gain aimed at target', 'Manual · aimed gain · Medium compressor', 'Manual · aimed gain · Presence boost']);
  assert.deepEqual(steps[0].target([]), { mode: 'manual', position: 'near', tone: 'natural', gain: 27, comp: 1, hp: true, pres: false });
  const ref = { a: quiet, meta: { hw: manual27, proc: {}, distance: 4 } };
  const aimed = steps[4].target([ref]);
  assert.equal(aimed.gain, snapGain(27 + -9 - quiet.typPeak, mv7.caps));
  assert.equal(aimed.comp, 1);
});

test('a sweep that starts in Auto Level brings back the last Manual compressor and EQ', () => {
  const steps = sweepPlan({ caps: mv7.caps, start: { mode: 'auto', position: 'far', tone: 'dark', gain: 20, comp: 0, hp: false, pres: false }, distance: 10, profile: 'calls', takes: [], lastManual: { comp: 2, hp: true, pres: false } });
  assert.equal(steps[1].label, 'Auto Level Far · Natural');
  const m = steps[4].target([]);
  assert.equal(m.comp, 2); assert.equal(m.hp, true);
  assert.equal(steps[5].label, 'Manual · aimed gain · Light compressor');
  assert.equal(steps[0].target([]).gain, undefined, 'Auto Level start does not pin a gain');
});

test('the MV7+ sweep uses the steps its controls allow', () => {
  const steps = sweepPlan({ caps: mv7plus.caps, start: { mode: 'manual', gain: 30, comp: 1, hp: true, hpf: 75, denoise: false }, distance: 4, profile: 'calls', takes: [] });
  assert.deepEqual(steps.map(s => s.label), ['Current settings', 'Auto Level', 'Manual · gain aimed at target', 'Manual · aimed gain · Medium compressor', 'Manual · aimed gain · Denoiser']);
});

test('every finding works with and without hardware, and fixes only use settings the mic has', () => {
  const extreme = over => ({ dur: 43, fs: FS, peak: -1, clips: 0, noise: -45, noiseContaminated: true, speech: -40, typPeak: -30, snr: 12, integrated: -30, lra: 15, lraScope: 'whole take', callLufs: -30, loudPeak: -2,
    rumbleShape: 25, phases: [{ id: 'normal', speech: -40, peak: -30, lufs: -30 }, { id: 'quiet', speech: -50, peak: -40, lufs: -40 }], plosives: [{ t: 1, excess: 15 }, { t: 2, excess: 18 }, { t: 3, excess: 12 }, { t: 4, excess: 20 }],
    sibPeak: 6, sibEvents: [], hum: { f0: 60, hits: 3, worst: 18 }, bands: { rel: { Rumble: 5, Body: 20, Mud: 5, Mid: 0, Presence: -25, Sibilance: -10, Air: -15 } }, ...over });
  const states = [null, { mode: 'manual', gain: 27, comp: 1, hp: false, pres: false, position: 'near', tone: 'natural', hpf: 0, toneLevel: 0, popper: false, denoise: false },
    { mode: 'auto', position: 'near', tone: 'natural', comp: 0, hp: false, pres: false, toneLevel: 0 }];
  for (const a of [extreme({}), extreme({ typPeak: -3, clips: 2 }), extreme({ typPeak: -2 })])
    for (const ad of [null, mv7, mv7plus]) for (const hw of states) for (const now of states) for (const profile of ['calls', 'youtube', 'twitch']) {
      const fs = findingsFor({ a, meta: { distance: 10, proc: { ec: true }, hw, hwChanged: true } }, { profile, caps: ad && ad.caps, now: ad && now, describe: ad ? ad.describe : () => '' });
      assert.ok(fs.length > 5);
      for (const f of fs) for (const x of f.fixes) for (const k of Object.keys(x.set)) assert.ok(ad && (ad.caps.settable.includes(k) || k === 'muted'), `${ad && ad.id} fix ${x.label} sets ${k}`);
    }
});

test('the verdict shows each fix once when two problems share it', () => {
  /* speech alone, with no segments: boomy and muffled both offer Presence */
  const { data, marks } = guidedTake(), n = marks.find(m => m.id === 'normal'), t = take(analyze(data.subarray(n.start * FS, n.end * FS), FS, null), manual27), all = findingsFor(t, ctx(manual27)).filter(f => f.sev === 'bad' || f.sev === 'warn').slice(0, 3).flatMap(f => f.fixes.map(x => x.label));
  const shown = verdict(t, ctx(manual27)).fixes.flatMap(f => f.fixes.map(x => x.label));
  assert.ok(all.length > new Set(all).size, 'this take has a shared fix to remove');
  assert.deepEqual(shown, [...new Set(all)]);
});

test('a take from another mic model never offers changes for the connected mic', () => {
  const t = take(quiet, { mode: 'manual', gain: 27, comp: 1, hp: true, hpf: 75 }, { adapter: 'shure-mv7plus' });
  const fs = findingsFor(t, { ...ctx(manual27), adapter: mv7, describeHw: (h, id) => (id === 'shure-mv7plus' ? mv7plus : mv7).describe(h) });
  assert.match(fs.find(f => f.id === 'mic-changed').detail, /on another mic Manual 27 dB · Comp Light · HPF 75 Hz/);
  assert.ok(fs.every(f => f.fixes.every(x => x.set.gain == null)));
});
