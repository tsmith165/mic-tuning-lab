import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ObsClient, obsFilters, obsRecipe } from '../core/obs.js';
import { srv, filters } from './obs-mock.js';

after(() => srv.close());

const chain = { gateOn: true, gateOpen: -55, eqLow: -1, eqMid: 0, eqHigh: 1.5, compOn: true, thr: -22, ratio: 3, att: 6, rel: 80, target: -14, ceil: -1 };

test('pushes the chain to OBS after your own filters, and updates it in place', async () => {
  if (!srv.listening) await once(srv, 'listening');
  const url = `ws://127.0.0.1:${srv.address().port}`, obs = new ObsClient();
  await assert.rejects(new ObsClient().connect(url, 'wrong'), /password/);
  await assert.rejects(new ObsClient().connect('ws://127.0.0.1:9', 'x'), /Could not reach OBS|did not answer/);
  await obs.connect(url, 'hunter2');
  assert.deepEqual(await obs.audioInputs(), ['Mic/Aux', 'Shure MV7']);
  assert.equal(await obs.push('Shure MV7', obsFilters(chain, 16.9)), 5);
  let names = filters['Shure MV7'].map(f => f.filterName);
  assert.deepEqual(names, ['My Noise Suppression', 'Mic Lab Gate', 'Mic Lab EQ', 'Mic Lab Compressor', 'Mic Lab Gain', 'Mic Lab Limiter']);
  await obs.push('Shure MV7', obsFilters({ ...chain, gateOn: false, thr: -18 }, 16.9));
  names = filters['Shure MV7'].map(f => f.filterName);
  assert.ok(!names.includes('Mic Lab Gate') && names.length === 5);
  assert.equal(filters['Shure MV7'].find(f => f.filterName === 'Mic Lab Compressor').filterSettings.threshold, -18);
  assert.match(obsRecipe(chain, 16.9), /4\. Gain\s+\+16\.9 dB/);
  obs.close();
});
