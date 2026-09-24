// tests/citywide-missing-recovery.test.js
// [Mission 35D] 24 区全域の missing building recovery
//   - 形の健全性 / 水域除外 / 3 次メッシュ相当の座標変換
//   - 重複判定（既存を包むだけの輪郭を足さない・回収分どうしの重複）
//   - 既存 PLATEAU を 1 棟も壊さない（§0/§11）
//   - dev に V4 の切替がある / production には入っていない（§10/§15）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shapeMetrics, shapeIsPlausible, SHAPE_GUARD, isInWater, pointInRing, bboxIoU,
  cityLatLonBbox, latitudeCliff, distanceToNearestWard, resolvePbf,
  MIN_FP_AREA_M2, MAX_FP_AREA_M2, WARD_EDGE_TOLERANCE_M, GROUND_EXTENT, CITY_MARGIN,
} from '../tools/audit/citywide-missing-buildings.js';
import { isEnvelopeOfExisting, MULTI_MATCH, dedupeRecovered, recoveredFeature, GENERATION } from '../tools/build-final-buildings-v4.js';
import { FIXTURES, anchorWorld, matchFixture, loadCanonicalIds } from '../tools/audit/missing-recovery-fixtures.js';
import { ringsEqual, FIXED, OTHER_LAYERS, loadSet } from '../tools/validate/citywide-missing-recovery.js';
import { latLonToLiveCityWorld } from '../tools/lib/livecity-coordinate-system.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const V2N_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

const SQUARE = [[0, 0], [20, 0], [20, 10], [0, 10]];

// ── 形の健全性（§5）──────────────────────────────────────────────────────
test('35D 普通の建物の形は通る', () => {
  const sm = shapeMetrics(SQUARE);
  assert.ok(Math.abs(sm.areaM2 - 200) < 0.01);
  assert.ok(Math.abs(sm.aspect - 2) < 0.01, 'aspect=' + sm.aspect);
  assert.ok(sm.rectangularity > 0.95, 'rect=' + sm.rectangularity);
  assert.equal(shapeIsPlausible(sm).ok, true);
});

test('35D 細長すぎる形は建物として採らない（塀や道路の誤登録）', () => {
  const wall = [[0, 0], [300, 0], [300, 1.5], [0, 1.5]];
  const sm = shapeMetrics(wall);
  assert.ok(sm.aspect > SHAPE_GUARD.maxAspect, 'aspect=' + sm.aspect);
  const r = shapeIsPlausible(sm);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-elongated');
});

test('35D 小さすぎる / 大きすぎる footprint は採らない', () => {
  assert.equal(shapeIsPlausible(shapeMetrics([[0, 0], [2, 0], [2, 1], [0, 1]])).reason, 'too-small');
  const huge = [[0, 0], [400, 0], [400, 400], [0, 400]];
  assert.equal(shapeIsPlausible(shapeMetrics(huge)).reason, 'too-big');
  assert.equal(SHAPE_GUARD.minAreaM2, MIN_FP_AREA_M2);
  assert.equal(SHAPE_GUARD.maxAreaM2, MAX_FP_AREA_M2);
});

test('35D 形が壊れている（OBB をほとんど埋めない）ものは採らない', () => {
  // 面積はあるが OBB に対して非常に薄い十字の一部のような形
  const spiky = [[0, 0], [100, 0], [100, 2], [52, 2], [52, 100], [48, 100], [48, 2], [0, 2]];
  const sm = shapeMetrics(spiky);
  assert.ok(sm.rectangularity < SHAPE_GUARD.minRectangularity, 'rect=' + sm.rectangularity);
  assert.equal(shapeIsPlausible(sm).reason, 'degenerate-shape');
});

// ── 水域（§5）────────────────────────────────────────────────────────────
test('35D 水面の中の点を判定できる', () => {
  const water = { cellM: 200, polys: [{ ring: [[0, 0], [100, 0], [100, 100], [0, 100]], bb: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 } }],
    index: new Map([['0,0', [0]]]) };
  assert.equal(isInWater(50, 50, water), true);
  assert.equal(isInWater(150, 150, water), false);
  assert.equal(pointInRing(50, 50, water.polys[0].ring), true);
});

// ── 市域 bbox（§6）──────────────────────────────────────────────────────
test('35D 市域 bbox は 24 区の北端まで届いている', () => {
  const b = cityLatLonBbox();
  // N03 大阪市の北端は約 34.7688。余白込みでそれを超えていること。
  assert.ok(b.north > 34.78, 'north=' + b.north);
  assert.ok(b.south < 34.58, 'south=' + b.south);
  assert.ok(b.west < 135.35 && b.east > 135.60, JSON.stringify(b));
  // GROUND_EXTENT + CITY_MARGIN と整合している
  const w = latLonToLiveCityWorld(b.north, b.west);
  assert.ok(Math.abs(w.z - (GROUND_EXTENT.minZ - CITY_MARGIN)) < 1, 'z=' + w.z);
});

