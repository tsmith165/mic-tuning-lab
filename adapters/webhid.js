/* WebHID transport for Chrome and Edge */
import { adapterFor, hidFilters } from './index.js';

function webhidTransport(dev) {
  let cb = null;
  const h = e => cb && cb(e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
  return {
    device: dev,
    async open() { if (!dev.opened) await dev.open(); dev.addEventListener('inputreport', h); },
    send: (id, bytes) => dev.sendReport(id, bytes),
    onReport(f) { cb = f; },
    async close() { dev.removeEventListener('inputreport', h); try { await dev.close(); } catch { } },
  };
}

/* The HID interface an adapter talks to: its usage page if it names one, else one with output reports */
function usable(dev) {
  const a = adapterFor(dev); if (!a) return false;
  return a.hid.usagePage ? dev.collections.some(c => c.usagePage === a.hid.usagePage) : dev.collections.some(c => (c.outputReports || []).length);
}

/* A mic the page may already use, else ask Chrome to show its device picker (needs a click) */
async function findDevice(hid, { ask = false } = {}) {
  const known = (await hid.getDevices()).filter(usable);
  if (known.length || !ask) return known[0] || null;
  const picked = (await hid.requestDevice({ filters: hidFilters() })).filter(usable);
  return picked[0] || null;
}

export { webhidTransport, findDevice, usable };
