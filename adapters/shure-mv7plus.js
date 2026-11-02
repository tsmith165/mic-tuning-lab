/* Shure MV7+ (USB 14ED:1019). UNTESTED: nobody has run this adapter on an MV7+ yet. The packet layout,
   feature addresses and value encodings follow the MOTIV captures documented by shurectl (see the README),
   and the tests check this code against bytes captured from an MV7+. Please report what happens on yours.

   Binary protocol, report ID 0x01, 64-byte reports:
     [01][len][11 22][seq][hdr][08][n][70][n][cmd x3][prefix][addr x2][value...][crc hi][crc lo] then zeros
   len counts everything after itself up to the CRC; n = payload length + 5. hdr is 0x03 for GETs and
   CONFIRM and 0x00 for every MV7+ SET. CRC-16/ANSI (poly 0x8005 reflected, init 0) covers 11 22 up to the
   last value byte. Every SET is followed by a CONFIRM, which the mic answers with two acks. */

import { readAll, onOff } from './shared.js';

const COMP = ['Off', 'Light', 'Medium', 'Heavy'];
const CMD = { get: [0x01, 0x02, 0x02], set: [0x02, 0x02, 0x02], confirm: [0x01, 0x00, 0x00], getId: [0x01, 0x02, 0x01] };
const REPLY = new Set(['3,2,2', '4,2,2', '3,2,1', '4,2,1']);
const F = { gain: [0x01, 0x02], mute: [0x01, 0x04], hpf: [0x01, 0x06], limiter: [0x01, 0x51], denoise: [0x01, 0x58], comp: [0x01, 0x5c], auto: [0x01, 0x85], tone: [0x02, 0x04], popper: [0x03, 0x81], firmware: [0x00, 0x09] };
const HPF_HZ = [0, 75, 150];

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
  return crc;
}
/* One request as 64 bytes, report ID first */
function frame(seq, hdr, cmd, payload = []) {
  const n = payload.length + 5, inner = [0x11, 0x22, seq & 0xff, hdr, 0x08, n, 0x70, n, ...cmd, ...payload], crc = crc16(inner);
  const out = new Uint8Array(64); out.set([0x01, inner.length + 2, ...inner, crc >> 8, crc & 0xff]);
  return out;
}
/* A reply (report ID first) as { prefix, addr, value }, or null for acks, bad CRCs and anything else */
function parse(b) {
  if (!b || b.length < 18 || b[2] !== 0x11 || b[3] !== 0x22) return null;
  const end = b[1]; if (end < 16 || end + 2 > b.length) return null;
  if (crc16(b.subarray(2, end)) !== ((b[end] << 8) | b[end + 1])) return null;
  if (!REPLY.has(`${b[10]},${b[11]},${b[12]}`)) return null;
  return { prefix: b[13], addr: [b[14], b[15]], value: b.slice(16, end) };
}
const u16 = v => (v[0] << 8) | v[1], i16 = v => { const x = u16(v); return x & 0x8000 ? x - 0x10000 : x; };

const caps = {
  mode: true, gain: { min: 0, max: 36, step: 1 }, comp: COMP, hp: true, pres: false, position: false, tones: null,
  toneLevel: { min: -10, max: 10 }, popper: true, denoise: true, limiter: true,
  settable: ['mode', 'gain', 'comp', 'hp', 'hpf', 'limiter', 'denoise', 'popper', 'toneLevel'], manualKeep: ['comp', 'hp'],
  sweepDefaults: { comp: 1, hp: true },
};

function describe(s) {
  if (!s) return 'hardware unknown';
  const extra = [s.hp && `HPF ${s.hpf || 75} Hz`, s.denoise && 'Denoiser', s.popper && 'Popper stopper', s.limiter && 'Limiter', Number.isFinite(s.toneLevel) && s.toneLevel !== 0 && `Tone ${s.toneLevel > 0 ? '+' : ''}${s.toneLevel}`].filter(Boolean);
  const head = s.mode === 'auto' ? 'Auto Level' : `Manual ${s.gain ?? '?'} dB · Comp ${COMP[s.comp] ?? '?'}`;
  return [head, ...extra].join(' · ');
}