test('35D 緯度の崖を検出できる', () => {
  const clipped = { '34.70': 60000, '34.71': 58000, '34.72': 92708, '34.73': 9011 };
  const c = latitudeCliff(clipped);
  assert.ok(c, '崖を見つけられていない');
  assert.equal(c.atLat, 34.73);
  assert.ok(c.ratio >= 10);
  // 切れていないデータでは崖にならない
  assert.equal(latitudeCliff({ '34.70': 6000, '34.71': 5800, '34.72': 6200, '34.73': 5900 }), null);
});

test('35D 区界からの距離を測れる', () => {
  const wards = [{ wardId: 'w', bbox: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 },
    polygons: [{ outer: [[0, 0], [100, 0], [100, 100], [0, 100]], holes: [] }] }];
  assert.ok(Math.abs(distanceToNearestWard(110, 50, wards) - 10) < 0.01);
  assert.equal(distanceToNearestWard(5000, 5000, wards), null, '遠すぎるものは測らない');
  assert.ok(WARD_EDGE_TOLERANCE_M > 0 && WARD_EDGE_TOLERANCE_M <= 50);
});

test('35D 広域 PBF があればそちらを使う', () => {
  const wide = path.join(ROOT, 'data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf');
  const got = resolvePbf();
  if (fs.existsSync(wide)) assert.equal(got, wide, '広域 PBF があるのに使っていない');
  else assert.match(got, /osaka-latest\.osm\.pbf$/);
  assert.equal(resolvePbf('x.pbf'), path.resolve('x.pbf'));
});

// ── 重複判定（§5）────────────────────────────────────────────────────────
test('35D 既存の複数棟を包んでいるだけの輪郭は足さない', () => {
  assert.equal(isEnvelopeOfExisting({ partners: 3, overlapRatioToOsm: 0.8 }), true);
  assert.equal(isEnvelopeOfExisting({ partners: 1, overlapRatioToOsm: 0.9 }), false, '1 棟だけなら包みではない');
  assert.equal(isEnvelopeOfExisting({ partners: 4, overlapRatioToOsm: 0.2 }), false, '重なりが小さければ別建物');
  assert.equal(isEnvelopeOfExisting(null), false);
  assert.ok(MULTI_MATCH.minPartners >= 2 && MULTI_MATCH.coveredByPartners > 0.5);
});

test('35D 回収分どうしの重複を落とし、情報の多い方を残す', () => {
  const ring = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const a = { canonicalId: 'cg_bldg_osm_1', wayId: 1, ring, areaM2: 400, tags: { name: 'A', 'building:levels': '10' } };
  const b = { canonicalId: 'cg_bldg_osm_2', wayId: 2, ring: ring.map(([x, z]) => [x + 0.5, z + 0.5]), areaM2: 400, tags: {} };
  const r = dedupeRecovered([a, b]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].canonicalId, 'cg_bldg_osm_1', '名前と階数がある方を残す');
  assert.equal(r.droppedIds.length, 1);
});

test('35D 離れた 2 棟は両方残す', () => {
  const a = { canonicalId: 'cg_bldg_osm_1', wayId: 1, ring: [[0, 0], [20, 0], [20, 20], [0, 20]], areaM2: 400, tags: {} };
  const b = { canonicalId: 'cg_bldg_osm_2', wayId: 2, ring: [[500, 500], [520, 500], [520, 520], [500, 520]], areaM2: 400, tags: {} };
  assert.equal(dedupeRecovered([a, b]).kept.length, 2);
});

test('35D bbox IoU の計算', () => {
  const a = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.ok(Math.abs(bboxIoU(a, a) - 1) < 1e-9);
  assert.equal(bboxIoU(a, { minX: 100, maxX: 110, minZ: 0, maxZ: 10 }), 0);
});

