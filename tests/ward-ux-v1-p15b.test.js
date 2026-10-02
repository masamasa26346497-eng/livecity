// tests/ward-ux-v1-p15b.test.js
// P1-5B: 実機確認で判明した描画・速度問題の修正（ward-ux-v1.html）の静的検証。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateWaterGeometry } from '../tools/lib/water-geometry-validator.js';

const HTML = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML, 'utf-8');
const OSAKA_CITY = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));

// osaka-city.json bbox → 既存 znorth-neg-v1 変換
function geoToLocal(lat, lon) {
  const p = OSAKA_CITY.projection;
  return { x: (lon - p.centerLon) * Math.cos((p.centerLat * Math.PI) / 180) * p.metersPerDegree, z: -((lat - p.centerLat) * p.metersPerDegree) };
}

test('B: OSAKA_CITY_GROUND_EXTENT が osaka-city.json の24区 bbox を覆う', () => {
  const m = html.match(/const OSAKA_CITY_GROUND_EXTENT = \{ minX: (-?\d+), maxX: (-?\d+), minZ: (-?\d+), maxZ: (-?\d+) \}/);
  assert.ok(m, 'OSAKA_CITY_GROUND_EXTENT 未定義');
  const ext = { minX: +m[1], maxX: +m[2], minZ: +m[3], maxZ: +m[4] };
  const b = OSAKA_CITY.bbox;
  const sw = geoToLocal(b.south, b.west), ne = geoToLocal(b.north, b.east);
  const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
  const minZ = Math.min(sw.z, ne.z), maxZ = Math.max(sw.z, ne.z);
  assert.ok(ext.minX <= minX && ext.maxX >= maxX, `x範囲不足 ext[${ext.minX},${ext.maxX}] vs city[${minX.toFixed(0)},${maxX.toFixed(0)}]`);
  assert.ok(ext.minZ <= minZ && ext.maxZ >= maxZ, `z範囲不足 ext[${ext.minZ},${ext.maxZ}] vs city[${minZ.toFixed(0)},${maxZ.toFixed(0)}]`);
  // 旧3区extent(約 x[-2500,2500] z[-4200,1200])より十分大きい
  assert.ok(maxX - minX > 20000 && maxZ - minZ > 18000, '24区extentが小さすぎる（計算ミス）');
});

