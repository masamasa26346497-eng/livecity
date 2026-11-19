'use strict';
// Mission 194R: 旧 45D の無断自動混入を防ぐゲートと、データ出典ラベルの検証(合成 fixture。実データではない)。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('node:child_process');
const F = require('./helpers/lc-45d-fixture.cjs');
const A = require('../tools/lod2/lod2-ext-attach.cjs');
const ROOT = path.resolve(__dirname, '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(env, args = []) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', 'temp/lc194r-none', ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/__lod2/diag.json')).ok) return { p, base }; } catch (e) { /* retry */ } await sleep(100); }
  p.kill(); throw new Error('server did not start');
}
const diag = async (b) => (await fetch(b + '/__lod2/diag.json')).json();
const mkLa = () => F.mkLocalAppData({ wards: ['asahi', 'higashiyodogawa'], special: {}, layerWards: [] });

test('discover: 既定の場所は --allow-legacy 無しでは接続しない(検出だけ報告)', () => {
  const env = { LOCALAPPDATA: mkLa() };
  const d = A.discover(undefined, env);
  assert.strictEqual(d.chosen, null); assert.strictEqual(d.mode, 'none');
  assert.ok(d.legacyFound && d.legacyFound.wards.length === 2);
  const l = A.discover(undefined, env, { allowLegacy: true });
  assert.strictEqual(l.mode, 'legacy-auto'); assert.ok(l.chosen);
});

test('サーバ: 通常起動は旧データを接続せず「2025ではない」と diag に出す', async () => {
  const { p, base } = await start({ LOCALAPPDATA: mkLa() });
  try {
    const d = await diag(base);
    assert.strictEqual(d.extAttach.attached, false);
    assert.strictEqual(d.extAttach.source.label, 'unconnected');
    assert.match(d.extAttach.source.ja, /2025 の LOD1 ではありません/);
    assert.match(d.extAttach.source.legacyNote, /--allow-legacy/);
    const idx = await fetch(base + '/ext-3dtiles/index.json'); assert.notStrictEqual(idx.status, 200);
  } finally { p.kill(); }
});

test('サーバ: --allow-legacy は接続するが 2025 とは表示しない', async () => {
  const { p, base } = await start({ LOCALAPPDATA: mkLa() }, ['--allow-legacy']);
  try {
    const s = (await diag(base)).extAttach.source;
    assert.strictEqual(s.label, 'legacy-45d'); assert.match(s.ja, /2025 ではない可能性/);
  } finally { p.kill(); }
});

test('サーバ: --no-auto-ext でも明示 --ext-root は接続される。vintage 記載が無ければ 2025 と言わない', async () => {
  const la = mkLa();
  const root = path.join(la, 'LiveCity-3DTiles-Out-24');
  const { p, base } = await start({ LOCALAPPDATA: path.join(la, 'none') }, ['--no-auto-ext', '--ext-root', root]);
  try {
    const e = (await diag(base)).extAttach;
    assert.strictEqual(e.attached, true);
    assert.strictEqual(e.source.label, 'explicit-unverified'); assert.match(e.source.ja, /2025 とは確認できません/);
  } finally { p.kill(); }
});

test('vintageOf: 全区が vintage 2025 のときだけ plateau-2025、混在は mixed', () => {
  const ins = A.inspect(path.join(mkLa(), 'LiveCity-3DTiles-Out-24'));
  assert.strictEqual(A.vintageOf(ins).label, 'unverified');
  const setV = (w, v) => { const f = path.join(w.dir, 'source.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.vintage = v; fs.writeFileSync(f, JSON.stringify(j)); };
  for (const w of ins.servable) setV(w, 2025);
  assert.strictEqual(A.vintageOf(ins).label, 'plateau-2025');
  setV(ins.servable[0], 2022);
  assert.strictEqual(A.vintageOf(ins).label, 'mixed');
  assert.strictEqual(A.vintageOf(null).label, 'unconnected');
});
