'use strict';
// Mission 45F: 全域3D ストリーミング計画 / full-partial 判定 / 区全域 fit。純粋ロジック + ページ配線の静的確認。
// ブラウザ実描画ではない。実 PC の 24 区の描画証拠でもない（合成の区 bbox と、Git 管理の住吉区 sidecar 規約のみ）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
// package.json は "type": "module" なので、他の public/*.js と同様に vm で評価する（ブラウザでは window.LC45F になる）
const sandbox = {}; sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45f-streaming.js'), 'utf8'), sandbox);
const L = sandbox.LC45F;
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const wardsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;

test('plan: detail <= 2, coarse <= 8, far wards never mounted', () => {
  const cam = { x: wardsJson[0].bbox.minX, z: wardsJson[0].bbox.minZ, height: 12000 };
  const p = L.plan(cam, wardsJson, {});
  const d = Object.values(p.want).filter((v) => v === 'detail').length, c = Object.values(p.want).filter((v) => v === 'coarse').length;
  assert.ok(d <= L.DEFAULTS.detailMax && c <= L.DEFAULTS.coarseMax);
  assert.ok(Object.keys(p.want).length < 24, 'not all 24 wards resident');
});
test('plan: city overview height -> coarse only, detail 0; very high -> nothing', () => {
  const xs = wardsJson.map((w) => (w.bbox.minX + w.bbox.maxX) / 2), zs = wardsJson.map((w) => (w.bbox.minZ + w.bbox.maxZ) / 2);
  const cx = xs.reduce((a, b) => a + b) / 24, cz = zs.reduce((a, b) => a + b) / 24;
  const p = L.plan({ x: cx, z: cz, height: 40000 }, wardsJson, {});
  assert.strictEqual(Object.values(p.want).filter((v) => v === 'detail').length, 0);
  assert.ok(Object.keys(p.want).length > 0 && Object.keys(p.want).length <= 8);
  assert.deepStrictEqual(Object.keys(L.plan({ x: cx, z: cz, height: 200000 }, wardsJson, {}).want), []);
});
test('plan: LRU drop + hysteresis (mounted ward kept slightly beyond threshold)', () => {
  const w = wardsJson[3], other = wardsJson[10];
  const edge = { x: w.bbox.maxX + L.DEFAULTS.detailDist * 1.2, z: (w.bbox.minZ + w.bbox.maxZ) / 2, height: 5000 };
  const fresh = L.plan(edge, [w], {});
  const kept = L.plan(edge, [w], { [w.wardCode]: 'detail' });
  assert.strictEqual(fresh.want[w.wardCode] === 'detail', false);
  assert.strictEqual(kept.want[w.wardCode], 'detail');
  const far = L.plan({ x: w.bbox.maxX + 99999, z: w.bbox.maxZ + 99999, height: 5000 }, [w, other], { [w.wardCode]: 'detail' });
  assert.ok(far.drop.includes(w.wardCode));
});
test('coverageState: full only with verified45 and source counts satisfied', () => {
  const ward = { sourceBuildings: 1000, sourceTiles: 10 };
  const rep = (b, t) => ({ report: { totals: { buildings: b }, selectedTiles: t } });
  assert.strictEqual(L.coverageState(Object.assign({ verified45: true }, rep(1000, 10)), ward), 'full');
  assert.strictEqual(L.coverageState(Object.assign({ verified45: true }, rep(999, 10)), ward), 'partial');
  assert.strictEqual(L.coverageState(Object.assign({ verified45: true }, rep(1000, 9)), ward), 'partial');
  assert.strictEqual(L.coverageState(Object.assign({ verified45: false }, rep(1000, 10)), ward), 'partial', 'synthetic / ?ext= alone stays partial');
  assert.strictEqual(L.coverageState(Object.assign({ verified45: true }, rep(0, 0)), ward), 'none');
  assert.strictEqual(L.coverageState(Object.assign({ verified45: true }, rep(5, 5)), null), 'partial');
});
test('unionCircle contains both the N03 bbox circle and the tileset sphere', () => {
  const b = { minX: 0, maxX: 6000, minZ: 0, maxZ: 8000 };
  const s = { x: 7000, z: 9000, r: 2500 };
  const u = L.unionCircle(b, s);
  const bc = { x: 3000, z: 4000, r: 5000 };
  assert.ok(Math.hypot(u.x - bc.x, u.z - bc.z) + bc.r <= u.r + 1e-6);
  assert.ok(Math.hypot(u.x - s.x, u.z - s.z) + s.r <= u.r + 1e-6);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(L.unionCircle(b, null))), bc);
});
test('fitRange: panel insets and narrow screens push the camera farther; never below radius', () => {
  const fov = Math.PI / 3, pitch = -Math.PI * 55 / 180;
  const wide = L.fitRange(4000, fov, { w: 1920, h: 1000 }, { left: 0, right: 0 }, pitch);
  const withPanel = L.fitRange(4000, fov, { w: 1280, h: 800 }, { left: 320, right: 300 }, pitch);
  const phone = L.fitRange(4000, fov, { w: 390, h: 800 }, { left: 0, right: 0 }, pitch);
  assert.ok(wide > 4000);
  assert.ok(withPanel > L.fitRange(4000, fov, { w: 1280, h: 800 }, {}, pitch));
  assert.ok(phone > wide, 'portrait phone needs a larger range (horizontal fov is the limit)');
});
test('page wiring: mode switch, streaming, full/partial rule, no unconditional partial, no fixed unconverted text for full', () => {
  assert.match(html, /mission45f-streaming\.js/);
  assert.match(html, /id="sel-bldg-mode"/);
  assert.match(html, /LC45F\.plan\(/);
  assert.match(html, /LC45F\.coverageState\(/);
  assert.match(html, /verified45: j\.verified === true/);
  assert.match(html, /async function setAllMode/);
  assert.match(html, /allSets\.get\(code\) !== rec/, 'stale mount is discarded');
  assert.match(html, /function allDrop/);
  assert.match(html, /clearBuildingPick\(\);\s*\n\s*for \(const e of r\.entries\)/, 'pick cleared before destroy');
  assert.match(html, /w\.cover\.state === 'full' \? '元データ（ローカル変換済み・未公開）/);
  assert.doesNotMatch(html, /COVERAGE\[code\] = \{ state: 'partial'/);
  assert.match(html, /scheduleAll/);
  assert.doesNotMatch(html, /setInterval\([^)]*allTick/);
});
test('page keeps wardCode namespace, per-tileset _lcBase and Google lock', () => {
  assert.match(html, /ts\._lcBase = base/);
  assert.match(html, /selectedKey/);
  assert.doesNotMatch(html, /maps\.googleapis|places\.googleapis/);
});
test('45E index.json carries verified only for non-synthetic proof', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission45e-preview.cjs'), 'utf8');
  assert.match(src, /verified: synthetic === false/);
  assert.match(src, /makeServer\(p\.servable, \(\) => port, p\.synthetic\)/);
});
