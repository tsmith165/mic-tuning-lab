import test from 'node:test';
import assert from 'node:assert/strict';
import mv7, { MV7 } from '../adapters/shure-mv7.js';
import { fakeMv7, textTransport } from './helpers.js';

const open = async (mic, store) => mv7.open(mic.transport, { sleep: async () => {}, store });
const ms = t => new Promise(r => setTimeout(r, t));

test('changes unlock, apply, relock and keep the compressor and EQ', async () => {
  const mic = fakeMv7(), d = await open(mic);
  assert.equal(mv7.describe(d.state), 'Manual 27 dB · Comp Light · HPF');
  await d.apply({ mode: 'manual', gain: 30 });
  assert.deepEqual([mic.st.gain, mic.st.lock, mic.st.comp, mic.st.eq], [30, true, 1, 1]);
  await d.apply({ mode: 'manual', gain: 26 });
  assert.equal(mic.st.gain, 25.5, 'off-grid gain snaps down to the 1.5 dB grid');
  await d.apply({ mode: 'auto', position: 'far', tone: 'natural' });
  assert.equal(mic.st.mode, 5);
  await d.apply({ mode: 'manual', gain: 28.5 });
  assert.deepEqual([mic.st.mode, mic.st.gain, mic.st.comp, mic.st.eq, mic.st.lock], [1, 28.5, 1, 1, true], 'compressor and EQ come back after Auto Level reset them');
  await d.apply({ mode: 'manual', hp: true, pres: true });
  assert.equal(mic.st.eq, 3);
  await d.restore();
  assert.deepEqual([mic.st.gain, mic.st.mode, mic.st.comp, mic.st.eq, mic.st.lock], [27, 1, 1, 1, true]);
});

test('a fix changes one field and keeps the rest of the current state', async () => {
  const mic = fakeMv7({ eq: 2 }), d = await open(mic);
  await d.apply({ mode: 'manual', hp: true });
  assert.equal(mic.st.eq, 3, 'presence kept when only high-pass was asked');
});

test('a stale lock reading still unlocks: every change reads the mic first', async () => {
  const mic = fakeMv7(), d = await open(mic);
  d.state.locked = false;
  await d.apply({ mode: 'manual', gain: 33 });
  assert.deepEqual([mic.st.gain, mic.st.lock], [33, true]);
});

test('a change the mic acknowledges but ignores is reported', async () => {
  const mic = fakeMv7(), d = await open(mic);
  mic.reply = line => line.startsWith('setBlock 19') ? 'block 19 00000002\n' : mic.exec(line) + '\n';
  await assert.rejects(d.apply({ mode: 'manual', comp: 2 }), /did not take the change. It reads compressor Light/);
});

test('a failed getter leaves the field unknown instead of trusting an old value', async () => {
  const mic = fakeMv7(), d = await open(mic);
  d.state.gain = 30;
  mic.reply = line => line === 'inputGain' ? '[Failed]\n' : mic.exec(line) + '\n';
  await assert.rejects(d.apply({ mode: 'manual', gain: 30 }), /gain unreadable/);
});

test('a mode change waits for its own reply, about 200 ms after a gain notice', async () => {
  const t = textTransport(() => [[5, 'inputGain=27.00dB\n'], [200, 'dspMode=1\n']]), d = new MV7(t);
  const t0 = Date.now(), reply = await d.send('dspMode 01');
  assert.match(reply, /dspMode=1/);
  assert.ok(Date.now() - t0 >= 195);
});

test('the reply deadline starts at send, even when the write never settles', async () => {
  const t = textTransport(() => new Promise(() => {})), d = new MV7(t), t0 = Date.now();
  await d.send('dspMode');
  assert.ok(Date.now() - t0 < 2000);
});

test("an earlier command's timer never clears a later command", async () => {
  const t = textTransport(line => line === 'micMute' ? (setTimeout(() => t.emit('micMute=off\n'), 1), ms(50)) : [[20, 'dspMode=1\n']]), d = new MV7(t);
  await d.send('micMute'); await ms(1520);
  assert.match(await d.send('dspMode'), /dspMode=1/);
});

test('a reply split across two reports is read whole', async () => {
  const t = textTransport(() => [[1, 'inputGain=2'], [45, '7.00dB\n']]), d = new MV7(t);
  assert.equal((await d.send('inputGain')).trim(), 'inputGain=27.00dB');
});

test('a state read during a take reports the change, mute included', async () => {
  const mic = fakeMv7(), d = await open(mic), seen = [];
  d.onState = s => seen.push(mv7.describe(s) + (s.muted ? ' muted' : ''));
  await d.apply({ mode: 'manual', gain: 30 }); await d.apply({ mode: 'manual', gain: 27 }); await d.apply({ muted: true });
  assert.ok(seen.some(x => x.startsWith('Manual 30 dB')) && seen.some(x => x.endsWith('muted')));
});

test('the last Manual compressor and EQ are remembered across sessions', async () => {
  const mem = new Map(), store = { get: k => mem.get(k), set: (k, v) => mem.set(k, v) };
  const mic = fakeMv7({ comp: 2, eq: 3 }); await open(mic, store);
  assert.deepEqual(mem.get('shure-mv7.lastManual'), { comp: 2, hp: true, pres: true });
  const auto = fakeMv7({ mode: 2, comp: 0, eq: 0 }), d = await open(auto, store);
  await d.apply({ mode: 'manual' });
  assert.deepEqual([auto.st.comp, auto.st.eq], [2, 3]);
});

test('settings typed on the command line', () => {
  assert.deepEqual(mv7.parseSettings(['gain=36', 'comp=medium', 'hp=on']), { mode: 'manual', gain: 36, comp: 2, hp: true });
  assert.deepEqual(mv7.parseSettings(['tone=dark']), { mode: 'auto', tone: 'dark' });
  assert.throws(() => mv7.parseSettings(['denoise=on']), /has no setting "denoise"/);
});

test('a setting that cannot be read back fails the change instead of passing as off', async () => {
  const mic = fakeMv7(), d = await open(mic), base = mic.reply;
  mic.reply = line => line === 'getBlock 31' ? '[Failed]\n' : base(line);
  await assert.rejects(d.apply({ mode: 'manual', hp: false, pres: false }), /EQ unreadable/);
});

test('connecting needs every setting, so Restore has the full starting point', async () => {
  const mic = fakeMv7(), base = mic.reply; let misses = 1;
  mic.reply = line => line === 'inputGain' && misses-- > 0 ? '[Failed]\n' : base(line);
  const d = await open(mic);
  assert.equal(d.atConnect.gain, 27, 'one dropped reply is retried');
  mic.reply = line => line === 'inputGain' ? '[Failed]\n' : base(line);
  await assert.rejects(open(mic), /Could not read the mic's gain/);
});

test('a lock that does not come back on is reported', async () => {
  const mic = fakeMv7(), d = await open(mic), base = mic.reply;
  mic.reply = line => line === 'lock on' ? '[Failed]\n' : base(line);
  await assert.rejects(d.apply({ mode: 'manual', gain: 30 }), /did not lock its settings again/);
  assert.equal(mic.st.gain, 30);
});

test('typed settings reject anything that is not clearly on or off', () => {
  assert.throws(() => mv7.parseSettings(['muted=of']), /not on or off/);
  assert.deepEqual(mv7.parseSettings(['hp=off', 'pres=yes']), { hp: false, pres: true, mode: 'manual' });
});
