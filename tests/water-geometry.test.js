// tests/water-geometry.test.js
// 河川・水域の変換（tools/convert/waterways.js）と幾何検証（tools/lib/water-geometry-validator.js）のテスト。
//
// 要件（河川geometry修正）:
//  - relation の outer member way を連結して閉リングにする（個別polygon化しない）
//  - inner ring（中州）を holes として保持する
//  - 未連結フラグメントは三角形分割せず報告する
//  - 巨大セグメント検出validatorが「川面を横断する巨大三角形」の原因を検出する
//  - 大和川など長大河川で巨大セグメントが出ないことを確認する

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { convertWaterways, convertWaterwaysWithReport } from '../tools/convert/waterways.js';
import { validateWaterGeometry } from '../tools/lib/water-geometry-validator.js';

const FIXTURE = JSON.parse(readFileSync(
  path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'water', 'overpass-water-sample.json'), 'utf-8'));
const PROJECTION = { type: 'local-equirectangular', centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };

test('convertWaterways: riverbank relation を1つの面（holes 1本）に組み立てる（個別way面化しない）', () => {
  const { items, unclosed } = convertWaterwaysWithReport(FIXTURE.elements, PROJECTION);
  const riverbanks = items.filter((w) => w.name === '大和川河岸');
  assert.equal(riverbanks.length, 1, 'outer 3本が1面に統合される');
  assert.equal(riverbanks[0].kind, 'area');
  assert.ok(Array.isArray(riverbanks[0].holes) && riverbanks[0].holes.length === 1, 'inner ring(中州)が holes として保持される');
});

test('convertWaterways: 連結できない relation は面を生成せず unclosed に記録する', () => {
  const { items, unclosed } = convertWaterwaysWithReport(FIXTURE.elements, PROJECTION);
  assert.ok(!items.some((w) => w.name === '連結不能テスト'), '壊れたrelationからは面を出さない');
  assert.ok(unclosed.some((u) => u.id === 'relation/18530100'));
});

test('convertWaterways: 河川ラインと閉way池はこれまで通り変換される（既存挙動を壊さない）', () => {
  const items = convertWaterways(FIXTURE.elements, PROJECTION);
  const river = items.find((w) => w.name === '大和川' && w.kind === 'line');
  assert.ok(river && river.p.length >= 3 && !river.holes);
  const pond = items.find((w) => w.name === 'テスト池');
  assert.ok(pond && pond.kind === 'area' && pond.p.length === 4); // 閉ポリゴンの終点重複が除去される
});

test('組み立てた riverbank 面に巨大セグメントが無い（大和川の巨大三角形が消える）', () => {
  const items = convertWaterways(FIXTURE.elements, PROJECTION);
  const result = validateWaterGeometry(items);
  assert.equal(result.ok, true, JSON.stringify(result.offenders));
  assert.equal(result.summary.oversizedSegments, 0);
});

test('validateWaterGeometry: 個別way面化された旧データ（暗黙閉合辺が巨大）を巨大セグメントとして検出する', () => {
  // 旧 fetch-water.js の挙動を再現: relation の outer member を1本ずつ閉ポリゴンにした面。
  // member way の終点→始点をむすぶ暗黙の閉合辺が地物全体（約2km）を横断する。
  const legacyBad = [{
    id: 'relation/18530099', name: '大和川河岸(旧)', kind: 'area', subtype: 'riverbank',
    p: [[0, 0], [1000, 0], [2000, 20]], // 3点。三角形分割時に (2000,20)->(0,0) の約2kmの辺ができる
  }];
  const result = validateWaterGeometry(legacyBad);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'no-oversized-segments').pass, false);
  assert.ok(result.offenders[0].oversizedSegments >= 1);
});

test('validateWaterGeometry: 河川ライン（中心線）は長い直線区間があっても巨大セグメント扱いしない', () => {
  const line = [{ id: 'way/1', name: '長い川', kind: 'line', subtype: 'river', p: [[0, 0], [3000, 0], [6000, 100]] }];
  const result = validateWaterGeometry(line);
  assert.equal(result.ok, true);
});

test('validateWaterGeometry: 非有限座標を検出する', () => {
  const bad = [{ id: 'way/2', kind: 'area', p: [[0, 0], [10, 0], [NaN, 5], [0, 10]] }];
  const result = validateWaterGeometry(bad);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'coords-finite').pass, false);
});