test('B: computeBounds が OSAKA_CITY_GROUND_EXTENT を union している', () => {
  assert.ok(/OSAKA_CITY_GROUND_EXTENT[\s\S]{0,400}Math\.min\([\s\S]{0,120}E\.minX/.test(html) ||
    /const E = OSAKA_CITY_GROUND_EXTENT/.test(html), 'computeBounds が extent を union していない');
});

test('B: カメラ maxR を拡大し、Fog / camera.far を距離で後退させる', () => {
  const m = html.match(/minPh:0\.05, maxPh:1\.45, minR:60, maxR:(\d+)/);
  assert.ok(m && +m[1] >= 20000, `maxR が小さい: ${m && m[1]}`);
  assert.ok(/function updateFogForCameraDistance\(\)/.test(html), 'updateFogForCameraDistance 未定義');
  assert.ok(/camera\.far = wantFar; camera\.updateProjectionMatrix\(\)/.test(html), 'camera.far の動的拡大が無い');
  assert.ok(/camUpd\(\)\{[\s\S]{0,120}updateFogForCameraDistance\(\)/.test(html), 'camUpd から Fog 更新を呼んでいない');
});

test('E: N03 は camera/detectWardAt 専用（WardAreaFill/Boundary/Label へ流していない）', () => {
  assert.ok(/let __n03WardPolyCache = null/.test(html), '__n03WardPolyCache 未定義');
  assert.ok(/getWardCameraTarget/.test(html), 'getWardCameraTarget 未定義');
  // ensureWardRings が __n03WardPolyCache / __n03WardRingsCache を参照していないこと
  const ewr = html.slice(html.indexOf('function ensureWardRings()'), html.indexOf('function ensureWardRings()') + 900);
  assert.ok(!/__n03Ward/.test(ewr), 'ensureWardRings が N03 を混ぜている（P1-5B で撤去したはず）');
  // 旧 __invalidateWardRings は撤去
  assert.ok(!/__invalidateWardRings/.test(html), '__invalidateWardRings が残っている');
  // 3レイヤーの初期化は setTimeout(...,0) に戻っている
  for (const layer of ['WardBoundaryLayer', 'WardAreaFillLayer', 'WardLabelLayer']) {
    const mm = html.match(new RegExp(`${layer}\\.show\\(\\);\\s*console\\.log`));
    const preceding = html.slice(Math.max(0, mm.index - 300), mm.index);
    assert.ok(/setTimeout\(\(\) => \{/.test(preceding) && !/__n03WardRingsReady\.then/.test(preceding),
      `${layer} が __n03WardRingsReady 待ちのまま`);
  }
});

test('D: render mode 既定が stream / 旧区は新区の最初のtileまで保持', () => {
  assert.ok(/__WARD_RENDER_MODE__ === undefined\) window\.__WARD_RENDER_MODE__ = 'stream'/.test(html), 'render mode 既定が stream でない');
  assert.ok(/const releaseOldWard = \(reason\) =>/.test(html), 'releaseOldWard 未定義');
  assert.ok(/releaseOldWard\('新区の最初のtile到着'\)/.test(html), '最初のtile到着で旧区解放していない');
  assert.ok(/OLD_WARD_HOLD_TIMEOUT_MS/.test(html), '旧区保持のタイムアウトが無い');
});

test('C: [WARD-PERF] ログ（manifestMs/firstTileFetchMs/firstRenderMs/visibleTileCount/buildingCount）', () => {
  const m = html.match(/console\.log\('\[WARD-PERF\] ' \+ JSON\.stringify\(\{[\s\S]{0,600}?\}\)\)/);
  assert.ok(m, '[WARD-PERF] ログが無い');
  for (const k of ['wardId', 'manifestMs', 'firstTileFetchMs', 'firstRenderMs', 'visibleTileCount', 'buildingCount']) {
    assert.ok(m[0].includes(k), `[WARD-PERF] に ${k} が無い`);
  }
});

test('F: loading indicator と WARD-DIAG overlay がある', () => {
  assert.ok(/function showWardLoadingIndicator\(/.test(html) && /function hideWardLoadingIndicator\(/.test(html));
  assert.ok(/\[WARD-DIAG\]/.test(html) && /peak loadedTiles/.test(html), 'メッシュ単調増加チェックが無い');
});

test('A: ward-ux-v1.html の OSM_WATER は water validator PASS（巨大segment 0）', () => {
  const s = html.indexOf('const OSM_WATER = ');
  const open = html.indexOf('[', s);
  let d = 0, i = open;
  for (; i < html.length; i++) { if (html[i] === '[') d++; else if (html[i] === ']') { d--; if (d === 0) { i++; break; } } }
  const arr = JSON.parse(html.slice(open, i));
  const r = validateWaterGeometry(arr);
  assert.equal(r.ok, true, JSON.stringify(r.offenders));
});

test('A: osaka_3d_buildings.html は壊れ relation が除去済み（water validator PASS）', () => {
  const p = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html');
  if (!fs.existsSync(p)) return;
  const h = fs.readFileSync(p, 'utf-8');
  assert.ok(!/relation\/1853006[123]/.test(h.slice(h.indexOf('const OSM_WATER = '), h.indexOf('const OSM_WATER = ') + 200000)),
    '壊れ relation/18530061-63 がまだ OSM_WATER に残っている');
});

test('A: clean-embedded-water は壊れ area を除去し line を温存する', () => {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'temp', 'p15b-'));
  mkdirSync(dir, { recursive: true });
  try {
    // 壊れ area（暗黙閉合辺が地物横断）+ 正常 line + 正常 area
    const water = [
      { id: 'relation/x', name: '', kind: 'area', subtype: 'river', p: [[0, 0], [1000, 0], [2000, 20]] },
      { id: 'way/line', name: '長い川', kind: 'line', subtype: 'river', p: [[0, 0], [3000, 0], [6000, 100]] },
      { id: 'way/pond', name: '池', kind: 'area', subtype: 'water', p: [[0, 0], [30, 0], [30, 30], [0, 30]] },
    ];
    const p = path.join(dir, 't.html');
    fs.writeFileSync(p, `<html><script>\nconst OSM_WATER = ${JSON.stringify(water)};\n</script></html>`);
    const out = execFileSync('node', ['tools/clean-embedded-water.js', '--html', p, '--write'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    assert.match(out, /除去: 1件/);
    assert.ok(!/\[DROP\] way\/line/.test(out), 'line が誤って除去対象になっている');
    const after = JSON.parse(fs.readFileSync(p, 'utf-8').match(/const OSM_WATER = (\[[\s\S]*?\]);/)[1]);
    assert.deepEqual(after.map((w) => w.id).sort(), ['way/line', 'way/pond']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('protected baseline fullward-v3.html は P1-5B の変更を含まない', () => {
  const p = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
  if (!fs.existsSync(p)) return;
  const h = fs.readFileSync(p, 'utf-8');
  assert.ok(!/OSAKA_CITY_GROUND_EXTENT|updateFogForCameraDistance|__n03WardPolyCache|WARD-DIAG/.test(h),
    'protected baseline に P1-5B の変更が混入');
});
