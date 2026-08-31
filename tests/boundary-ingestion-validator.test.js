// tests/boundary-ingestion-validator.test.js
// P1-2: 行政区境界取り込みvalidator（tools/lib/boundary-ingestion-validator.js）のテスト。
//
// AUTODEV_BACKLOG.md P1-2 の確認項目:
//   polygon parse成功 / ward code一致 / polygonが空でない / NaNなし /
//   異常自己交差の検出可能性 / znorth-neg-v1整合 / 既存3区を壊していない
//
// あわせて config/areas/osaka-city.json が既存 osaka-sumiyoshi と同一 projection であること
// （既存3区の座標を変えない = AUTODEV_RULES.md 4条）も検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { ingestN03FeatureCollection } from '../tools/lib/n03-boundaries.js';
import { validateBoundaryIngestion, evaluateRing } from '../tools/lib/boundary-ingestion-validator.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8').replace(/^﻿/, '')); // 一部エディタのUTF-8 BOMを許容
const REGISTRY = readJson(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'));
const OSAKA_CITY_AREA = readJson(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'));
const OSAKA_SUMIYOSHI_AREA = readJson(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-sumiyoshi.json'));

// 24区 + 一部を複数Feature分割した synthetic N03 FeatureCollection。
// 各区の矩形は registry の実bboxに緩く合わせ、既存3区は legacy osaka-sumiyoshi エリアと重なる位置に置く。
const WARD_BOXES = {
  sumiyoshi: [135.487, 34.586, 135.524, 34.625],
  higashisumiyoshi: [135.514, 34.591, 135.548, 34.645],
  hirano: [135.541, 34.587, 135.587, 34.644],
};
function boxFor(ward, i) {
  if (WARD_BOXES[ward.id]) return WARD_BOXES[ward.id];
  const lon = 135.44 + (i % 8) * 0.02;
  const lat = 34.62 + Math.floor(i / 8) * 0.03;
  return [lon, lat, lon + 0.015, lat + 0.02];
}
function rectRing([w, s, e, n]) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}
function build24WardFixture() {
  const features = [];
  REGISTRY.wards.forEach((ward, i) => {
    const [w, s, e, n] = boxFor(ward, i);
    const split = i % 5 === 0; // 一部の区を2Featureに分割
    if (split) {
      const mid = (w + e) / 2;
      features.push(feat(ward, rectRing([w, s, mid, n])));
      features.push(feat(ward, rectRing([mid, s, e, n])));
    } else {
      features.push(feat(ward, rectRing([w, s, e, n])));
    }
  });
  return { type: 'FeatureCollection', features };
}
function feat(ward, ring) {
  return {
    type: 'Feature',
    properties: { N03_001: '大阪府', N03_004: '大阪市', N03_005: ward.name, N03_007: ward.code },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function withProvenance(payload) {
  return { ...payload, metadata: { license: 'N03約款', referenceDate: '2026-01-01', retrievedUrl: 'https://nlftp.mlit.go.jp/ksj/' } };
}

test('config/areas/osaka-city.json の projection は osaka-sumiyoshi と数値が完全一致（既存3区の座標を変えない）', () => {
  const pick = (p) => ({ type: p.type, centerLat: p.centerLat, centerLon: p.centerLon, metersPerDegree: p.metersPerDegree });
  assert.deepEqual(pick(OSAKA_CITY_AREA.projection), pick(OSAKA_SUMIYOSHI_AREA.projection));
});

test('config/areas/osaka-city.json の bbox は既存3区の緯度経度をすべて含む', () => {
  const b = OSAKA_CITY_AREA.bbox;
  for (const [w, s, e, n] of Object.values(WARD_BOXES)) {
    assert.ok(b.west <= w && b.east >= e, 'bbox経度が区を含む');
    assert.ok(b.south <= s && b.north >= n, 'bbox緯度が区を含む');
  }
});

test('validator: 24区・znorth-neg-v1変換済みの正常データは error なしで通過する', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(ingest.recordCount, 24);
  const payload = withProvenance({ records: ingest.records });
  const result = validateBoundaryIngestion(payload, REGISTRY, { projection: OSAKA_CITY_AREA.projection, areaId: 'osaka-city' });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.pass), null, 2));
  assert.equal(result.summary.convertedWards, 24);
  const conv = result.checks.find((c) => c.name === 'znorth-neg-v1-tag');
  assert.equal(conv.pass, true);
});

