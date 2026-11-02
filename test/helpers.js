/* Shared test fixtures: synthetic takes and simulated mics */
import { PHASES } from '../core/dsp.js';
import { crc16 } from '../adapters/shure-mv7plus.js';

const FS = 48000;
function rng(seed = 1) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }; }
const sine = (amp, f, sec, fs = FS) => { const x = new Float32Array(fs * sec); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / fs); return x; };
const guidedMarks = () => { let t = 0; return PHASES.map(p => { const m = { id: p.id, start: t, end: t + p.dur }; t += p.dur; return m; }); };

/* A 43 s guided take: -70 dBFS noise with 60 Hz hum, harmonic "vowel" bursts per segment, plosive and S bursts.
   gain scales the voice so a test can make it quiet or hot. */
function guidedTake({ gain = 1, hum = true, seed = 1 } = {}) {
  const rnd = rng(seed), N = FS * 43, x = new Float32Array(N), marks = guidedMarks();
  for (let i = 0; i < N; i++) x[i] = rnd() * 0.00055 + (hum ? 0.0003 * Math.sin(2 * Math.PI * 60 * i / FS) + 0.00015 * Math.sin(2 * Math.PI * 180 * i / FS) : 0);
  for (const m of marks) {
    if (m.id === 'silence') continue;
    const amp = gain * { normal: 0.08, quiet: 0.01, plosive: 0.08, sibilant: 0.08, loud: 0.2 }[m.id];
    for (let s = m.start * FS; s < m.end * FS; s += FS * 0.3) {
      const len = FS * 0.22;
      for (let i = 0; i < len && s + i < N; i++) { const env = Math.sin(Math.PI * i / len); let v = 0; for (let h = 1; h < 12; h++) v += Math.sin(2 * Math.PI * 120 * h * (s + i) / FS) / h; x[s + i] += amp * env * v * 0.5; }
      if (m.id === 'plosive') for (let i = 0; i < FS * 0.03; i++) x[s + i] += gain * 0.4 * Math.sin(2 * Math.PI * 50 * i / FS) * Math.exp(-i / (FS * 0.01));
      if (m.id === 'sibilant') { let hp = 0, prev = 0; for (let i = 0; i < FS * 0.08; i++) { const r = rnd(); hp = 0.6 * (hp + r - prev); prev = r; x[s + len + i] += gain * 0.12 * hp; } }
    }
  }
  return { data: x, fs: FS, marks };
}

/* Simulated MV7 text shell, matching the real mic's replies on firmware 0.0.52.0 */
function fakeMv7(init = {}) {
  const st = { gain: 27, mode: 1, comp: 1, eq: 1, lock: true, mute: false, ...init }, log = [];
  const g = v => Number.isInteger(v) ? `${v}dB` : `${v.toFixed(2)}dB`, h = v => v.toString(16).toUpperCase().padStart(8, '0');
  function exec(line) {
    const [c, a, b] = line.trim().split(/\s+/); log.push(line.trim());
    const set = a !== undefined && c !== 'getBlock';
    if (set && c !== 'lock' && st.lock) return 'Locked';
    switch (c) {
      case 'lock': if (a) st.lock = a === 'on'; return `lock=${st.lock ? 'on' : 'off'}`;
      case 'micMute': if (a) st.mute = a === 'on'; return `micMute=${st.mute ? 'on' : 'off'}`;
      case 'inputGain': if (a) { if (st.mode !== 1) return 'Locked'; const v = parseFloat(a); if (Math.abs(v / 1.5 - Math.round(v / 1.5)) > 1e-9) return '[Failed]'; st.gain = v; } return `inputGain=${g(st.gain)}`;
      case 'dspMode': if (a) { const n = parseInt(a, 10), was = st.mode; st.mode = n; if (n === 1 && was !== 1) { st.comp = 0; st.eq = 0; return `inputGain=${g(st.gain)}\ndspMode=1`; } } return `dspMode=${st.mode}`;
      case 'getBlock': return `block ${a} ${h(a === '19' ? st.comp : st.eq)}`;
      case 'setBlock': { if (st.mode !== 1) return 'Locked'; const v = parseInt(b, 16), k = a === '19' ? 'comp' : 'eq'; if (st[k] === v) return '[Failed]'; st[k] = v; return `block ${a} ${b}`; }
      case 'fwVersion': return 'fwVersion=0.0.52.0';
    }
    return '[Failed]';
  }
  /* reply(line) may be overridden by a test to inject odd behaviour; it returns text or an array of [ms, text] */
  const mic = { st, log, exec, reply: line => exec(line) + '\n' };
  mic.transport = textTransport(line => mic.reply(line));
  return mic;
}
/* A transport around a function from a sent line to the reply chunks */
function textTransport(onLine) {
  let cb = null;
  const emit = txt => { const b = new Uint8Array(64); b.set(new TextEncoder().encode(txt).subarray(0, 64)); cb && cb(0, b); };
  return {
    emit,
    onReport(f) { cb = f; },
    send(_, bytes) {
      const line = new TextDecoder().decode(bytes).replace(/\0+$/, '').trim(), r = onLine(line);
      if (r && typeof r.then === 'function') return r;
      for (const [ms, txt] of Array.isArray(r) ? r : [[1, r]]) setTimeout(() => emit(txt), ms);
      return Promise.resolve();
    },
    close: async () => {},
  };
}

