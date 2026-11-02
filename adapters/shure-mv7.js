/* Shure MV7 (original, USB 14ED:1012). Its HID interface (usage page 0xFF00) is a text shell: each 64-byte
   report carries a command line ending in "\n", and replies are "\n"-terminated lines that may span reports.
   Commands and replies were confirmed on firmware 0.0.52.0; see the README for sources.

   inputGain 0..36 in 1.5 dB steps (an off-grid value fails), dspMode 01 Manual, 02/03/04 Auto Near
   Natural/Dark/Bright, 05/06/07 Auto Far; getBlock/setBlock 19 = compressor 0..3, 31 = EQ bits (1 high-pass,
   2 presence); micMute on|off; lock on|off refuses every change with "Locked" while on. */

import { readAll, onOff } from './shared.js';

const TONES = ['natural', 'dark', 'bright'];
const COMP = ['Off', 'Light', 'Medium', 'Heavy'];
const hex8 = v => v.toString(16).toUpperCase().padStart(8, '0');
const snap = g => Math.min(36, Math.max(0, Math.floor(g / 1.5 + 1e-6) * 1.5));
const modeNumber = (mode, pos, tone) => mode === 'manual' ? 1 : (pos === 'far' ? 5 : 2) + Math.max(0, TONES.indexOf(tone));
const wait = ms => new Promise(r => setTimeout(r, ms));
const fmtGain = g => (Number.isInteger(g) ? String(g) : g.toFixed(1));

const caps = {
  mode: true, gain: { min: 0, max: 36, step: 1.5 }, comp: COMP, hp: true, pres: true, position: true, tones: TONES,
  settable: ['mode', 'position', 'tone', 'gain', 'comp', 'hp', 'pres'], manualKeep: ['comp', 'hp', 'pres'],
  sweepDefaults: { comp: 1, hp: true, pres: false },
};

function describe(s) {
  if (!s) return 'hardware unknown';
  if (s.mode === 'auto') return `Auto Level ${s.position} · ${s.tone}`;
  const eq = [s.hp && 'HPF', s.pres && 'Presence'].filter(Boolean).join('+');
  return `Manual ${s.gain == null ? '?' : fmtGain(s.gain)} dB · Comp ${COMP[s.comp] ?? '?'}${eq ? ' · ' + eq : ''}`;
}

