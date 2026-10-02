import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacedCityGuard } from '../tools/google-places/lib/city-batch-guard.mjs';

test('city pacing shares search/details budget and serializes concurrent callers', async () => {
  let clock = 0;
  const times = [];
  const guard = createPacedCityGuard({ requestsPerMinute: 60,
    now: () => clock, sleep: async (ms) => { clock += ms; } });
  await Promise.all(Array.from({ length: 65 }, (_, i) =>
    guard.schedule(String(i), async () => { times.push(clock); })));
  assert.equal(times.length, 65);
  assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] >= 1025));
  assert.equal(guard.getStats().rateLimited, 0);
});

test('city pacing preserves session cost cap and recovers queue after errors', async () => {
  let clock = 0;
  const guard = createPacedCityGuard({ now: () => clock,
    sleep: async (ms) => { clock += ms; } });
  await assert.rejects(guard.schedule('fail', async () => { throw new Error('network'); }));
  for (let i = 1; i < 200; i++) await guard.schedule(String(i), async () => i);
  await assert.rejects(guard.schedule('over-cap', async () => 0), /セッション/);
  assert.equal(guard.getStats().executed, 200);
});

test('city pacing rejects invalid limits', () => {
  for (const requestsPerMinute of [0, -1, NaN, Infinity, 101])
    assert.throws(() => createPacedCityGuard({ requestsPerMinute }));
});