/* Simulated MV7+ speaking the binary protocol as shurectl documents it: replies to GETs, stores SETs, and after
   each CONFIRM sends an ack (09 00 00) and, when the value changed, an echo of the SET. Keys in `ignore` take
   a SET without changing, and keys in `silent` never answer a GET, to test readback. */
function fakeMv7Plus(init = {}) {
  const st = { '1,2': [0x0a, 0x8c], '1,4': [0], '1,6': [1], '1,81': [0], '1,88': [1], '1,92': [1], '1,133': [0], '2,4': [0, 0], '3,129': [0], ...init };
  const log = [], ignore = new Set(), silent = new Set();
  let cb = null, seq = 0x40, pendingEcho = null;
  const reply = (cmd, prefix, addr, value) => {
    const n = 3 + 3 + value.length + 2, inner = [0x11, 0x22, seq++ & 0xff, 0x03, 0x08, n, 0x70, n, ...cmd, prefix, ...addr, ...value], c = crc16(inner);
    const b = new Uint8Array(63); b.set([inner.length + 2, ...inner, c >> 8, c & 0xff]); return b;
  };
  const emit = (b, ms = 2) => setTimeout(() => cb && cb(0x01, b), ms);
  const transport = {
    onReport(f) { cb = f; },
    async send(id, bytes) {
      const b = new Uint8Array(64); b[0] = id; b.set(bytes, 1);
      const end = b[1]; if (crc16(b.subarray(2, end)) !== ((b[end] << 8) | b[end + 1])) { log.push('bad crc'); return; }
      const cmd = [b[10], b[11], b[12]], key = `${b[14]},${b[15]}`;
      if (cmd.join() === '1,0,0') { log.push('confirm'); emit(reply([9, 0, 0], 0, [0, 0], []), 3); if (pendingEcho) emit(pendingEcho, 6); pendingEcho = null; return; }
      if (cmd.join() === '1,2,2') { log.push(`get ${key} hdr${b[5]}`); if (st[key] && !silent.has(key)) emit(reply([3, 2, 2], b[13], [b[14], b[15]], st[key])); return; }
      if (cmd.join() === '1,2,1') { log.push(`getid ${key}`); if (key === '0,9') emit(reply([3, 2, 1], 0, [0, 9], [0, 7, ...new TextEncoder().encode('1.6.0')])); return; }
      if (cmd.join() === '2,2,2') { const value = [...b.subarray(16, end)]; log.push(`set ${key} hdr${b[5]} ${value.join(',')}`); const changed = String(st[key]) !== String(value); if (!ignore.has(key)) st[key] = value; pendingEcho = changed ? reply([4, 2, 2], b[13], [b[14], b[15]], value) : null; return; }
    },
    close: async () => {},
  };
  return { st, log, ignore, silent, transport };
}

export { FS, rng, sine, guidedMarks, guidedTake, fakeMv7, textTransport, fakeMv7Plus };
