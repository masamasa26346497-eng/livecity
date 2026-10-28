'use strict';
// Mission 45S: 合成データのみ。実 Windows Chrome・実データでは未確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/mission45o-align-diag.html'), 'utf8');
const start = html.indexOf('function trueMeters'), end = html.indexOf('function cpRender');
assert.ok(start > 0 && end > start);
const sb = {}; vm.createContext(sb);
vm.runInContext(html.slice(start, end) + ';this.pairDelta=pairDelta;this.snapRoad=snapRoad;this.summarize=summarize;this.trueMeters=trueMeters;', sb);
const meta = { origin: { lat: 34.604208, lon: 135.52502 }, mpd: 111320 };

test('pairDelta: gsi east of road -> east+ ; north is z negative', () => {
  const e = sb.pairDelta([0, 0], [10, 0], meta); assert.ok(e.e > 9.5 && e.e < 10.5); assert.ok(Math.abs(e.n) < 1e-9); assert.strictEqual(e.dir, '東');
  const n = sb.pairDelta([0, 0], [0, -10], meta); assert.ok(n.n > 9.5 && n.n < 10.5); assert.strictEqual(n.dir, '北');
  const sw = sb.pairDelta([0, 0], [-10, 10], meta); assert.strictEqual(sw.dir, '南西');
});
test('pairDelta converts to true metres (lat degree ~110.9 km, not 111.32 km)', () => {
  const d = sb.pairDelta([0, 0], [0, -111320], meta);
  assert.ok(d.n > 110800 && d.n < 111100, String(d.n));
});
test('summarize: aligned vs scattered vs within tolerance', () => {
  const al = [{ e: 10, n: 5 }, { e: 11, n: 4 }, { e: 9, n: 6 }];
  assert.ok(/揃っています/.test(sb.summarize(al, 0.5).verdict));
  const sc = [{ e: 10, n: 0 }, { e: -10, n: 0 }, { e: 0, n: 12 }];
  assert.ok(/揃っていません/.test(sb.summarize(sc, 0.5).verdict));
  assert.ok(/目視誤差内/.test(sb.summarize([{ e: 1, n: 1 }, { e: 1.5, n: 0.5 }], 0.5).verdict));
  assert.ok(/1組のみ/.test(sb.summarize([{ e: 10, n: 0 }], 0.5).verdict));
  assert.strictEqual(sb.summarize([], 1), null);
});
test('page: privacy default on, no network/export in correspondence code, offsets never auto-written', () => {
  assert.ok(/id="priv" checked/.test(html));
  const seg = html.slice(html.indexOf('Mission 45S: 対応点'), html.indexOf('function draw()'));
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|download|Blob/.test(seg));
  assert.ok(!/\$\('r[xz]'\)\.value\s*=|\$\('d[xz]'\)\.value\s*=/.test(seg));
});

// ---- 45S-2: 線分スナップ（合成fixture） ----
test('snapRoad: crossing with no vertex at the crossing -> intersection point', () => {
  const roads = [[[-100, 0], [100, 0]], [[0, -100], [0, 100]]];
  const r = sb.snapRoad(roads, 6, 4, 20);
  assert.strictEqual(r.kind, 'intersection');
  assert.ok(Math.hypot(r.pt[0], r.pt[1]) < 1e-9);
  assert.ok(Math.abs(r.snapM - Math.hypot(6, 4)) < 1e-9);
});
test('snapRoad: straight road -> perpendicular projection, not the vertex 100 m away', () => {
  const r = sb.snapRoad([[[-100, 0], [100, 0]]], 30, 5, 20);
  assert.strictEqual(r.kind, 'segment');
  assert.ok(Math.abs(r.pt[0] - 30) < 1e-9 && Math.abs(r.pt[1]) < 1e-9);
});
test('snapRoad: beyond radius rejected; near-parallel gives no intersection', () => {
  assert.strictEqual(sb.snapRoad([[[-100, 0], [100, 0]]], 0, 50, 20), null);
  const r = sb.snapRoad([[[-100, 0], [100, 0]], [[-100, 1], [100, 3]]], 0, 0, 20);
  assert.strictEqual(r.kind, 'segment');
});
test('snapRoad: shared junction vertex of separate polylines counts; a bend in one polyline does not', () => {
  assert.strictEqual(sb.snapRoad([[[-50, 0], [0, 0]], [[0, 0], [0, 50]]], 3, 3, 20).kind, 'intersection');
  assert.strictEqual(sb.snapRoad([[[-50, 0], [0, 0], [0, 50]]], 3, 3, 20).kind, 'segment');
});
test('page: vertex snap removed; radius rejection, meaning disclaimer, C1-only caveat present', () => {
  assert.ok(!/nearestRoadPoint/.test(html));
  assert.ok(/拒否しました/.test(html) && /測地精度の保証ではありません/.test(html) && /C1のみでは共通オフセットを判断できません/.test(html));
});
