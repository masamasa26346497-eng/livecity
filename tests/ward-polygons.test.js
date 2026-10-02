// tests/ward-polygons.test.js
// P1-3: N03 flat rings → {outer,holes} 再構成（tools/lib/ward-polygons.js）と
// 建物代表点（tools/lib/building-representative-point.js）のテスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { reconstructPolygons, buildWardPolygons, detectZAxisOrientation } from '../tools/lib/ward-polygons.js';
import { representativePoint } from '../tools/lib/building-representative-point.js';
import { pointInPolygonWithHoles } from '../tools/lib/point-in-polygon.js';

const REGISTRY = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8').replace(/^﻿/, ''));
const ring = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

test('reconstructPolygons: 単一ポリゴンはそのまま1 polygon', () => {
  const { polygons } = reconstructPolygons([ring(0, 0, 100, 100)]);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].holes.length, 0);
});

test('reconstructPolygons: 飛び地（disjoint 2リング）は 2 polygon・hole なし', () => {
  const { polygons } = reconstructPolygons([ring(0, 0, 100, 100), ring(500, 0, 600, 100)]);
  assert.equal(polygons.length, 2);
  assert.equal(polygons.every((p) => p.holes.length === 0), true);
});

test('reconstructPolygons: 大リング内の小リングは hole になる', () => {
  const { polygons } = reconstructPolygons([ring(0, 0, 1000, 1000), ring(400, 400, 600, 600)]);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].holes.length, 1);
  // hole 内の点は polygon 外
  assert.equal(pointInPolygonWithHoles(500, 500, polygons[0]), false);
  assert.equal(pointInPolygonWithHoles(50, 50, polygons[0]), true);
});

test('reconstructPolygons: hole の中の島（depth2）は新しい outer polygon になる', () => {
  const { polygons } = reconstructPolygons([
    ring(0, 0, 1000, 1000),   // outer
    ring(200, 200, 800, 800), // hole
    ring(400, 400, 600, 600), // 島（hole の中）
  ]);
  const totalHoles = polygons.reduce((s, p) => s + p.holes.length, 0);
  assert.equal(polygons.length, 2); // 大outer + 島outer
  assert.equal(totalHoles, 1);
  assert.equal(pointInPolygonWithHoles(500, 500, polygons.find((p) => p.holes.length === 0)), true); // 島の中
});

test('reconstructPolygons: 巻き順に依存しない（hole を CW/CCW どちらで与えても hole 判定）', () => {
  const holeCW = ring(400, 400, 600, 600);
  const holeCCW = [...holeCW].reverse();
  const a = reconstructPolygons([ring(0, 0, 1000, 1000), holeCW]);
  const b = reconstructPolygons([ring(0, 0, 1000, 1000), holeCCW]);
  assert.equal(a.polygons[0].holes.length, 1);
  assert.equal(b.polygons[0].holes.length, 1);
});

function n03Record(wardId, ringsLonLatAsXZ) {
  const reg = REGISTRY.wards.find((w) => w.id === wardId);
  return {
    wardId, wardCode: reg.code, wardName: reg.name, geometryType: 'MultiPolygon',
    geometry: { coordinatesConverted: true, coordinateConvention: 'znorth-neg-v1', rings: ringsLonLatAsXZ },
  };
}

test('buildWardPolygons: 24区分の rings から polygon/飛び地/hole を集計する', () => {
  const payload = {
    records: [
      n03Record('sumiyoshi', [ring(-100, -100, 100, 100)]),
      n03Record('higashisumiyoshi', [ring(200, -100, 400, 100), ring(600, -100, 700, 100)]), // 飛び地
      n03Record('hirano', [ring(-1000, -1000, 1000, 1000), ring(-200, -200, 200, 200)]),     // hole
    ],
    metadata: { license: 'x' },
  };
  const r = buildWardPolygons(payload, { registry: REGISTRY, zAxis: 'as-is' });
  assert.equal(r.wards.length, 3);
  const hs = r.wards.find((w) => w.wardId === 'higashisumiyoshi');
  assert.equal(hs.polygonCount, 2);
  assert.equal(hs.exclaveCount, 1);
  const hi = r.wards.find((w) => w.wardId === 'hirano');
  assert.equal(hi.holeCount, 1);
});

test('buildWardPolygons: coordinateConvention は常に znorth-neg-v1 を主張し、zAxisApplied を記録する', () => {
  const payload = { records: [n03Record('sumiyoshi', [ring(-100, -100, 100, 100)])] };
  const r = buildWardPolygons(payload, { registry: REGISTRY, zAxis: 'as-is' });
  assert.equal(r.coordinateConvention, 'znorth-neg-v1');
  assert.equal(r.zAxisApplied, 'as-is');
});