class MV7Plus {
  constructor(transport, opts = {}) {
    this.t = transport; this.log = opts.log || (() => {});
    this.seq = 0; this.inbox = []; this.waiter = null; this.tail = Promise.resolve();
    this.state = null; this.atConnect = null; this.onState = null; this.onNotify = null;
    this.t.onReport((id, bytes) => { const full = new Uint8Array(bytes.length + 1); full[0] = id; full.set(bytes, 1); this.inbox.push(full); if (this.waiter) this.waiter(); });
  }
  next(ms) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise(res => { const tm = setTimeout(() => { this.waiter = null; res(null); }, ms); this.waiter = () => { clearTimeout(tm); this.waiter = null; res(this.inbox.shift()); }; });
  }
  serial(fn) { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p; }
  async write(pkt) { this.log('tx', [...pkt.subarray(0, pkt[1] + 2)].map(x => x.toString(16).padStart(2, '0')).join(' ')); await this.t.send(0x01, pkt.subarray(1)); }
  /* GET one feature. Reports answering another address are strays from an earlier timeout and are skipped. */
  get(addr, cmd = CMD.get) {
    return this.serial(async () => {
      this.inbox.length = 0;
      await this.write(frame(this.seq++, 0x03, cmd, [0x00, ...addr]));
      for (let i = 0; i < 5; i++) {
        const report = await this.next(200); if (!report) break;
        const r = parse(report);
        if (r && r.addr[0] === addr[0] && r.addr[1] === addr[1]) return r.value;
      }
      this.log('er', `no reply for ${addr.map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
      return null;
    });
  }
  set(addr, value) {
    return this.serial(async () => {
      this.inbox.length = 0;
      await this.write(frame(this.seq++, 0x00, CMD.set, [0x00, ...addr, ...value]));
      await this.write(frame(this.seq++, 0x03, CMD.confirm));
      /* The ack and the echo of a changed value arrive within about 20 ms, in either order */
      for (let i = 0; i < 2; i++) if (!(await this.next(40))) break;
    });
  }
  async read() {
    const s = { fw: this.state && this.state.fw }, one = v => v && v.length ? v[0] : null;
    const g = await this.get(F.gain); if (g && g.length >= 2) s.gain = u16(g) / 100;
    const m = one(await this.get(F.mute)); if (m != null) s.muted = m === 1;
    const a = one(await this.get(F.auto)); if (a != null) s.mode = a === 1 ? 'auto' : 'manual';
    const h = one(await this.get(F.hpf)); if (h != null) { s.hpf = HPF_HZ[h] ?? h; s.hp = h !== 0; }
    const c = one(await this.get(F.comp)); if (c != null) s.comp = c;
    const l = one(await this.get(F.limiter)); if (l != null) s.limiter = l === 1;
    const d = one(await this.get(F.denoise)); if (d != null) s.denoise = d === 1;
    const p = one(await this.get(F.popper)); if (p != null) s.popper = p === 1;
    const t = await this.get(F.tone); if (t && t.length >= 2) s.toneLevel = Math.round(i16(t) / 10);
    if (!s.fw) { const v = await this.get(F.firmware, CMD.getId); if (v && v.length > 2 && u16(v) === v.length) s.fw = String.fromCharCode(...v.slice(2)).replace(/\0+$/, ''); }
    this.state = s;
    if (!this.atConnect) this.atConnect = { ...s };
    if (this.onState) this.onState(s);
    return s;
  }
  batch(fn) { return fn(); }
  /* Send what differs from the current state, then read back and compare */
  async apply(t) {
    const s = await this.read(), sets = [];
    const want = { ...t }; if (want.gain != null) want.gain = Math.min(36, Math.max(0, Math.floor(want.gain + 1e-6)));
    if (want.toneLevel != null) want.toneLevel = Math.max(-10, Math.min(10, Math.round(want.toneLevel)));
    if (want.hp != null && want.hpf == null) want.hpf = want.hp ? (s.hp ? s.hpf : 75) : 0;
    if (want.mode && want.mode !== s.mode) sets.push([F.auto, [want.mode === 'auto' ? 1 : 0]]);
    if (want.gain != null && want.gain !== s.gain) { const v = Math.round(want.gain * 100); sets.push([F.gain, [v >> 8, v & 0xff]]); }
    if (want.comp != null && want.comp !== s.comp) sets.push([F.comp, [want.comp]]);
    if (want.hpf != null && want.hpf !== s.hpf) sets.push([F.hpf, [Math.max(0, HPF_HZ.indexOf(want.hpf))]]);
    for (const k of ['limiter', 'denoise', 'popper', 'muted']) if (want[k] != null && !!want[k] !== !!s[k]) sets.push([F[k === 'muted' ? 'mute' : k], [want[k] ? 1 : 0]]);
    if (want.toneLevel != null && want.toneLevel !== s.toneLevel) { const v = (Math.max(-10, Math.min(10, Math.round(want.toneLevel))) * 10) & 0xffff; sets.push([F.tone, [v >> 8, v & 0xff]]); }
    for (const [addr, value] of sets) await this.set(addr, value);
    const r = await this.read(), off = [];
    for (const k of ['mode', 'gain', 'comp', 'hpf', 'limiter', 'denoise', 'popper', 'muted', 'toneLevel']) {
      if (want[k] == null) continue;
      if (r[k] !== want[k]) off.push(r[k] == null ? `${k} unreadable` : `${k} ${r[k]}`);
    }
    if (off.length) throw new Error(`The MV7+ did not take the change. It reads ${off.join(', ')}.`);
    return r;
  }
  restore() { const h = this.atConnect; return this.apply({ mode: h.mode, gain: h.mode === 'manual' ? h.gain : undefined, comp: h.comp, hpf: h.hpf, limiter: h.limiter, denoise: h.denoise, popper: h.popper, toneLevel: h.toneLevel, muted: h.muted }); }
  close() { return this.t.close(); }
}

function parseSettings(args) {
  const t = {}, on = onOff;
  for (const a of args) {
    const [k, v] = a.split('='); if (v == null) throw new Error(`Expected key=value, got "${a}"`);
    switch (k) {
      case 'mode': if (!/^(manual|auto)$/.test(v)) throw new Error('mode is manual or auto'); t.mode = v; break;
      case 'gain': t.gain = Number(v); if (!Number.isFinite(t.gain)) throw new Error('gain is a number of dB'); t.mode = 'manual'; break;
      case 'comp': { const i = /^\d$/.test(v) ? +v : COMP.findIndex(c => c.toLowerCase() === v.toLowerCase()); if (!(i >= 0 && i <= 3)) throw new Error('comp is off, light, medium or heavy'); t.comp = i; break; }
      case 'hp': t.hp = on(v); break;
      case 'hpf': t.hpf = Number(v); if (!HPF_HZ.includes(t.hpf)) throw new Error('hpf is 0, 75 or 150'); break;
      case 'tone': case 'toneLevel': t.toneLevel = Number(v); if (!(Number.isInteger(t.toneLevel) && t.toneLevel >= -10 && t.toneLevel <= 10)) throw new Error('tone is a whole number from -10 to 10'); break;
      case 'limiter': case 'denoise': case 'popper': t[k] = on(v); break;
      case 'muted': case 'mute': t.muted = on(v); break;
      default: throw new Error(`The MV7+ has no setting "${k}". Settings: mode, gain, comp, hp, hpf, tone, limiter, denoise, popper, muted`);
    }
  }
  return t;
}

export default {
  id: 'shure-mv7plus', name: 'Shure MV7+', tested: false,
  hid: { vendorId: 0x14ed, productId: 0x1019, numbered: true },
  labelMatch: /MV7\+/i,
  caps, describe, parseSettings,
  async open(transport, opts) { const d = new MV7Plus(transport, opts); await readAll(d, () => ['gain', 'muted', 'mode', 'hpf', 'comp', 'limiter', 'denoise', 'popper', 'toneLevel']); return d; },
};
export { MV7Plus, frame, parse, crc16 };
