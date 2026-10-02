// tests/osm-multipolygon.test.js
// OSM multipolygon relation の member way 連結（tools/lib/osm-multipolygon.js）のテスト。
//
// 要件（河川geometry修正）:
//  - outer wayを単純に個別polygon化しない
//  - endpoint一致でwayを連結する
//  - reversed wayも考慮する
//  - inner ring（中州）も保持する
//  - 未連結ringは黙って三角形分割せず検出・報告する

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stitchWays, assembleMultipolygon } from '../tools/lib/osm-multipolygon.js';

test('stitchWays: 端点一致で3本のwayを1つの閉リングへ連結する', () => {
  const w1 = [[0, 0], [10, 0], [20, 0]];
  const w2 = [[20, 0], [20, -10], [10, -10]];
  const w3 = [[10, -10], [0, -10], [0, 0]];
  const { rings, unclosed } = stitchWays([w1, w2, w3]);
  assert.equal(rings.length, 1);
  assert.equal(unclosed.length, 0);
  const r = rings[0];
  assert.deepEqual(r[0], r[r.length - 1], '閉じている');
  assert.ok(r.length >= 7);
});

test('stitchWays: 逆順(reversed)のwayも向きを合わせて連結する', () => {
  const w1 = [[0, 0], [10, 0], [20, 0]];
  const w2 = [[20, 0], [20, -10], [10, -10]];
  const w3reversed = [[0, 0], [0, -10], [10, -10]]; // 実際の向きは [10,-10]->[0,-10]->[0,0]
  const { rings, unclosed } = stitchWays([w1, w2, w3reversed]);
  assert.equal(rings.length, 1);
  assert.equal(unclosed.length, 0);
  assert.deepEqual(rings[0][0], rings[0][rings[0].length - 1]);
});

test('stitchWays: 連結できないway片は unclosed として返す（黙って捨てない）', () => {
  const a = [[0, 0], [10, 0]];
  const b = [[50, 0], [60, 0]];
  const { rings, unclosed } = stitchWays([a, b]);
  assert.equal(rings.length, 0);
  assert.equal(unclosed.length, 2);
});

test('stitchWays: 単独で閉じているway（島）はそのままリングになる', () => {
  const island = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
  const { rings, unclosed } = stitchWays([island]);
  assert.equal(rings.length, 1);
  assert.equal(unclosed.length, 0);
});

test('assembleMultipolygon: outer 3本＋inner 1本 → 1 polygon（holes 1本）に組み立てる', () => {
  const members = [
    { type: 'way', role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 10, lat: 0 }] },
    { type: 'way', role: 'outer', geometry: [{ lon: 10, lat: 0 }, { lon: 10, lat: 10 }] },
    { type: 'way', role: 'outer', geometry: [{ lon: 10, lat: 10 }, { lon: 0, lat: 10 }, { lon: 0, lat: 0 }] },
    { type: 'way', role: 'inner', geometry: [{ lon: 3, lat: 3 }, { lon: 6, lat: 3 }, { lon: 6, lat: 6 }, { lon: 3, lat: 6 }, { lon: 3, lat: 3 }] },
  ];
  const asm = assembleMultipolygon(members);
  assert.equal(asm.polygons.length, 1);
  assert.equal(asm.polygons[0].holes.length, 1);
  assert.equal(asm.unclosed.length, 0);
  assert.equal(asm.stats.holesAssigned, 1);
  assert.equal(asm.stats.outerRings, 1);
});

test('assembleMultipolygon: role未指定のmemberはouter扱い（黙って捨てない）', () => {
  const members = [
    { type: 'way', geometry: [{ lon: 0, lat: 0 }, { lon: 10, lat: 0 }, { lon: 10, lat: 10 }] },
    { type: 'way', geometry: [{ lon: 10, lat: 10 }, { lon: 0, lat: 10 }, { lon: 0, lat: 0 }] },
  ];
  const asm = assembleMultipolygon(members);
  assert.equal(asm.polygons.length, 1);
});

test('assembleMultipolygon: 連結不能なrelationは polygon 0・unclosed>0 を返す', () => {
  const members = [
    { type: 'way', role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }] },
    { type: 'way', role: 'outer', geometry: [{ lon: 5, lat: 0 }, { lon: 6, lat: 0 }] },
  ];
  const asm = assembleMultipolygon(members);
  assert.equal(asm.polygons.length, 0);
  assert.ok(asm.unclosed.length >= 2);
  assert.equal(asm.stats.unclosed, asm.unclosed.length);
});

test('assembleMultipolygon: 組み立てたouter ringの始点=終点（暗黙閉合辺が地物を横断しない）', () => {
  // 個別way閉ポリゴン化の旧挙動では、各memberが閉じておらず終点→始点をむすぶ巨大な辺ができていた。
  // 連結後は明示的に閉じた1リングになるため、三角形分割時の暗黙閉合辺は生じない。
  const members = [
    { type: 'way', role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 5, lat: 0 }, { lon: 10, lat: 0 }] },
    { type: 'way', role: 'outer', geometry: [{ lon: 10, lat: 0 }, { lon: 10, lat: 5 }, { lon: 10, lat: 10 }] },
    { type: 'way', role: 'outer', geometry: [{ lon: 10, lat: 10 }, { lon: 5, lat: 10 }, { lon: 0, lat: 10 }, { lon: 0, lat: 0 }] },
  ];
  const asm = assembleMultipolygon(members);
  assert.equal(asm.polygons.length, 1);
  const ring = asm.polygons[0].outer;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'リングが明示的に閉じている');
  assert.equal(asm.unclosed.length, 0);
});