class MV7 {
  /* transport: { send(reportId, Uint8Array), onReport(cb(reportId, Uint8Array)), close() }
     opts: { log(kind, text), store: { get(key), set(key, value) }, sleep(ms) } */
  constructor(transport, opts = {}) {
    this.t = transport; this.log = opts.log || (() => {}); this.store = opts.store || null; this.sleep = opts.sleep || wait;
    this.pending = null; this.tail = Promise.resolve(); this.busy = false; this.state = null; this.atConnect = null;
    this.lastManual = (this.store && this.store.get('shure-mv7.lastManual')) || null;
    this.onState = null; this.onNotify = null;
    this.dec = new TextDecoder('latin1');
    this.t.onReport((_, bytes) => this.rx(bytes));
  }
  rx(b) {
    let end = b.indexOf(0); if (end < 0) end = b.length;
    const t = this.dec.decode(b.subarray(0, end));
    if (this.pending) { this.pending.chunks.push(t); this.pending.bump(); }
    else if (t.trim()) { this.log('rx', t.trim()); if (this.onNotify) this.onNotify(t.trim()); }
  }
  /* Commands run one at a time. A reply is complete once the line for this command arrives ("name=..." or
     "block ID ..."), or [Failed] or Locked. Mode changes send a gain notification first and their own reply
     about 200 ms later. Only newline-terminated lines count, since a reply can span two reports. */
  send(line) { const run = () => this._send(line); const p = this.tail.then(run, run); this.tail = p.catch(() => {}); return p; }
  _send(line) {
    const blk = /^(?:get|set)Block\s+(\w+)/.exec(line), expect = blk ? `block ${blk[1]} ` : line.split(/\s/)[0] + '=';
    return new Promise((res, rej) => {
      const p = { chunks: [], over: false };
      const end = () => { p.over = true; clearTimeout(p.timer); clearTimeout(p.hard); if (this.pending === p) this.pending = null; };
      const fin = () => { if (p.over) return; end(); const txt = p.chunks.join(''), cut = txt.lastIndexOf('\n') + 1; this.log('rx', txt.trim() || '(no reply)'); res(txt.slice(0, cut)); };
      const done = () => { const txt = p.chunks.join(''); return txt.slice(0, txt.lastIndexOf('\n') + 1).split(/\r?\n/).some(l => { l = l.trim(); return l.startsWith(expect) || l === '[Failed]' || l === 'Locked'; }); };
      p.bump = () => { if (done()) { clearTimeout(p.timer); p.timer = setTimeout(fin, 15); } };
      this.pending = p; this.log('tx', line); p.hard = setTimeout(fin, 1500);
      const f = new Uint8Array(64); f.set(new TextEncoder().encode(line + '\n').subarray(0, 63));
      Promise.resolve().then(() => this.t.send(0, f)).catch(err => { if (p.over) return; end(); rej(err); });
    });
  }
  async query(cmd, prefix) {
    const t = await this.send(cmd);
    const line = t.split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith(prefix) || s === '[Failed]' || s === 'Locked');
    return line && line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
  }
  /* One change; throws when the mic refuses it so a caller never fails silently */
  async cmd(line) {
    const lines = (await this.send(line)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.includes('Locked')) throw new Error(`The MV7 refused "${line}": settings are locked`);
    if (lines.includes('[Failed]')) throw new Error(`The MV7 refused "${line}"`);
    return lines;
  }
  /* A fresh read. A getter that fails leaves its field unknown rather than keeping an old value. */
  async read() {
    const prev = this.state || {}, s = { fw: prev.fw, position: prev.position, tone: prev.tone };
    const mute = await this.query('micMute', 'micMute='); if (mute) s.muted = mute === 'on';
    const g = await this.query('inputGain', 'inputGain='); if (g) s.gain = parseFloat(g);
    const m = await this.query('dspMode', 'dspMode=');
    if (m) { const n = parseInt(m, 10); if (n === 1) s.mode = 'manual'; else if (n >= 2 && n <= 7) { s.mode = 'auto'; s.position = n >= 5 ? 'far' : 'near'; s.tone = TONES[n - (n >= 5 ? 5 : 2)]; } s.dspMode = n; }
    const c = await this.query('getBlock 19', 'block 19 '); if (c) s.comp = parseInt(c.slice(0, 8), 16);
    const e = await this.query('getBlock 31', 'block 31 '); if (e) { const v = parseInt(e.slice(0, 8), 16); s.hp = !!(v & 1); s.pres = !!(v & 2); }
    const lk = await this.query('lock', 'lock='); if (lk) s.locked = lk === 'on';
    if (!s.fw) s.fw = await this.query('fwVersion', 'fwVersion=');
    s.position = s.position || 'near'; s.tone = s.tone || 'natural';
    this.state = s;
    if (!this.atConnect) this.atConnect = { ...s };
    if (s.mode === 'manual' && !this.busy) { this.lastManual = { comp: s.comp, hp: s.hp, pres: s.pres }; if (this.store) this.store.set('shure-mv7.lastManual', this.lastManual); }
    if (this.onState) this.onState(s);
    return s;
  }
  /* The settings lock refuses every change, so unlock for the batch and put the lock back after */
  async batch(fn) {
    if (this.busy) return fn();
    await this.read();
    const relock = this.state.locked !== false;
    let out, err;
    this.busy = true;
    try { if (relock) await this.cmd('lock off'); out = await fn(); } catch (e) { err = e; }
    this.busy = false;
    if (relock) await this.send('lock on').catch(e => this.log('er', e.message));
    await this.read().catch(e => this.log('er', e.message));
    if (err) throw err;
    if (relock && this.state.locked !== true) throw new Error('The MV7 took the change but did not lock its settings again. Press Refresh to check.');
    return out;
  }
  /* Move the mic to a target state, sending only what differs, then read it back and compare.
     Leaving Auto Level resets the compressor to Off and EQ to flat (seen on firmware 0.0.52),
     so the last Manual compressor and EQ are put back unless the target sets them. */
  async apply(t) {
    await this.batch(async () => {
      const hw = this.state, mode = t.mode || hw.mode, pos = t.position || hw.position, tone = t.tone || hw.tone;
      const keep = hw.mode === 'manual' ? { comp: hw.comp, hp: hw.hp, pres: hw.pres } : (this.lastManual || {});
      const n = modeNumber(mode, pos, tone);
      if (n !== hw.dspMode) { await this.cmd(`dspMode ${String(n).padStart(2, '0')}`); await this.sleep(300); await this.read(); }
      const s = this.state, want = mode === 'manual' ? { comp: t.comp ?? keep.comp ?? s.comp, hp: !!(t.hp ?? keep.hp ?? s.hp), pres: !!(t.pres ?? keep.pres ?? s.pres) } : {};
      if (t.gain != null) want.gain = snap(t.gain);
      if (mode === 'manual') {
        if (want.gain != null && want.gain !== s.gain) await this.cmd(`inputGain ${fmtGain(want.gain)}`);
        if (want.comp !== s.comp) await this.cmd(`setBlock 19 ${hex8(want.comp)}`);
        if (want.hp !== !!s.hp || want.pres !== !!s.pres) await this.cmd(`setBlock 31 ${hex8((want.hp ? 1 : 0) | (want.pres ? 2 : 0))}`);
      }
      if (t.muted != null && t.muted !== s.muted) await this.cmd(`micMute ${t.muted ? 'on' : 'off'}`);
      const r = await this.read(), off = [];
      if (r.dspMode !== n) off.push(r.dspMode == null ? 'mode unreadable' : `mode ${r.dspMode}`);
      if (mode === 'manual') {
        if (want.gain != null && r.gain !== want.gain) off.push(r.gain == null ? 'gain unreadable' : `gain ${r.gain} dB`);
        if (r.comp == null || r.comp !== want.comp) off.push(r.comp == null ? 'compressor unreadable' : `compressor ${COMP[r.comp] ?? r.comp}`);
        if (r.hp == null) off.push('EQ unreadable');
        else if (r.hp !== want.hp || r.pres !== want.pres) off.push(`EQ ${[r.hp && 'high-pass', r.pres && 'presence'].filter(Boolean).join('+') || 'flat'}`);
      }
      if (t.muted != null && r.muted !== t.muted) off.push(`mute ${r.muted ? 'on' : 'off'}`);
      if (off.length) throw new Error(`The MV7 did not take the change. It reads ${off.join(', ')}.`);
    });
    return this.state;
  }
  restore() { const h = this.atConnect; return this.apply({ mode: h.mode, position: h.position, tone: h.tone, gain: h.mode === 'manual' ? h.gain : undefined, comp: h.comp, hp: h.hp, pres: h.pres, muted: h.muted }); }
  close() { return this.t.close(); }
}