// ── 回収した棟の形（§7）─────────────────────────────────────────────────
test('35D 回収した棟は picking に必要な情報を持つ', () => {
  const c = { canonicalId: 'cg_bldg_osm_99', wayId: 99, wardId: 'kita', areaM2: 400,
    ring: [[0, 0], [20, 0], [20, 20], [0, 20]], tags: { building: 'apartments', 'building:levels': '12', name: 'テスト' },
    cls: 'VALID_FALLBACK', rule: 'no-overlap', metrics: { partners: 0 } };
  const { feature, attrs } = recoveredFeature(c, '2026-01-01T00:00:00.000Z');
  assert.equal(feature.canonicalId, 'cg_bldg_osm_99');
  assert.equal(feature.layer, 'buildings');
  assert.equal(feature.geometryType, 'Polygon');
  assert.equal(feature.coordinateConvention, 'znorth-neg-v1');
  assert.ok(feature.qaFlags.includes('recovered:35D'));
  assert.equal(attrs.wardId, 'kita');
  assert.ok(attrs.usageCategory, '用途カテゴリが無いと色も card も出ない');
  assert.ok(attrs.heightM > 0);
  assert.equal(attrs.recoveredBy, 'mission-35D');
  assert.equal(attrs.generationVersion, GENERATION);
  // §7 実測が無ければ高さを無理に主張しない
  const noTag = recoveredFeature({ ...c, tags: { building: 'yes' } }, '2026-01-01T00:00:00.000Z');
  assert.equal(noTag.attrs.heightUnknown, true);
  assert.ok(noTag.feature.qaFlags.includes('height-unknown'));
});

test('35D 実測タグがある棟は 60m の頭打ちを外す', () => {
  const tall = { canonicalId: 'cg_bldg_osm_5', wayId: 5, wardId: 'kita', areaM2: 1000,
    ring: [[0, 0], [30, 0], [30, 30], [0, 30]], tags: { building: 'apartments', height: '160' },
    cls: 'VALID_FALLBACK', rule: 'no-overlap' };
  const { attrs } = recoveredFeature(tall, '2026-01-01T00:00:00.000Z');
  assert.ok(attrs.heightM > 60, '49 階建てが 60m に潰れてはいけない: ' + attrs.heightM);
  assert.equal(attrs.heightRelaxed, true);
  assert.ok(attrs.heightM <= attrs.heightCapM);
});

// ── 代表ケース（§4）─────────────────────────────────────────────────────
test('35D §4 の必須確認対象がすべて定義されている', () => {
  const ids = FIXTURES.map((f) => f.id);
  for (const need of ['brillia-tower-dojima', 'grand-green-osaka', 'osaka-station',
    'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi', 'higashiyodogawa']) {
    assert.ok(ids.includes(need), need + ' が無い');
  }
  for (const f of FIXTURES) {
    assert.ok(f.anchor && Number.isFinite(f.anchor.lat) && Number.isFinite(f.anchor.lon), f.id + ' の anchor が緯度経度でない');
    assert.ok(f.patterns.length > 0);
  }
});

test('35D anchor は正本の座標変換を通す', () => {
  const f = FIXTURES.find((x) => x.id === 'brillia-tower-dojima');
  const w = anchorWorld(f.anchor);
  const ref = latLonToLiveCityWorld(f.anchor.lat, f.anchor.lon);
  assert.equal(w.x, ref.x);
  assert.equal(w.z, ref.z);
  // 堂島は梅田のすぐ南西。おおよその位置を固定して取り違えを防ぐ。
  assert.ok(Math.abs(w.x - (-2993)) < 5, 'x=' + w.x);
  assert.ok(Math.abs(w.z - (-10069)) < 5, 'z=' + w.z);
});

test('35D fixture は名前と地点の両方で拾える', () => {
  const fx = FIXTURES.find((x) => x.id === 'brillia-tower-dojima');
  const a = anchorWorld(fx.anchor);
  assert.equal(matchFixture({ tags: { name: 'ブリリアタワー堂島' }, ring: [[0, 0], [1, 0], [1, 1]] }, fx), 'name');
  assert.equal(matchFixture({ tags: {}, ring: [[a.x, a.z], [a.x + 1, a.z], [a.x + 1, a.z + 1]] }, fx), 'anchor');
  assert.equal(matchFixture({ tags: {}, ring: [[9999, 9999], [10000, 9999], [10000, 10000]] }, fx), null);
});

// ── §0/§11 壊さない ─────────────────────────────────────────────────────
test('35D geometry の同一判定は丸め誤差も許さない', () => {
  assert.equal(ringsEqual([[1, 2], [3, 4]], [[1, 2], [3, 4]]), true);
  assert.equal(ringsEqual([[1, 2], [3, 4]], [[1, 2], [3, 4.01]]), false);
  assert.equal(ringsEqual([[1, 2]], [[1, 2], [3, 4]]), false);
  assert.equal(ringsEqual(null, [[1, 2]]), false);
});

test('35D 変えてはならない件数が記録されている', () => {
  assert.equal(FIXED.plateau, 574112);
  assert.equal(FIXED.v2nTotal, 600764);
  assert.equal(FIXED.existingFallback, 26652);
  assert.equal(FIXED.plateau + FIXED.existingFallback, FIXED.v2nTotal);
  assert.equal(OTHER_LAYERS.water, 528);
  assert.equal(OTHER_LAYERS.rail, 2828);
});

