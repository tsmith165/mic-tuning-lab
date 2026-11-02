/* node-hid transport for the CLI. node-hid is an optional dependency: measuring files works without it. */
import { ADAPTERS, adapterFor } from '../adapters/index.js';

async function loadHid() {
  try { return (await import('node-hid')).default; }
  catch { throw new Error('Mic control needs the optional node-hid package. Run "npm install" in the mic-tuning-lab folder, then try again.'); }
}

/* Supported mics that are plugged in, one entry per mic (the HID interface its adapter talks to) */
async function listMics() {
  const HID = await loadHid(), seen = new Set(), out = [];
  for (const d of await HID.devicesAsync()) {
    const a = adapterFor(d); if (!a) continue;
    if (a.hid.usagePage && d.usagePage !== a.hid.usagePage) continue;
    const key = d.serialNumber || `${d.vendorId}:${d.productId}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ adapter: a, path: d.path, product: d.product, serial: d.serialNumber || null });
  }
  return out;
}

async function nodeHidTransport(path, numbered) {
  const HID = await loadHid(), dev = await HID.HIDAsync.open(path);
  let cb = null;
  dev.on('data', buf => { const b = new Uint8Array(buf); if (!cb) return; numbered ? cb(b[0], b.subarray(1)) : cb(0, b); });
  dev.on('error', () => {});
  return {
    send: (id, bytes) => dev.write([id, ...bytes]),
    onReport(f) { cb = f; },
    close: () => dev.close(),
  };
}

/* Open the first supported mic, or the one whose adapter id or serial matches `which` */
async function openMic(which, opts) {
  const mics = await listMics();
  const m = which ? mics.find(x => x.adapter.id === which || x.serial === which) : mics[0];
  if (!m) throw new Error(mics.length ? `No mic matches "${which}"` : `No supported mic found. Supported: ${ADAPTERS.map(a => a.name).join(', ')}. Quit MOTIV or any page that holds the mic, then try again.`);
  const t = await nodeHidTransport(m.path, !!m.adapter.hid.numbered);
  try { return { adapter: m.adapter, device: await m.adapter.open(t, opts) }; }
  catch (e) { await t.close(); throw e; }
}

export { listMics, openMic };
