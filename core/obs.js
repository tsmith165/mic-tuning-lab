/* The software chain as OBS filters, and a small obs-websocket v5 client (built into OBS 28 and later) that
   writes them onto an audio source. Filter kinds and setting keys follow obs-studio plugins/obs-filters. */
import { fmtS } from './advice.js';

const OBS_LABEL = { noise_gate_filter: 'Noise Gate', basic_eq_filter: '3-Band EQ', compressor_filter: 'Compressor', gain_filter: 'Gain', limiter_filter: 'Limiter' };

/* makeup: the gain in dB that lands the take on the target loudness, or null before a take is measured */
function obsFilters(c, makeup) {
  return [
    { name: 'Mic Lab Gate', kind: 'noise_gate_filter', enabled: !!c.gateOn, settings: { open_threshold: c.gateOpen, close_threshold: c.gateOpen - 6, attack_time: 25, hold_time: 200, release_time: 150 },
      text: `Open ${c.gateOpen} dB · Close ${c.gateOpen - 6} dB · Attack 25 ms · Hold 200 ms · Release 150 ms` },
    { name: 'Mic Lab EQ', kind: 'basic_eq_filter', enabled: !!(c.eqLow || c.eqMid || c.eqHigh), settings: { low: c.eqLow, mid: c.eqMid, high: c.eqHigh },
      text: `Low ${fmtS(c.eqLow)} dB · Mid ${fmtS(c.eqMid)} dB · High ${fmtS(c.eqHigh)} dB` },
    { name: 'Mic Lab Compressor', kind: 'compressor_filter', enabled: !!c.compOn, settings: { ratio: c.ratio, threshold: c.thr, attack_time: c.att, release_time: c.rel, output_gain: 0, sidechain_source: 'none' },
      text: `Ratio ${c.ratio}:1 · Threshold ${c.thr} dB · Attack ${c.att} ms · Release ${c.rel} ms · Output 0 dB` },
    { name: 'Mic Lab Gain', kind: 'gain_filter', enabled: makeup != null, settings: { db: makeup ?? 0 }, text: makeup == null ? 'record a take first' : `${fmtS(makeup)} dB` },
    { name: 'Mic Lab Limiter', kind: 'limiter_filter', enabled: true, settings: { threshold: c.ceil, release_time: 60 }, text: `Threshold ${c.ceil} dB · Release 60 ms` },
  ];
}
const obsRecipe = (c, makeup) => obsFilters(c, makeup).filter(f => f.enabled || f.kind === 'gain_filter').map((f, i) => `${i + 1}. ${OBS_LABEL[f.kind].padEnd(11)} ${f.text}`).join('\n');

async function sha256b64(str) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return btoa(String.fromCharCode(...new Uint8Array(h))); }

class ObsClient {
  constructor() { this.ws = null; this.pending = new Map(); this.seq = 0; this.onClose = null; }
  get connected() { return !!this.ws; }
  connect(url, password) {
    return new Promise((resolve, reject) => {
      let ws, done = false;
      try { ws = new WebSocket(url); } catch { reject(new Error('Bad OBS address: ' + url)); return; }
      const fail = m => { if (done) return; done = true; clearTimeout(timer); reject(new Error(m)); try { ws.close(); } catch { } };
      const timer = setTimeout(() => fail('OBS did not answer. Open OBS and turn on Tools, WebSocket Server Settings.'), 4000);
      ws.onerror = () => fail(`Could not reach OBS at ${url}. Open OBS and turn on Tools, WebSocket Server Settings.`);
      ws.onclose = e => { if (!done) fail(e.code === 4009 ? 'OBS rejected the WebSocket password' : `OBS closed the connection (code ${e.code})`); else if (this.ws === ws) { this.ws = null; if (this.onClose) this.onClose(); } };
      ws.onmessage = async ev => {
        const m = JSON.parse(ev.data);
        if (m.op === 0) {
          const d = { rpcVersion: 1 }, au = m.d.authentication;
          if (au) { if (!password) return fail('OBS asks for its WebSocket password'); d.authentication = await sha256b64(await sha256b64(password + au.salt) + au.challenge); }
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) { done = true; clearTimeout(timer); this.ws = ws; resolve(); }
        else if (m.op === 7) {
          const p = this.pending.get(m.d.requestId); if (!p) return; this.pending.delete(m.d.requestId);
          m.d.requestStatus.result ? p.res(m.d.responseData || {}) : p.rej(new Error(`${m.d.requestType}: ${m.d.requestStatus.comment || 'error ' + m.d.requestStatus.code}`));
        }
      };
    });
  }
  req(requestType, requestData = {}) {
    return new Promise((res, rej) => {
      if (!this.ws) return rej(new Error('Not connected to OBS'));
      const requestId = 'r' + (++this.seq); this.pending.set(requestId, { res, rej });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => { if (this.pending.delete(requestId)) rej(new Error(requestType + ' timed out')); }, 5000);
    });
  }
  async audioInputs() {
    const { inputs } = await this.req('GetInputList');
    return inputs.filter(i => /input_capture|wasapi_input|pulse_input|alsa_input|jack_input/.test(i.inputKind || '')).map(i => i.inputName);
  }
  /* Create or update our filters on the source, after any filters you added yourself */
  async push(source, want) {
    const have = new Set((await this.req('GetSourceFilterList', { sourceName: source })).filters.map(f => f.filterName));
    for (const f of want) {
      if (!f.enabled) { if (have.has(f.name)) await this.req('RemoveSourceFilter', { sourceName: source, filterName: f.name }); continue; }
      if (have.has(f.name)) { await this.req('SetSourceFilterSettings', { sourceName: source, filterName: f.name, filterSettings: f.settings, overlay: true }); await this.req('SetSourceFilterEnabled', { sourceName: source, filterName: f.name, filterEnabled: true }); }
      else await this.req('CreateSourceFilter', { sourceName: source, filterName: f.name, filterKind: f.kind, filterSettings: f.settings });
    }
    const ours = want.filter(f => f.enabled).map(f => f.name);
    const others = (await this.req('GetSourceFilterList', { sourceName: source })).filters.filter(f => !ours.includes(f.filterName)).length;
    for (let i = 0; i < ours.length; i++) await this.req('SetSourceFilterIndex', { sourceName: source, filterName: ours[i], filterIndex: others + i });
    return ours.length;
  }
  close() { if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); } }
}

export { OBS_LABEL, obsFilters, obsRecipe, ObsClient };
