// tests/osm-source-coverage.test.js
// [Mission31] tools/lib/osm-source-coverage.js の純粋ロジック（§2/§4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xzToLatLon, n03Bbox, expandBboxKm, coverageContains, detectLatCliff,
} from '../tools/lib/osm-source-coverage.js';

test('[Mission31] xzToLatLon: 原点 = (34.604208, 135.52502)', () => {
  const o = xzToLatLon(0, 0);
  assert.ok(Math.abs(o.lat - 34.604208) < 1e-9);
  assert.ok(Math.abs(o.lon - 135.52502) < 1e-9);
  // z が負 = 北（lat 増加）
  assert.ok(xzToLatLon(0, -11132).lat > 34.604208);
  // x が正 = 東（lon 増加）
  assert.ok(xzToLatLon(1000, 0).lon > 135.52502);
});

test('[Mission31] §2 n03Bbox: ward polygon から WGS84 外接矩形', () => {
  // 合成: 原点付近の小さな区
  const wards = [{ polygons: [{ outer: [[-1000, -2000], [1000, -2000], [1000, 500], [-1000, 500]] }] }];
  const b = n03Bbox(wards);
  assert.ok(b.north > b.south);
  assert.ok(b.east > b.west);
  // z=-2000（北）→ lat 増、z=500（南）→ lat 減
  assert.ok(b.north > 34.604208 && b.south < 34.604208);
});

test('[Mission31] §2 expandBboxKm: 3km マージンで 4辺拡張', () => {
  const b = { south: 34.6, north: 34.7, west: 135.5, east: 135.6 };
  const e = expandBboxKm(b, 3);
  assert.ok(e.south < b.south && e.north > b.north);
  assert.ok(e.west < b.west && e.east > b.east);
  // 3km ≈ 0.027 度（緯度）
  assert.ok(Math.abs((b.south - e.south) - 3 / 111.32) < 1e-4);
});

test('[Mission31] §4 coverageContains: 4辺すべてで包含判定', () => {
  const required = { south: 34.56, north: 34.80, west: 135.31, east: 135.63 };
  // 完全包含
  assert.equal(coverageContains({ south: 34.55, north: 34.81, west: 135.30, east: 135.64 }, required).ok, true);
  // 北が足りない
  const r = coverageContains({ south: 34.55, north: 34.75, west: 135.30, east: 135.64 }, required);
  assert.equal(r.ok, false);
  assert.equal(r.sides.north, false);
  assert.equal(r.sides.south, true);
  assert.ok(r.shortfall.northKm > 0);
});

test('[Mission31] detectLatCliff: road node の急落を検出', () => {
  const hist = { '34.71': 25000, '34.72': 29000, '34.73': 20000, '34.74': 350, '34.75': 100 };
  const c = detectLatCliff(hist);
  assert.equal(c.cliffLat, 34.74);
  assert.ok(c.ratio >= 20);
  // 均一なら cliff なし
  assert.equal(detectLatCliff({ '34.71': 1000, '34.72': 1100, '34.73': 900, '34.74': 1050 }).cliffLat, null);
});