test('35D V2N の PLATEAU 数が変わっていない', { skip: V2N_SKIP }, () => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'));
  assert.ok(m, 'V2N manifest が無い');
  assert.equal(m.featureCount, FIXED.v2nTotal);
  assert.equal(m.plateauCount, FIXED.plateau);
});

// ── §10/§15 dev のみ ────────────────────────────────────────────────────
test('35D dev に V4 の切替がある', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.match(html, /derived-v4-final/);
  assert.match(html, /V4 REBUILT FINAL/);
  assert.match(html, /MissingRecoveryDiffLayer/);
  assert.match(html, /DIFF: MISSING RECOVERY/);
  assert.match(html, /__MISSING_RECOVERY__/);
  // V2N / V3 の切替は残っている（消していない）
  assert.match(html, /derived-v2-osmv2/);
  assert.match(html, /derived-v2-osmv3/);
});

test('35D production / protected に V4 が入っていない', () => {
  const prod = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
  const prot = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
  // [Mission 35G] production はユーザー承認のうえ V4（618,749）へ昇格した。
  //   protected（fullward-v3）は引き続き 1 バイトも変えない。
  if (fs.existsSync(prod)) {
    const html = fs.readFileSync(prod, 'utf-8');
    assert.match(html, /let buildingsVersion = 'V4';/, 'production が V4 でない');
    assert.match(html, /derived-v4-final/);
  }
  if (fs.existsSync(prot)) {
    const html = fs.readFileSync(prot, 'utf-8');
    assert.ok(!/derived-v4-final/.test(html), 'protected に V4 が入っている');
    assert.ok(!/MissingRecoveryDiffLayer/.test(html), 'protected に 35D の QA 層が入っている');
  }
});

// ── 実測（レポートがあるときだけ）───────────────────────────────────────
test('35D 実測: 早期重複判定に取り違えが無かったことを確かめている', { skip: skip('citywide-missing-buildings.json') }, () => {
  const a = rpt('citywide-missing-buildings.json');
  assert.ok(a.counts.wouldBeEarlyDuplicate > 100000, '早期判定の対象が数えられていない');
  assert.equal(a.counts.earlyDuplicateFalsePositive, 0,
    '早期判定が実在建物を落としていたなら 34C の結論を見直す必要がある');
  assert.equal(a.counts.measured + a.counts.noCandidate, a.counts.total, '全件を測っていない');
});

test('35D 実測: 広域 PBF で北側の崖が解消している', { skip: skip('citywide-missing-buildings.json') }, () => {
  const a = rpt('citywide-missing-buildings.json');
  if (a.osmSource && /full-coverage/.test(a.osmSource)) {
    assert.equal(a.latitudeCliff, null, '広域 PBF なのに緯度の崖が残っている');
    const hy = a.wardRanking.find((w) => w.wardId === 'higashiyodogawa');
    assert.ok(hy && hy.newlyRecoverable > 500, '東淀川区の回収数が少なすぎる: ' + JSON.stringify(hy));
  }
  assert.equal(a.wardRanking.length, 24, '24 区すべてを報告していない');
});

test('35D 実測: 水域の中の偽建物を除外している', { skip: skip('citywide-missing-buildings.json') }, () => {
  const a = rpt('citywide-missing-buildings.json');
  assert.ok(a.counts.inWater >= 0);
  assert.ok(a.counts.newlyRecoverable > 0);
});

test('35D 実測: 検証が PASS している', { skip: skip('citywide-missing-recovery-validation.json') }, () => {
  const v = rpt('citywide-missing-recovery-validation.json');
  assert.ok(['CITYWIDE_MISSING_BUILDING_RECOVERY_SUCCESS', 'CITYWIDE_MISSING_BUILDING_RECOVERY_FAILED'].includes(v.classification));
  assert.equal(v.buildingGeometryMutation, 0);
  assert.equal(v.canonicalIdMutation, 0);
  assert.equal(v.plateauRemoved, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.waterMutation, 0);
  assert.equal(v.railMutation, 0);
  assert.equal(v.rebuiltFinalHasNoDuplicateWithPlateau, true);
  assert.equal(v.rebuiltFinalCoverageImproved, true);
  assert.equal(v.pickingWorksForAddedBuildings, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('35D 実測: V4 が V2N を包含している', { skip: (() => {
  const d = path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json');
  return fs.existsSync(d) ? false : 'V4 not built';
})() }, () => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'));
  assert.equal(m.variant, 'v4-final');
  assert.equal(m.composition.baseFeatureCount, FIXED.v2nTotal, 'V2N を丸ごと引き継いでいない');
  assert.ok(m.featureCount > FIXED.v2nTotal, '建物が増えていない');
  assert.equal(m.featureCount, m.composition.baseFeatureCount + m.composition.recoveredFeatureCount);
});