test('detectZAxisOrientation: 東住吉区・平野区の z 符号が参照と反転していれば needsNegate', () => {
  // 参照(znorth-neg-v1): higashisumiyoshi z≈-1610, hirano z≈-1120。
  // N03(北=z正) を模して z を正にする → 反転検出。
  const wardsPositiveZ = [
    { wardId: 'higashisumiyoshi', polygons: [{ outer: ring(0, 1400, 1200, 1900), holes: [] }] },
    { wardId: 'hirano', polygons: [{ outer: ring(3000, 700, 4000, 1300), holes: [] }] },
  ];
  const d = detectZAxisOrientation(wardsPositiveZ);
  assert.equal(d.needsNegate, true);
  assert.ok(d.mismatches >= 2);
});

test('detectZAxisOrientation: z 符号が参照と一致していれば needsNegate=false', () => {
  const wardsNegZ = [
    { wardId: 'higashisumiyoshi', polygons: [{ outer: ring(0, -1900, 1200, -1400), holes: [] }] },
    { wardId: 'hirano', polygons: [{ outer: ring(3000, -1300, 4000, -700), holes: [] }] },
  ];
  const d = detectZAxisOrientation(wardsNegZ);
  assert.equal(d.needsNegate, false);
});

test('buildWardPolygons zAxis:auto は反転を検出して z を negate する（移行前の +z 北データ）', () => {
  const payload = {
    records: [
      n03Record('higashisumiyoshi', [ring(0, 1400, 1200, 1900)]),
      n03Record('hirano', [ring(3000, 700, 4000, 1300)]),
    ],
  };
  const r = buildWardPolygons(payload, { registry: REGISTRY, zAxis: 'auto' });
  assert.equal(r.zAxisApplied, 'negate');
  const hi = r.wards.find((w) => w.wardId === 'hirano');
  assert.ok(hi.polygons[0].outer.every(([, z]) => z <= 0));
});

test('buildWardPolygons zAxis:auto は正しい znorth-neg-v1 データでは補正しない（as-is）', () => {
  // n03-boundaries.js 修正後（USER_DECISION 2026-08-31 a）は取り込み時点で z が反転され、
  // 北の区は z<0 側に来る。build-ward-polygons.js の auto 補正は不要になる。
  const payload = {
    records: [
      n03Record('higashisumiyoshi', [ring(0, -1900, 1200, -1400)]),
      n03Record('hirano', [ring(3000, -1300, 4000, -700)]),
    ],
  };
  const r = buildWardPolygons(payload, { registry: REGISTRY, zAxis: 'auto' });
  assert.equal(r.zAxisApplied, 'as-is');
  assert.equal(r.zAxisDetection.needsNegate, false);
});

test('実データ: 再生成された administrative-boundaries.json は既に znorth-neg-v1 で、auto補正は as-is になる', () => {
  const p = path.join(PROJECT_ROOT, 'data', 'processed', 'osaka-city', 'boundaries', 'administrative-boundaries.json');
  let payload;
  try { payload = JSON.parse(readFileSync(p, 'utf-8').replace(/^﻿/, '')); }
  catch { return; } // 生成物が無い環境ではskip扱い（アサートしない）
  const r = buildWardPolygons(payload, { registry: REGISTRY, zAxis: 'auto' });
  assert.equal(r.zAxisApplied, 'as-is', 'n03-boundaries.js 修正後は取り込み時点で znorth-neg-v1 のため補正不要');
  assert.equal(r.wards.length, 24);
  // 北側の区（東淀川区）は z<0、南側の区（住之江区）より z が小さい
  const hy = r.wards.find((w) => w.wardId === 'higashiyodogawa');
  const su = r.wards.find((w) => w.wardId === 'suminoe');
  const cz = (w) => w.polygons.flatMap((pp) => pp.outer).reduce((s, pt, _, a) => s + pt[1] / a.length, 0);
  assert.ok(cz(hy) < cz(su), '東淀川区(北)の方が住之江区(南)より z が小さい');
});

// ── 代表点 ──
test('representativePoint: 凸ポリゴンは centroid、内部に落ちる', () => {
  const rp = representativePoint(ring(0, 0, 10, 10));
  assert.equal(rp.method, 'centroid');
  assert.equal(rp.valid, true);
});

test('representativePoint: L字（凹）ポリゴンは centroid が外に出るので interior-scanline で内部点', () => {
  // L字: (0,0)-(10,0)-(10,4)-(4,4)-(4,10)-(0,10)
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
  const rp = representativePoint(L);
  assert.equal(rp.valid, true);
  // 代表点は L字の内部にある
  assert.equal(pointInPolygonWithHoles(rp.x, rp.z, { outer: L, holes: [] }), true);
  assert.notEqual(rp.method, 'bbox-center');
});

test('representativePoint: 不正フットプリント（頂点数<3）は valid:false', () => {
  assert.equal(representativePoint([[0, 0], [1, 1]]).valid, false);
  assert.equal(representativePoint([[0, 0], [NaN, 1], [2, 2]]).valid, false);
});