test('validator: 1区でも欠けると all-wards-present が FAIL する', () => {
  const fc = build24WardFixture();
  fc.features = fc.features.filter((f) => f.properties.N03_005 !== '西成区');
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.ok, false);
  const c = result.checks.find((x) => x.name === 'all-wards-present');
  assert.equal(c.pass, false);
  assert.match(c.detail, /西成区|nishinari/);
});

test('validator: wardCode を registry と不一致に書き換えると ward-identity-matches-registry が FAIL する', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  ingest.records[0].wardCode = '99999';
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'ward-identity-matches-registry').pass, false);
});

test('validator: NaN座標を混入させると coords-finite が FAIL する', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  ingest.records[3].geometry.rings[0][1][0] = NaN;
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'coords-finite').pass, false);
});

test('validator: 空リングの区は rings-non-empty が FAIL する', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  ingest.records[5].geometry.rings = [[]];
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'rings-non-empty').pass, false);
});

test('validator: 変換済みだが coordinateConvention が別値だと znorth-neg-v1-tag が FAIL する', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  ingest.records[2].geometry.coordinateConvention = 'legacy-z-positive';
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'znorth-neg-v1-tag').pass, false);
});

test('validator: 既存3区(住吉区/東住吉区/平野区)が欠けると known-wards-stable が FAIL する', () => {
  const fc = build24WardFixture();
  fc.features = fc.features.filter((f) => f.properties.N03_005 !== '住吉区');
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  const result = validateBoundaryIngestion(withProvenance({ records: ingest.records }), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(result.checks.find((c) => c.name === 'known-wards-stable').pass, false);
});

test('validator: 生WGS84のまま(未変換)でも構造検証は通り、混在は coordinate-convention-consistent が FAIL する', () => {
  const fc = build24WardFixture();
  const raw = ingestN03FeatureCollection(fc, REGISTRY); // projection なし
  const okResult = validateBoundaryIngestion(withProvenance({ records: raw.records }), REGISTRY, {});
  assert.equal(okResult.checks.find((c) => c.name === 'coordinate-convention-consistent').pass, true);

  const converted = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  const mixed = { records: [raw.records[0], ...converted.records.slice(1)] };
  const mixedResult = validateBoundaryIngestion(withProvenance(mixed), REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  assert.equal(mixedResult.checks.find((c) => c.name === 'coordinate-convention-consistent').pass, false);
});

test('validator: metadata の出典が未記録だと provenance-recorded が WARN（error にはしない）', () => {
  const fc = build24WardFixture();
  const ingest = ingestN03FeatureCollection(fc, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  const result = validateBoundaryIngestion({ records: ingest.records }, REGISTRY, { projection: OSAKA_CITY_AREA.projection });
  const c = result.checks.find((x) => x.name === 'provenance-recorded');
  assert.equal(c.pass, false);
  assert.equal(c.severity, 'warning');
  assert.equal(result.ok, true); // warning のみなら ok
});

test('evaluateRing: 地物を横断する巨大な辺（未連結multipolygonの典型）を oversizedSegments として検出する', () => {
  // 小さな四角形の途中に、bbox対角を大きく超える1辺を差し込む
  const ring = [[0, 0], [100, 0], [100, 100], [2000, 3000], [0, 100], [0, 0]];
  const ev = evaluateRing(ring);
  assert.ok(ev.oversizedSegments >= 1);
});

test('evaluateRing: 自己交差する砂時計型リングを selfIntersections として検出する', () => {
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]];
  const ev = evaluateRing(bowtie);
  assert.ok(ev.selfIntersections >= 1);
});

test('evaluateRing: 正常な凸リングは自己交差・巨大辺なし', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
  const ev = evaluateRing(square);
  assert.equal(ev.selfIntersections, 0);
  assert.equal(ev.oversizedSegments, 0);
  assert.equal(ev.closed, true);
});
