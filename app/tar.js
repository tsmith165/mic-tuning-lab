/* A small tar writer and reader. Export packs the same files the runs folder holds (<id>.json beside <id>-1.wav),
   so an export unpacked into ~/.local/share/mic-lab/runs is visible to "mic-lab runs". */
const te = new TextEncoder(), td = new TextDecoder();
const octal = (v, len) => v.toString(8).padStart(len - 1, '0') + '\0';

/* files: [{ name, bytes, mtime }] */
function tar(files) {
  const out = new Uint8Array(files.reduce((s, f) => s + 512 + Math.ceil(f.bytes.length / 512) * 512, 1024));
  let o = 0;
  for (const f of files) {
    const h = out.subarray(o, o + 512), put = (s, at, len) => h.set(te.encode(s).subarray(0, len), at);
    put(f.name, 0, 100); put(octal(0o644, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
    put(octal(f.bytes.length, 12), 124, 12); put(octal(Math.floor((f.mtime ?? Date.now()) / 1000), 12), 136, 12);
    put('        ', 148, 8); h[156] = 0x30; put('ustar\0', 257, 6); put('00', 263, 2);
    put(octal(h.reduce((s, b) => s + b, 0), 7) + ' ', 148, 8);
    out.set(f.bytes, o + 512); o += 512 + Math.ceil(f.bytes.length / 512) * 512;
  }
  return out;
}

/* Regular files only, by their base name. Throws on anything that is not a tar file. */
function untar(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), files = [];
  for (let o = 0; o + 512 <= u.length;) {
    const h = u.subarray(o, o + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, n) => td.decode(h.subarray(a, a + n)).replace(/\0[\s\S]*$/, '').trim();
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const size = parseInt(str(124, 12), 8);
    if (parseInt(str(148, 8), 8) !== sum || !(size >= 0)) throw new Error('Not a tar file');
    if (h[156] === 0x30 || h[156] === 0) files.push({ name: str(0, 100).split('/').pop(), bytes: u.slice(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export { tar, untar };
