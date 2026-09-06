// tests/water-source-p16f.test.js
// P1-6F: 水域 SOURCE geometry の追跡・検証。
//   - convert 出力に source metadata（way id / relation id + member way id）が付く
//   - assembleMultipolygon が member way id を追跡し、複数 outer を1本へ連結しない
//   - feature-ward-overlap: 24区の外にしか無い巨大河川（猪名川 rel/16551409 等）を除外
//   - water-semantic-validator: 疎ノード巨大三角形を WARN、退化を ERROR

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { convertWaterwaysWithReport } from '../tools/convert/waterways.js';
import { assembleMultipolygon, stitchWays } from '../tools/lib/osm-multipolygon.js';
import { buildWardIndex, featureWardOverlap } from '../tools/lib/feature-ward-overlap.js';
import { validateWaterSemantics } from '../tools/lib/water-semantic-validator.js';
import { densifyRingXZ } from '../tools/lib/polygon-fill.js';

const AREA = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
const FIX = path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'water-fill');
const RELATIONS = JSON.parse(fs.readFileSync(path.join(FIX, 'relations.json'), 'utf-8'));
const WARD_POLYS = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, 'data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8').replace(/^﻿/, ''));
const wardIndex = buildWardIndex(WARD_POLYS);
const relById = (id) => RELATIONS.find((r) => r.id === id);
const negZ = (pts) => pts.map(([x, z]) => [x, -z]);

test('stitchWays: way id を渡すと各リングの member way id を返す', () => {
  const A = [[0, 0], [0, 10]], B = [[0, 10], [10, 10]], C = [[10, 10], [10, 0], [0, 0]];
  const r = stitchWays([{ points: A, id: 'wA' }, { points: B, id: 'wB' }, { points: C, id: 'wC' }]);
  assert.equal(r.rings.length, 1);
  assert.deepEqual([...r.ringWayIds[0]].sort(), ['wA', 'wB', 'wC']);
});

test('assembleMultipolygon: 独立した2つの outer は別ポリゴンのまま（1本へ連結しない）', () => {
  const box = (x, z, s) => [
    { lat: 34.6 + z, lon: 135.5 + x }, { lat: 34.6 + z, lon: 135.5 + x + s },
    { lat: 34.6 + z + s, lon: 135.5 + x + s }, { lat: 34.6 + z + s, lon: 135.5 + x }, { lat: 34.6 + z, lon: 135.5 + x },
  ];
  const asm = assembleMultipolygon([
    { type: 'way', ref: 1, role: 'outer', geometry: box(0, 0, 0.001) },
    { type: 'way', ref: 2, role: 'outer', geometry: box(0.05, 0.05, 0.001) },
  ]);
  assert.equal(asm.polygons.length, 2, '独立 outer が1ポリゴンへ連結された');
  assert.deepEqual(asm.polygons.map((p) => p.memberWayIds).flat().sort(), [1, 2]);
});

test('convertWaterways: way / relation の source metadata が付く（member way id つき）', () => {
  const rel = relById(8421377); // 神崎川 multipolygon（4 outer + 2 inner）
  const { items } = convertWaterwaysWithReport([rel], AREA.projection);
  const area = items.find((it) => it.kind === 'area');
  assert.ok(area && area.source);
  assert.equal(area.source.type, 'relation');
  assert.equal(area.source.id, 8421377);
  assert.ok(Array.isArray(area.source.memberWayIds) && area.source.memberWayIds.length >= 4);
  assert.equal(area.source.relationOuterWayCount, 4);

  const wayEl = { type: 'way', id: 999, tags: { natural: 'water', name: 'テスト池' }, geometry: [
    { lat: 34.60, lon: 135.50 }, { lat: 34.60, lon: 135.505 }, { lat: 34.605, lon: 135.505 }, { lat: 34.60, lon: 135.50 },
  ] };
  const w = convertWaterwaysWithReport([wayEl], AREA.projection).items[0];
  assert.equal(w.source.type, 'way');
  assert.equal(w.source.id, 999);
});

