/* WAV files. Runs are saved as 16-bit mono and measured after the same rounding, so the page and the CLI
   measure exactly the same samples. An "mlab" chunk holds the take's segment marks and mic settings as JSON,
   and other players skip it. decodeWav reads 8/16/24/32-bit PCM and 32/64-bit float, mixing channels to mono. */

/* Rounds samples the way a 16-bit file stores them, so a take analysed before saving matches the file */
const to16 = v => Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
function quantize16(x) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = to16(x[i]) / 32768; return y; }

function encodeWav(data, fs, info = null, { bits = 32 } = {}) {
  const json = info ? new TextEncoder().encode(JSON.stringify({ schema: 'mic-lab/wav@1', ...info })) : null, pcm = bits === 16;
  const bps = pcm ? 2 : 4, fmtLen = pcm ? 16 : 18, fact = pcm ? 0 : 12;
  const meta = json ? 8 + json.length + (json.length & 1) : 0, n = data.length, size = 12 + 8 + fmtLen + fact + 8 + n * bps + meta;
  const b = new ArrayBuffer(size), v = new DataView(b), u = new Uint8Array(b);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, size - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, fmtLen, true); v.setUint16(20, pcm ? 1 : 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * bps, true); v.setUint16(32, bps, true); v.setUint16(34, bps * 8, true);
  let o = 20 + fmtLen;
  if (!pcm) { v.setUint16(36, 0, true); tag(o, 'fact'); v.setUint32(o + 4, 4, true); v.setUint32(o + 8, n, true); o += 12; }
  if (json) { tag(o, 'mlab'); v.setUint32(o + 4, json.length, true); u.set(json, o + 8); o += meta; }
  tag(o, 'data'); v.setUint32(o + 4, n * bps, true); o += 8;
  if (pcm) for (let i = 0; i < n; i++, o += 2) v.setInt16(o, to16(data[i]), true);
  else for (let i = 0; i < n; i++, o += 4) v.setFloat32(o, data[i], true);
  return u;
}

function decodeWav(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const tag = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let fmt = null, data = null, info = null;
  for (let o = 12; o + 8 <= u.length;) {
    const id = tag(o), len = v.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && len >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), fs: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') data = { at: body, len: Math.min(len, u.length - body) };
    else if (id === 'mlab') { try { info = JSON.parse(new TextDecoder().decode(u.subarray(body, body + len))); } catch { info = null; } }
    o = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV file has no fmt or data chunk');
  const { format, channels, bits, fs } = fmt, bps = bits / 8, frames = Math.floor(data.len / (bps * channels)), x = new Float32Array(frames);
  const read = format === 3 ? (bits === 64 ? o => v.getFloat64(o, true) : o => v.getFloat32(o, true))
    : format === 1 ? bits === 8 ? o => (v.getUint8(o) - 128) / 128 : bits === 16 ? o => v.getInt16(o, true) / 32768
      : bits === 24 ? o => ((v.getUint8(o) | v.getUint8(o + 1) << 8 | v.getInt8(o + 2) << 16)) / 8388608 : o => v.getInt32(o, true) / 2147483648 : null;
  if (!read || ![8, 16, 24, 32, 64].includes(bits)) throw new Error(`Unsupported WAV format ${format}, ${bits}-bit`);
  for (let f = 0, o = data.at; f < frames; f++) { let s = 0; for (let c = 0; c < channels; c++, o += bps) s += read(o); x[f] = s / channels; }
  return { data: x, fs, channels, bits, info };
}

export { encodeWav, decodeWav, quantize16 };
