/* A minimal obs-websocket v5 server for tests: password hunter2, one MV7 input with a filter of its own */
import http from 'node:http'; import crypto from 'node:crypto';
const PASS = 'hunter2', SALT = 'c2FsdA==', CHAL = 'Y2hhbA==';
const sha = s => crypto.createHash('sha256').update(s).digest('base64');
const expected = sha(sha(PASS + SALT) + CHAL);
const inputs = [{ inputName: 'Desktop Audio', inputKind: 'sck_audio_capture' }, { inputName: 'Mic/Aux', inputKind: 'coreaudio_input_capture' }, { inputName: 'Shure MV7', inputKind: 'coreaudio_input_capture' }, { inputName: 'Webcam', inputKind: 'av_capture_input' }];
const filters = { 'Shure MV7': [{ filterName: 'My Noise Suppression', filterKind: 'noise_suppress_filter_v2', filterEnabled: true, filterSettings: {} }] };
const log = [];
function frame(str) { const p = Buffer.from(str); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); }
function closeFrame(code) { return Buffer.from([0x88, 2, code >> 8, code & 255]); }
const srv = http.createServer();
srv.on('upgrade', (req, sock) => {
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const send = o => sock.write(frame(JSON.stringify(o)));
  send({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge: CHAL, salt: SALT } } });
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      const m = JSON.parse(data.toString());
      if (m.op === 1) { if (m.d.authentication !== expected) { log.push('AUTH FAIL'); sock.write(closeFrame(4009)); sock.end(); return; } log.push('identified'); send({ op: 2, d: { negotiatedRpcVersion: 1 } }); continue; }
      const { requestType: t, requestId, requestData: r } = m.d; log.push(t + ' ' + JSON.stringify(r));
      const ok = d => send({ op: 7, d: { requestType: t, requestId, requestStatus: { result: true, code: 100 }, responseData: d } });
      const bad = c => send({ op: 7, d: { requestType: t, requestId, requestStatus: { result: false, code: 600, comment: c } } });
      const fl = filters[r.sourceName] ||= [];
      if (t === 'GetInputList') ok({ inputs });
      else if (t === 'GetSourceFilterList') ok({ filters: fl.map((f, i) => ({ ...f, filterIndex: i })) });
      else if (t === 'CreateSourceFilter') { if (fl.some(f => f.filterName === r.filterName)) bad('exists'); else { fl.push({ filterName: r.filterName, filterKind: r.filterKind, filterEnabled: true, filterSettings: r.filterSettings }); ok({}); } }
      else if (t === 'SetSourceFilterSettings') { const f = fl.find(f => f.filterName === r.filterName); f ? (Object.assign(f.filterSettings, r.filterSettings), ok({})) : bad('no filter'); }
      else if (t === 'SetSourceFilterEnabled') { const f = fl.find(f => f.filterName === r.filterName); f ? (f.filterEnabled = r.filterEnabled, ok({})) : bad('no filter'); }
      else if (t === 'RemoveSourceFilter') { const i = fl.findIndex(f => f.filterName === r.filterName); i >= 0 ? (fl.splice(i, 1), ok({})) : bad('no filter'); }
      else if (t === 'SetSourceFilterIndex') { const i = fl.findIndex(f => f.filterName === r.filterName); if (i < 0) bad('no filter'); else { const [f] = fl.splice(i, 1); fl.splice(r.filterIndex, 0, f); ok({}); } }
      else bad('unknown request ' + t);
    }
  });
});
srv.listen(0, '127.0.0.1');
export { srv, filters, log };
