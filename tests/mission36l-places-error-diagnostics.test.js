import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlacesClient, sanitizeHttpErrorDiagnostics } from '../tools/google-places/lib/places-client.mjs';
import { parseCli, DEFAULT_REQUESTS_PER_MINUTE } from '../tools/google-places/rescue-mission36l-missing-facility-records.mjs';

const SECRET = 'AIzaSySECRETKEY123';
const errRes = (status, body, headers = {}) => ({
  ok: false, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const noGuard = { schedule: async (_k, fn) => fn(), getStats: () => ({}) };

test('diagnostics keep only status, Retry-After, error code and enum status', async () => {
  const d = await sanitizeHttpErrorDiagnostics(errRes(429, {
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `quota for key ${SECRET}`, details: [{ link: 'https://x/photos/abc' }] },
  }, { 'retry-after': '30' }));
  assert.deepEqual(d, { httpStatus: 429, retryAfter: '30', errorCode: 429, errorStatus: 'RESOURCE_EXHAUSTED' });
  assert.ok(!JSON.stringify(d).includes(SECRET));
});

test('diagnostics reject free-form values and tolerate non-JSON bodies', async () => {
  const d = await sanitizeHttpErrorDiagnostics({
    status: 403, headers: { get: () => 'see https://evil/?key=' + SECRET },
    json: async () => { throw new Error('not json'); },
  });
  assert.deepEqual(d, { httpStatus: 403, retryAfter: null, errorCode: null, errorStatus: null });
  const d2 = await sanitizeHttpErrorDiagnostics(errRes(403, { error: { code: 403, status: `places/${SECRET}/photos/x` } }));
  assert.equal(d2.errorStatus, null);
});

test('searchText failure returns sanitized diagnostics, makes exactly one call and leaks nothing', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: SECRET } }); };
  const client = createPlacesClient({ apiKey: SECRET, fetchImpl, requestGuard: noGuard });
  const r = await client.searchText({ textQuery: 'x', lat: 34.7, lon: 135.5 });
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'http-403');
  assert.equal(r.diagnostics.errorStatus, 'PERMISSION_DENIED');
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('diagnostic mode is bounded and default pacing is conservative', () => {
  const d = parseCli(['--diagnostic']);
  assert.deepEqual([d.limit, d.chunks, d.requestsPerMinute], [3, 1, 10]);
  assert.equal(parseCli([]).requestsPerMinute, DEFAULT_REQUESTS_PER_MINUTE);
  assert.ok(DEFAULT_REQUESTS_PER_MINUTE <= 20);
});
