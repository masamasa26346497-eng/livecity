'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function serve(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
}
const DATA = Buffer.alloc(4096, 7);
const origin = (s) => 'http://127.0.0.1:' + s.address().port + '/x.zip';
function slice(req) { const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range); return [Number(m[1]), Number(m[2])]; }

test('retry: connection reset once, then success', async () => {
  const { rangeFetch } = await import('../tools/mission79-plateau2025-source.mjs');
  let n = 0;
  const s = await serve((req, res) => {
    if (n++ === 0) return req.socket.destroy();
    const [a, b] = slice(req);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/4096` }); res.end(DATA.subarray(a, b + 1));
  });
  const buf = await rangeFetch(origin(s), 0, 1023, { backoffMs: 5 });
  assert.equal(buf.length, 1024); assert.equal(n, 2); s.close();
});

test('truncated body is rejected (never success); fails after bounded attempts', async () => {
  const { rangeFetch } = await import('../tools/mission79-plateau2025-source.mjs');
  let n = 0;
  const s = await serve((req, res) => { n++; res.writeHead(206); res.end(DATA.subarray(0, 100)); });
  await assert.rejects(rangeFetch(origin(s), 0, 1023, { attempts: 3, backoffMs: 5 }), /short\/long body/);
  assert.equal(n, 3); s.close();
});

test('HTTP 404 fails without retry', async () => {
  const { rangeFetch } = await import('../tools/mission79-plateau2025-source.mjs');
  let n = 0;
  const s = await serve((req, res) => { n++; res.writeHead(404); res.end(); });
  await assert.rejects(rangeFetch(origin(s), 0, 10, { backoffMs: 5 }), /HTTP 404/);
  assert.equal(n, 1); s.close();
});