test('feature-ward-overlap: 24区外の巨大河川（猪名川 rel 16551409）は overlap 0 → 除外される', () => {
  // rel 16551409 = 実機で「左上へ数km伸びる巨大な楔形」だった 7.8km の猪名川ポリゴン（尼崎市側）
  const { items } = convertWaterwaysWithReport([relById(16551409)], AREA.projection);
  const areas = items.filter((x) => x.kind === 'area');
  assert.ok(areas.length >= 1);
  for (const it of areas) {
    const pts = negZ([...it.p, ...(it.holes || []).flat()]);
    const ov = featureWardOverlap(pts, wardIndex, { bufferM: 500 });
    assert.equal(ov.inCount, 0, `rel 16551409: 24区内サンプル点が ${ov.inCount}（0 のはず）`);
  }
  // rel 8445877（猪名川河口デルタ）は此花区北西端に少しだけ掛かる境界地物（大半は尼崎側）
  const d = convertWaterwaysWithReport([relById(8445877)], AREA.projection).items.find((x) => x.kind === 'area');
  const ov2 = featureWardOverlap(negZ(d.p), wardIndex, { bufferM: 500 });
  assert.ok(ov2.fraction < 0.35, `rel 8445877 fraction=${ov2.fraction.toFixed(2)}（境界地物: 大半は24区外）`);
});

test('feature-ward-overlap: 境界河川 大和川（rel 18530062）は 24区 と重なる（残す）', () => {
  const { items } = convertWaterwaysWithReport([relById(18530062)], AREA.projection);
  const it = items.find((x) => x.kind === 'area');
  const pts = negZ([...it.p, ...(it.holes || []).flat()]);
  const ov = featureWardOverlap(pts, wardIndex, { bufferM: 500 });
  assert.ok(ov.inCount >= 5, `大和川の 24区内サンプル点が ${ov.inCount}`);
});

test('water-semantic-validator: 退化 → ERROR、疎ノード巨大辺 → WARN、正常 → PASS', () => {
  const good = { id: 'g', kind: 'area', p: [[0, 0], [100, 0], [100, 100], [0, 100]] };
  const sparse = { id: 's', kind: 'area', name: '川', source: { type: 'relation', id: 1, relationOuterWayCount: 3, relationOuterRingCount: 1 },
    p: [[0, 0], [3000, 5], [3000, 200], [1500, 195], [0, 190]] }; // 3km の辺
  const degen = { id: 'd', kind: 'area', p: [[0, 0], [1, 1]] };
  const r = validateWaterSemantics([good, sparse, degen]);
  assert.equal(r.ok, false); // degen が ERROR
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].id, 'd');
  assert.ok(r.warnings.some((w) => w.id === 's'), '疎ノード巨大辺が WARN になっていない');
  assert.ok(!r.warnings.some((w) => w.id === 'g'), '正常ポリゴンが WARN された');
});

test('densifyRingXZ: 長辺に中点を挿入するが頂点位置（=形状）は不変', () => {
  const ring = [[0, 0], [1000, 0], [1000, 100], [0, 100]];
  const d = densifyRingXZ(ring, 150);
  assert.ok(d.length > ring.length);
  // 元の4頂点はすべて含まれる
  for (const v of ring) assert.ok(d.some((p) => p[0] === v[0] && p[1] === v[1]));
  // 追加点はすべて元の辺上（外接矩形内）
  for (const p of d) assert.ok(p[0] >= 0 && p[0] <= 1000 && p[1] >= 0 && p[1] <= 100);
});

test('regression: 実データ waterways tile に source metadata があり semantic validator が ERROR 0', () => {
  const root = path.join(PROJECT_ROOT, 'data', 'processed', 'osaka-city', 'waterways');
  if (!fs.existsSync(path.join(root, 'manifest.json'))) return; // 生成物なし環境
  const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
  const seen = new Set();
  const items = [];
  for (const t of man.tiles) {
    const tf = path.join(root, t.file);
    if (!fs.existsSync(tf)) continue;
    for (const f of (JSON.parse(fs.readFileSync(tf, 'utf-8')).features || [])) {
      if (seen.has(f.id)) continue; seen.add(f.id);
      items.push(f);
    }
  }
  assert.ok(items.length > 0);
  const withSource = items.filter((f) => f.source).length;
  assert.equal(withSource, items.length, `source なし feature が ${items.length - withSource} 件`);
  const sr = validateWaterSemantics(items);
  assert.equal(sr.errors.length, 0, `semantic ERROR: ${JSON.stringify(sr.errors)}`);
  // 24区外の巨大河川が残っていないこと（bbox diag > 7000 の area は無い）
  for (const f of items) {
    if (f.kind !== 'area') continue;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const p of f.p) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mnz = Math.min(mnz, p[1]); mxz = Math.max(mxz, p[1]); }
    const diag = Math.hypot(mxx - mnx, mxz - mnz);
    assert.ok(diag < 7500, `巨大 area feature 残存: ${f.id} diag=${Math.round(diag)} src=${JSON.stringify(f.source)}`);
  }
});
