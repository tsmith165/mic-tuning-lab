import test from 'node:test';
import assert from 'node:assert/strict';
import mv7plus, { frame, parse, crc16 } from '../adapters/shure-mv7plus.js';
import { fakeMv7Plus } from './helpers.js';

/* Bytes captured from real hardware with MOTIV, as published in shurectl's tests (up to the CRC; the rest is zeros) */
const pad = b => { const u = new Uint8Array(64); u.set(b); return u; };
const CAPTURED = {
  mv7plusMicLevelGet: [0x01, 0x10, 0x11, 0x22, 0xd5, 0x03, 0x08, 0x08, 0x70, 0x08, 0x01, 0x02, 0x02, 0x00, 0x01, 0x86, 0x90, 0x39],
  mv7plusMicLevelReply: [0x01, 0x11, 0x11, 0x22, 0x0a, 0x03, 0x08, 0x09, 0x70, 0x09, 0x03, 0x02, 0x02, 0x00, 0x01, 0x86, 0x63, 0x6c, 0x88],
  mvx2uGen2SetHdr0: [0x01, 0x11, 0x11, 0x22, 0xef, 0x00, 0x08, 0x09, 0x70, 0x09, 0x02, 0x02, 0x02, 0x00, 0x01, 0x86, 0x63, 0xcc, 0xee],
  setGain30Hdr3: [0x01, 0x12, 0x11, 0x22, 0x05, 0x03, 0x08, 0x0a, 0x70, 0x0a, 0x02, 0x02, 0x02, 0x00, 0x01, 0x02, 0x0b, 0xb8, 0x8a, 0xd6],
  confirm: [0x01, 0x0d, 0x11, 0x22, 0x05, 0x03, 0x08, 0x05, 0x70, 0x05, 0x01, 0x00, 0x00, 0x8b, 0x16],
};

test('packets match bytes captured from real Shure mics', () => {
  assert.deepEqual(frame(0xd5, 0x03, [1, 2, 2], [0x00, 0x01, 0x86]), pad(CAPTURED.mv7plusMicLevelGet));
  assert.deepEqual(frame(0xef, 0x00, [2, 2, 2], [0x00, 0x01, 0x86, 99]), pad(CAPTURED.mvx2uGen2SetHdr0));
  assert.deepEqual(frame(0x05, 0x03, [2, 2, 2], [0x00, 0x01, 0x02, 0x0b, 0xb8]), pad(CAPTURED.setGain30Hdr3));
  assert.deepEqual(frame(0x05, 0x03, [1, 0, 0]), pad(CAPTURED.confirm));
});

test('a captured MV7+ reply parses, and a corrupted one is rejected', () => {
  const r = parse(pad(CAPTURED.mv7plusMicLevelReply));
  assert.deepEqual([r.prefix, r.addr, [...r.value]], [0, [0x01, 0x86], [99]]);
  const bad = pad(CAPTURED.mv7plusMicLevelReply); bad[16] = 98;
  assert.equal(parse(bad), null);
  assert.equal(crc16([]), 0);
});

test('reads the state, and every SET uses header 0x00 and is confirmed', async () => {
  const mic = fakeMv7Plus(), d = await mv7plus.open(mic.transport);
  assert.equal(mv7plus.describe(d.state), 'Manual 27 dB · Comp Light · HPF 75 Hz · Denoiser');
  assert.equal(d.state.fw, '1.6.0');
  await d.apply({ mode: 'manual', gain: 33, popper: true, toneLevel: -3 });
  assert.equal(d.state.gain, 33); assert.equal(d.state.popper, true); assert.equal(d.state.toneLevel, -3);
  const sets = mic.log.filter(l => l.startsWith('set '));
  assert.deepEqual(sets, ['set 1,2 hdr0 12,228', 'set 3,129 hdr0 1', 'set 2,4 hdr0 255,226']);
  assert.equal(mic.log.filter(l => l === 'confirm').length, 3);
  assert.ok(mic.log.filter(l => l.startsWith('get ')).every(l => l.endsWith('hdr3')));
});

test('high-pass maps to 75 Hz, and an ignored SET is reported', async () => {
  const mic = fakeMv7Plus({ '1,6': [0] }), d = await mv7plus.open(mic.transport);
  await d.apply({ hp: true });
  assert.equal(d.state.hpf, 75);
  mic.ignore.add('1,92');
  await assert.rejects(d.apply({ comp: 3 }), /MV7\+ did not take the change. It reads comp 1/);
});

test('switching to Auto Level and back', async () => {
  const mic = fakeMv7Plus(), d = await mv7plus.open(mic.transport);
  await d.apply({ mode: 'auto' }); assert.equal(d.state.mode, 'auto'); assert.equal(mv7plus.describe(d.state).split(' · ')[0], 'Auto Level');
  await d.restore(); assert.equal(d.state.mode, 'manual'); assert.equal(d.state.gain, 27);
});

test('settings typed on the command line', () => {
  assert.deepEqual(mv7plus.parseSettings(['gain=30', 'hpf=150', 'tone=-2', 'denoise=on']), { mode: 'manual', gain: 30, hpf: 150, toneLevel: -2, denoise: true });
  assert.throws(() => mv7plus.parseSettings(['pres=on']), /has no setting "pres"/);
});

test('an unreadable setting fails the change and the connection', async () => {
  const mic = fakeMv7Plus({ '1,81': [1] }), d = await mv7plus.open(mic.transport);
  mic.silent.add('1,81'); mic.ignore.add('1,81');
  await assert.rejects(d.apply({ limiter: false }), /limiter unreadable/);
  await assert.rejects(mv7plus.open(mic.transport), /Could not read the mic's limiter/);
  assert.throws(() => mv7plus.parseSettings(['tone=1.5']), /whole number/);
  assert.throws(() => mv7plus.parseSettings(['denoise=banana']), /not on or off/);
});
