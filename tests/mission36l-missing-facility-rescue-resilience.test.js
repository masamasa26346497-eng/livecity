import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchOverpassCenters, overpassBackoffMs, isTransientOverpassError, runChunks,
} from '../tools/google-places/rescue-mission36l-missing-facility-records.mjs';

const items = [{ src: { type: 'way', id: 1 } }];
const ok = { ok: true, json: async () => ({ elements: [{ type: 'way', id: 1, center: { lat: 34.6, lon: 135.5 } }] }) };
const http = (status) => ({ ok: false, status });

test('backoff is exponential and capped', () => {
  const mid = () => 0.5;
  assert.equal(overpassBackoffMs(1, mid), 5000);
  assert.equal(overpassBackoffMs(2, mid), 10000);
  assert.equal(overpassBackoffMs(3, mid), 20000);
  assert.equal(overpassBackoffMs(10, mid), 60000);
});

test('retries transient 504/429 with growing delays then succeeds', async () => {
  const seq = [http(504), http(429), ok];
  const delays = [];
  const m = await fetchOverpassCenters(items, async () => seq.shift(), 5, async (ms) => delays.push(ms));
  assert.equal(m.get('way/1').lat, 34.6);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0]);
});

test('does not retry non-transient errors; flags exhausted transient errors', async () => {
  let calls = 0;
  await assert.rejects(fetchOverpassCenters(items, async () => { calls++; return http(400); }, 5, async () => {}), /400/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchOverpassCenters(items, async () => { calls++; return http(504); }, 3, async () => {}), (e) => e.transientOverpass === true);
  assert.equal(calls, 3);
  assert.equal(isTransientOverpassError(new Error('Overpass HTTP 404')), false);
});

test('runChunks keeps completed chunks and stops gracefully on transient failure', async () => {
  let n = 0;
  const runBatch = async () => {
    n++;
    if (n === 3) throw new Error('Overpass HTTP 504');
    return { processed: 20, verifiedThisBatch: 2, remainingMissingActionable: 100, osmCentersResolved: 20 };
  };
  const s = await runChunks({ chunks: 10 }, { runBatch, sleepImpl: async () => {}, log() {} });
  assert.equal(s.processed, 40);
  assert.equal(s.verifiedThisRun, 4);
  assert.match(s.stoppedEarly, /chunk 3/);
  assert.equal(n, 3);
});

test('runChunks rethrows non-transient errors', async () => {
  await assert.rejects(runChunks({ chunks: 3 }, { runBatch: async () => { throw new Error('safety violation'); }, sleepImpl: async () => {}, log() {} }), /safety violation/);
});