/* Settings a person or agent can type, e.g. "gain=30 comp=medium hp=on". Returns a partial target state. */
function parseSettings(args) {
  const t = {}, on = onOff;
  for (const a of args) {
    const [k, v] = a.split('='); if (v == null) throw new Error(`Expected key=value, got "${a}"`);
    switch (k) {
      case 'mode': if (!/^(manual|auto)$/.test(v)) throw new Error('mode is manual or auto'); t.mode = v; break;
      case 'position': if (!/^(near|far)$/.test(v)) throw new Error('position is near or far'); t.position = v; t.mode = 'auto'; break;
      case 'tone': if (!TONES.includes(v)) throw new Error('tone is natural, dark or bright'); t.tone = v; t.mode = 'auto'; break;
      case 'gain': t.gain = Number(v); if (!Number.isFinite(t.gain)) throw new Error('gain is a number of dB'); t.mode = 'manual'; break;
      case 'comp': { const i = /^\d$/.test(v) ? +v : COMP.findIndex(c => c.toLowerCase() === v.toLowerCase()); if (!(i >= 0 && i <= 3)) throw new Error('comp is off, light, medium or heavy'); t.comp = i; t.mode = 'manual'; break; }
      case 'hp': t.hp = on(v); t.mode = 'manual'; break;
      case 'pres': t.pres = on(v); t.mode = 'manual'; break;
      case 'muted': case 'mute': t.muted = on(v); break;
      default: throw new Error(`The MV7 has no setting "${k}". Settings: mode, position, tone, gain, comp, hp, pres, muted`);
    }
  }
  return t;
}

export default {
  id: 'shure-mv7', name: 'Shure MV7', tested: true,
  hid: { vendorId: 0x14ed, productId: 0x1012, usagePage: 0xff00 },
  labelMatch: /\bMV7\b(?!\+)/i,
  caps, describe, parseSettings,
  async open(transport, opts) { const d = new MV7(transport, opts); await readAll(d, s => ['muted', 'mode', 'locked', ...(s.mode === 'manual' ? ['gain', 'comp', 'hp'] : [])]); return d; },
};
export { MV7, snap as snapMv7Gain };
