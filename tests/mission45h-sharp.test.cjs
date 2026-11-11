'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sb = {}; sb.window = sb;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/mission45g-perf.js'), 'utf8'), sb);
const P = sb.LC45G;
const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

function dropToMin(c, t0) {
  let t = t0;
  for (let i = 0; i < 400; i++) { t += 80; c.frame(80, true, t); }
  return t;
}

test('45H: 既定の下限は 0.8（文字の可読性）', () => {
  assert.strictEqual(P.DEFAULTS.minScale, 0.8);
  const c = P.createResolutionController({});
  dropToMin(c, 0);
  assert.ok(c.scale >= 0.8 - 1e-9 && c.scale < 1);
});

test('45H: 停止後は描画フレームが来なくても壁時計 700ms で 1.0 に戻る（RR 想定）', () => {
  const c = P.createResolutionController({});
  const t = dropToMin(c, 1000);
  assert.ok(c.scale < 1);
  assert.strictEqual(c.tick(t + 300, false), null, '700ms 未満は戻さない');
  assert.strictEqual(c.tick(t + P.DEFAULTS.restoreMs, false), 1, '700ms で 1.0');
  assert.strictEqual(c.scale, 1);
  assert.strictEqual(c.tick(t + 5000, false), null, '既に 1.0 なら何もしない');
});

test('45H: 移動中の tick は戻さず、移動時刻を更新する', () => {
  const c = P.createResolutionController({});
  const t = dropToMin(c, 0);
  assert.strictEqual(c.tick(t + 2000, true), null);
  assert.strictEqual(c.tick(t + 2300, false), null);
  assert.strictEqual(c.tick(t + 2000 + 700, false), 1);
});

test('45H: fixed / quality は tick でも変化しない', () => {
  const c = P.createResolutionController({ fixed: true });
  assert.strictEqual(c.tick(1e9, false), null);
  assert.strictEqual(c.scale, 1);
});

test('45H: speed プリセットは下限 0.6 まで下げられる', () => {
  const c = P.createResolutionController({ minScale: 0.6 });
  dropToMin(c, 0);
  assert.ok(Math.abs(c.scale - 0.6) < 1e-9);
});

test('45H: ページ配線（moveEnd/タイマーで復元、requestRender、preset）', () => {
  assert.ok(html.includes('resCtl.tick('));
  assert.ok(/function applyRes[^\n]*scene\.requestRender\(\)/.test(html));
  assert.ok(html.includes('RES_PRESET') && html.includes("'speed'"));
  assert.ok(!/(^|[^-])filter:\s*blur/.test(html), 'canvas に CSS blur を使わない（パネルの backdrop-filter は対象外）');
});

test('45H: LOD0 の null プレースホルダ競合を除去（null に isDestroyed を呼ばない）', () => {
  assert.ok(html.includes('lod0Live'));
  assert.ok(!html.includes('lod0Sets.values()].filter((t) => !t.isDestroyed'));
  assert.ok(!html.includes('of lod0Sets.values()) if (!t.isDestroyed'));
  assert.ok(html.includes('lod0Pending.has(code)'));
});

test('45H: 全域 mount は詳細優先・最大 2 並行の段階実行', () => {
  assert.ok(html.includes('const BATCH = 2'));
  assert.ok(!html.includes('await Promise.all(adds.map('));
  assert.ok(html.includes('allTilesLoaded.addEventListener'));
});

test('45H: HTML のインライン script が構文的に parse できる', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) { if (m[1].trim()) { new Function(m[1]); n++; } }
  assert.ok(n >= 1);
});
