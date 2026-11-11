'use strict';
// Mission 111: failure diagnostics for the private-release fetch. Fake fetch only: no network, no real token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const lib = () => import(pathToFileURL(path.join(ROOT, 'tools/mission108/lib.mjs')).href);
const FV = path.join(ROOT, 'tools/mission108/fetch-verify.mjs');
const TOKEN = 'github_pat_SECRETSECRET1234567890';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm111-'));

// Preload that replaces fetch. MOCK modes: repo401 repo403 repo404 release404 network public nothing-found
const PRELOAD = `
const mode = process.env.MOCK;
const body = (s, o) => new Response('SECRET-RESPONSE-BODY', { status: s, ...(o||{}) });
globalThis.fetch = async (url) => {
  if (mode === 'network') { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
  if (/\\/releases\\/tags\\//.test(url)) return mode === 'release404' ? body(404) : new Response(JSON.stringify({ assets: [] }), { status: 200 });
  if (mode === 'repo401') return body(401);
  if (mode === 'repo403') return body(403);
  if (mode === 'repo404') return body(404);
  return new Response(JSON.stringify({ visibility: mode === 'public' ? 'public' : 'private' }), { status: 200 });
};
`;

function run(mode, wards = 'nishi') {
  const d = tmp();
  const pre = path.join(d, 'pre.mjs'); fs.writeFileSync(pre, PRELOAD);
  const dest = path.join(d, 'dest'); const summary = path.join(d, 'sum.json');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, FV, '--wards', wards, '--dest', dest, '--summary', summary],
    { encoding: 'utf8', env: { ...process.env, MOCK: mode, LIVECITY_3D_DATA_TOKEN: TOKEN } });
  return { r, dest, summary: JSON.parse(fs.readFileSync(summary, 'utf8')), out: r.stdout + r.stderr };
}

const cases = [
  ['repo401', 401, /401/],
  ['repo403', 403, /403/],
  ['repo404', 404, /Contents|Resource owner/],
  ['release404', 404, /タグ/],
  ['network', null, /接続できませんでした/],
  ['public', null, /private ではありません/],
  ['nothing-found', null, /アセット/],
];
for (const [mode, http, re] of cases) {
  test('fetch-verify failure diagnostics: ' + mode, () => {
    const { r, summary, out, dest } = run(mode);
    assert.notStrictEqual(r.status, 0, 'non-zero exit is kept');
    assert.ok(r.status === 1, 'exit code 1 (not an abort/assertion code): ' + r.status);
    assert.strictEqual(summary.allVerified, false);
    assert.ok(summary.diagnostic || summary.wards.nishi.diagnostic, 'diagnostic in summary');
    assert.match(out, re, 'console shows Japanese cause/remediation');
    assert.ok(out.includes('対処') || mode === 'nothing-found', 'remediation printed');
    if (http) assert.strictEqual(summary.diagnostic.http, http);
    // secrets never printed or stored
    const all = out + JSON.stringify(summary);
    assert.ok(!all.includes(TOKEN) && !all.includes('SECRETSECRET'), 'token not exposed');
    assert.ok(!all.includes('SECRET-RESPONSE-BODY'), 'response body not exposed');
    assert.ok(!/Assertion failed|UV_HANDLE/.test(out), 'no libuv assertion');
    // nothing but the (empty) dest was created; no partial archive left
    assert.deepStrictEqual(fs.readdirSync(dest), []);
  });
}

test('diagnose(): messages are built without bodies or tokens', async () => {
  const L = await lib();
  const d = L.diagnose(new L.FetchDiag('http', 'repo', 404));
  assert.match(d.remediation, /Resource owner/);
  assert.match(d.remediation, /Contents/);
  assert.strictEqual(L.diagnose(new Error('x')).kind, 'unknown');
});

test('downloadAsset: size mismatch / HTTP error leaves NO partial file and never overwrites', async () => {
  const L = await lib();
  const d = tmp(); const file = path.join(d, 'a.tar.gz');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(Buffer.from('short'), { status: 200 });
    await assert.rejects(L.downloadAsset('t', { id: 1, size: 999 }, file), (e) => e.kind === 'asset-size');
    assert.ok(!fs.existsSync(file));
    globalThis.fetch = async () => new Response('x', { status: 502 });
    await assert.rejects(L.downloadAsset('t', { id: 1, size: 1 }, file), (e) => e.kind === 'http' && e.http === 502);
    assert.ok(!fs.existsSync(file));
    // existing file is never overwritten (flag wx)
    fs.writeFileSync(file, 'KEEP');
    globalThis.fetch = async () => new Response(Buffer.from('abc'), { status: 200 });
    await assert.rejects(L.downloadAsset('t', { id: 1, size: 3 }, file));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'KEEP');
  } finally { globalThis.fetch = real; }
});

test('no process.exit() in fetch-verify (Windows Node 24 handle teardown); exitCode used instead', () => {
  const src = fs.readFileSync(FV, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // only early argument-validation exits (before any fetch) may remain
  const tail = src.slice(src.indexOf('const release'));
  assert.ok(!/process\.exit\(/.test(tail), 'no process.exit after fetching starts');
  assert.match(src, /process\.exitCode = exit/);
});

test('local-run tells where the summary is and does not delete partial data', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission108/local-run.mjs'), 'utf8');
  assert.match(src, /fetch-summary\.json/);
  assert.ok(!/rmSync|unlinkSync|rmdirSync/.test(src));
});
