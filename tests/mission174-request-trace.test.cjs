'use strict';
// Mission 174: extServed.byWard が空のとき「ブラウザが何を要求したか」をサーバ診断だけで切り分けられること、
// および ext45=1 無しで 37G を開いても 302 で補われる(=住吉だけになる経路を塞ぐ)ことを、実サーバ + 37G と同じ GET 手順で検証する。
// 合成 fixture。ブラウザ(Cesium)描画は検証していない。
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const F = require('./helpers/lc-45d-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', 'temp/lc174-none'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/__lod2/diag.json')).ok) return { p, base }; } catch (e) { /* retry */ } await sleep(100); }
  p.kill(); throw new Error('server did not start');
}
const diag = async (base) => (await fetch(base + '/__lod2/diag.json')).json();

test('ページ未要求 → verdict が「37G が一度も要求されていない」、byWard は空', async () => {
  const la = F.mkLocalAppData({ wards: ['asahi', 'higashiyodogawa'], special: {}, layerWards: [] });
  const { p, base } = await start({ LOCALAPPDATA: la });
  try {
    const d = await diag(base);
    assert.deepStrictEqual(d.extServed.byWard, {});
    assert.strictEqual(d.requests.html, 0);
    assert.match(d.requests.verdict, /一度も要求されていない/);
  } finally { p.kill(); }
});

test('Mission175: ext45 無しは 302 せず 200 + ext45=1 注入(明示 ext45=1 は注入しない)', async () => {
  const la = F.mkLocalAppData({ wards: ['asahi'], special: {}, layerWards: [] });
  const { p, base } = await start({ LOCALAPPDATA: la });
  try {
    const r = await fetch(base + '/mission37g-osaka-24ward-mvp.html?lod2=1', { redirect: 'manual' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('x-lc-auto-ext45'), '1');
    const html = await r.text();
    const i = html.indexOf('__lc175'); assert.ok(i > 0);
    assert.ok(i < html.indexOf('location.search', i + 400), 'injected before the page reads location.search');
    const d = await diag(base); assert.strictEqual(d.requests.injected, 1); assert.strictEqual(d.requests.redirected, 0);
    const r2 = await fetch(base + '/mission37g-osaka-24ward-mvp.html?ext45=1&nobuiltin=1');
    assert.strictEqual(r2.status, 200); assert.strictEqual(r2.headers.get('x-lc-auto-ext45'), '0');
    assert.ok(!(await r2.text()).includes('__lc175'));
  } finally { p.kill(); }
});

test('ext45 無しで開いても(注入)、index.json → 区ごとの source/build-report が要求される', async () => {
  const la = F.mkLocalAppData({ wards: ['asahi', 'higashiyodogawa'], special: {}, layerWards: [] });
  const { p, base } = await start({ LOCALAPPDATA: la });
  try {
    const r = await fetch(base + '/mission37g-osaka-24ward-mvp.html?lod2=1', { redirect: 'manual' });
    assert.strictEqual(r.status, 200);
    let d = await diag(base);
    assert.strictEqual(d.requests.injected, 1);
    assert.match(d.requests.verdict, /index\.json が要求されていない/);
    // 37G の loadExt45Defs → loadExtraMeta と同じ GET
    const idx = await (await fetch(base + '/ext-3dtiles/index.json')).json();
    for (const w of idx.wards) { for (const f of ['source.json', 'build-report.json']) assert.strictEqual((await fetch(base + '/ext-3dtiles/' + w.ward + '/' + f)).status, 200); }
    d = await diag(base);
    assert.strictEqual(d.requests.indexJson, 1);
    assert.deepStrictEqual(Object.keys(d.extServed.byWard).sort(), ['asahi', 'higashiyodogawa']);
    assert.match(d.requests.verdict, /区別ファイルを要求している/);
  } finally { p.kill(); }
});

test('ext45=0 は尊重(リダイレクトしない)し、verdict は ext45 欠落を指す', async () => {
  const la = F.mkLocalAppData({ wards: ['asahi'], special: {}, layerWards: [] });
  const { p, base } = await start({ LOCALAPPDATA: la });
  try {
    const r = await fetch(base + '/mission37g-osaka-24ward-mvp.html?ext45=0', { redirect: 'manual' });
    assert.strictEqual(r.status, 200);
    assert.match((await diag(base)).requests.verdict, /ext45=1 が無い/);
  } finally { p.kill(); }
});
