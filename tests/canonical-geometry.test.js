// tests/canonical-geometry.test.js
// [Mission 31A] Canonical Urban Geometry schema / source priority / confidence / conflict QA /
//   water prototype / 大川 audit / road source 比較。純ロジック中心 + 生成物の schema 検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  CANONICAL_LAYERS, COORDINATE_CONVENTION, LAYER_GEOMETRY_TYPES, SOURCE_REGISTRY, SOURCE_PRIORITY,
  CONFIDENCE, isValidConfidence, CONFLICT_PAIRS, CONFLICT_EXPLANATIONS, classifyConflictSeverity,
  GEOMETRY_ROLE, ATTRIBUTE_ROLE, LAYER_PRECEDENCE_POLICY, CANONICAL_OUTPUT, DERIVED_OUTPUT, STYLE_SEPARATION,
  polygonAreaM2, ringAreaM2, bboxOf, centroidOf, makeProvenance, makeCanonicalFeature, validateCanonicalFeature,
} from '../tools/lib/canonical-geometry-schema.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const OKAWA_AUDIT = P('data', 'reports', 'okawa-canonical-water-audit.json');
const ROAD_CMP = P('data', 'reports', 'canonical-road-source-comparison.json');
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const VALIDATION = P('data', 'reports', 'canonical-geometry-validation.json');

// ── schema 自己整合 ──
test('[31A] canonical layer / source priority の自己整合', () => {
  assert.equal(COORDINATE_CONVENTION, 'znorth-neg-v1');
  assert.deepEqual(CANONICAL_LAYERS.slice().sort(), ['administrative', 'buildings', 'land', 'parks', 'rail', 'roads', 'water']);
  for (const l of CANONICAL_LAYERS) {
    assert.ok(SOURCE_PRIORITY[l], l + ' の source priority が無い');
    assert.ok(LAYER_GEOMETRY_TYPES[l], l + ' の geometryType が無い');
    const prio = SOURCE_PRIORITY[l];
    assert.equal(prio[prio.length - 1].sourceId, null, l + ' の priority 末尾が「生成しない」でない');
    for (const p of prio) {
      if (p.sourceId != null) assert.ok(SOURCE_REGISTRY[p.sourceId], l + ' priority に registry 外 source: ' + p.sourceId);
    }
  }
  // buildings priority: PLATEAU → OSM fallback → 生成しない
  assert.deepEqual(SOURCE_PRIORITY.buildings.map((p) => p.sourceId), ['plateau-building', 'osm-building', null]);
  // water priority: 公的 → riverbank → water polygon → centerline → 生成しない
  assert.deepEqual(SOURCE_PRIORITY.water.map((p) => p.sourceId), ['official-water-boundary', 'osm-riverbank', 'osm-water-polygon', 'osm-waterway-centerline', null]);
});

test('[31A] source registry: geometryRole / attributeRole が有効値', () => {
  const gr = new Set(Object.values(GEOMETRY_ROLE));
  const ar = new Set(Object.values(ATTRIBUTE_ROLE));
  for (const [id, s] of Object.entries(SOURCE_REGISTRY)) {
    assert.ok(gr.has(s.geometryRole), id + ' geometryRole 不正');
    assert.ok(ar.has(s.attributeRole), id + ' attributeRole 不正');
    assert.ok(s.license && s.label, id + ' に license/label が無い');
  }
});

test('[31A] confidence 設計: 全値 0..1 / 順序が意味を持つ', () => {
  for (const [k, v] of Object.entries(CONFIDENCE)) assert.ok(isValidConfidence(v), k + '=' + v);
  assert.ok(CONFIDENCE.OFFICIAL_HIGH_PRECISION_POLYGON > CONFIDENCE.PLATEAU_BUILDING_FOOTPRINT);
  assert.ok(CONFIDENCE.PLATEAU_BUILDING_FOOTPRINT > CONFIDENCE.OSM_BUILDING_FOOTPRINT);
  assert.ok(CONFIDENCE.OSM_WATER_POLYGON > CONFIDENCE.OSM_CENTERLINE_MEASURED_WIDTH);
  assert.ok(CONFIDENCE.OSM_CENTERLINE_WIDTH_TAG > CONFIDENCE.OSM_CENTERLINE_CLASS_DEFAULT_WIDTH);
  assert.ok(!isValidConfidence(1.5) && !isValidConfidence(-0.1) && !isValidConfidence('x'));
});

// ── conflict QA ──
test('[31A] conflict pair / explanation / severity', () => {
  const codes = CONFLICT_PAIRS.map((p) => p.code);
  for (const c of ['BUILDING_WATER', 'BUILDING_ROAD', 'BUILDING_RAIL', 'ROAD_WATER', 'PARK_BUILDING', 'LAND_SEA']) {
    assert.ok(codes.includes(c), c + ' が CONFLICT_PAIRS に無い');
    assert.ok(Array.isArray(CONFLICT_EXPLANATIONS[c]) && CONFLICT_EXPLANATIONS[c].length, c + ' の explanation が無い');
  }
  assert.ok(CONFLICT_EXPLANATIONS.ROAD_WATER.includes('bridge'));
  assert.ok(CONFLICT_EXPLANATIONS.BUILDING_RAIL.includes('station-building'));
});

test('[31A] classifyConflictSeverity: EXPLAINED=INFO / 小=LOW / 大面積相互貫入=HIGH', () => {
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 5000, aAreaM2: 6000, bAreaM2: 6000, explanation: 'bridge' }), 'INFO');
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 10, aAreaM2: 5000, bAreaM2: 200 }), 'LOW');
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 30, aAreaM2: 5000, bAreaM2: 5000 }), 'LOW'); // frac < 5%
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 3000, aAreaM2: 4000, bAreaM2: 3500 }), 'HIGH');
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 8000, aAreaM2: 40000, bAreaM2: 9000 }), 'HIGH'); // 面積 > 6000
  assert.equal(classifyConflictSeverity({ overlapAreaM2: 500, aAreaM2: 4000, bAreaM2: 3000 }), 'MEDIUM');
});

test('[31A] layer precedence: roads-buildings / rail-buildings は排他 clip 禁止', () => {
  assert.equal(LAYER_PRECEDENCE_POLICY.method, 'confidence-and-qa');
  assert.ok(LAYER_PRECEDENCE_POLICY.neverHardClip.includes('roads-buildings'));
  assert.ok(LAYER_PRECEDENCE_POLICY.neverHardClip.includes('rail-buildings'));
});

// ── geometry helpers ──
test('[31A] polygonAreaM2 / ringAreaM2 / bboxOf / centroidOf', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringAreaM2(sq), 100);
  assert.equal(polygonAreaM2('Polygon', [sq]), 100);
  // 穴あり
  const hole = [[2, 2], [4, 2], [4, 4], [2, 4]];
  assert.equal(polygonAreaM2('Polygon', [sq, hole]), 96);
  assert.equal(polygonAreaM2('MultiPolygon', [[sq], [hole]]), 104);
  const bb = bboxOf([sq]);
  assert.deepEqual(bb, { minX: 0, maxX: 10, minZ: 0, maxZ: 10 });
  const c = centroidOf('Polygon', [sq]);
  assert.ok(Math.abs(c[0] - 5) < 1e-6 && Math.abs(c[1] - 5) < 1e-6);
});

test('[31A] makeCanonicalFeature + validateCanonicalFeature', () => {
  const prov = makeProvenance({ geometrySource: 'osm-riverbank', attributeSources: ['osm-water'], confidence: 0.9, sourceIds: ['way/1'] });
  const f = makeCanonicalFeature({
    layer: 'water', geometryType: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 10], [0, 10]]],
    provenance: prov, attributes: { name: 'テスト川', waterType: 'river' },
  });
  assert.equal(f.coordinateConvention, 'znorth-neg-v1');
  assert.equal(f.areaM2, 200);
  assert.ok(Array.isArray(f.centroid));
  const v = validateCanonicalFeature(f);
  assert.ok(v.ok, JSON.stringify(v.errors));
  // provenance 欠落は fail
  const bad = { ...f, source: null };
  assert.ok(!validateCanonicalFeature(bad).ok);
  // confidence 範囲外は fail
  const bad2 = makeCanonicalFeature({ layer: 'water', geometryType: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 10], [0, 10]]], provenance: makeProvenance({ geometrySource: 'osm-riverbank', confidence: 1.4, sourceIds: ['way/2'] }) });
  assert.ok(!validateCanonicalFeature(bad2).ok);
  // layer に許されない geometryType は fail
  const bad3 = makeCanonicalFeature({ layer: 'buildings', geometryType: 'LineString', coordinates: [[0, 0], [1, 1]], provenance: prov });
  assert.ok(!validateCanonicalFeature(bad3).ok);
});

test('[31A] style / LOD 分離が設計に明記されている', () => {
  assert.match(STYLE_SEPARATION.rule, /表示色/);
  assert.ok(DERIVED_OUTPUT.bands.includes('far') && DERIVED_OUTPUT.bands.includes('ultra-near'));
  assert.match(DERIVED_OUTPUT.note, /LOD で削らない/);
  assert.equal(CANONICAL_OUTPUT.layout, 'manifest+tile');
});

// ── 生成物（prototype）──
test('[31A] canonical water prototype: schema 全件 valid / provenance 必須', { skip: !fs.existsSync(WATER) && 'no water.json' }, () => {
  const doc = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.equal(doc.layer, 'water');
  assert.ok(doc.features.length > 100, 'feature 数 ' + doc.features.length);
  const ids = new Set();
  let errs = 0;
  for (const f of doc.features) {
    assert.ok(!ids.has(f.canonicalId), 'duplicate id ' + f.canonicalId);
    ids.add(f.canonicalId);
    const v = validateCanonicalFeature(f);
    if (!v.ok) { errs++; if (errs <= 3) console.error(f.canonicalId, v.errors); }
    assert.ok(f.source.geometrySource && SOURCE_REGISTRY[f.source.geometrySource]);
    assert.ok(isValidConfidence(f.source.confidence));
    assert.ok(f.source.sourceIds.length > 0);
    assert.ok(!('color' in f) && !('style' in f) && !('lod' in f), 'canonical feature に style/lod が混入');
  }
  assert.equal(errs, 0, errs + ' 件 schema エラー');
  // source priority は water のもの
  assert.deepEqual(doc.sourcePriority.map((p) => p.sourceId), SOURCE_PRIORITY.water.map((p) => p.sourceId));
});

test('[31A] 大川 canonical audit: polygon source と building overlap を検出', { skip: !fs.existsSync(OKAWA_AUDIT) && 'no audit' }, () => {
  const a = JSON.parse(fs.readFileSync(OKAWA_AUDIT, 'utf-8'));
  assert.equal(a.target, '大川');
  assert.ok(a.resolved);
  assert.ok(a.currentRibbon.areaM2 > 100000, 'ribbon area ' + a.currentRibbon.areaM2);
  assert.ok(a.polygonSource.count >= 1, 'polygon source が見つからない');
  assert.ok(a.polygonSource.areaM2 > 0);
  assert.ok(a.overlap.buildingOverlap.fraction > 0, 'building overlap を検出できていない');
  assert.ok(a.migrationReadiness.recommendation.length > 0);
});

test('[31A] road source 比較: 4 候補 + rank + 現 OSM 実測', { skip: !fs.existsSync(ROAD_CMP) && 'no report' }, () => {
  const r = JSON.parse(fs.readFileSync(ROAD_CMP, 'utf-8'));
  const ids = r.candidates.map((c) => c.sourceId);
  assert.ok(ids.includes('official-road-area') && ids.includes('plateau-tran-road') && ids.includes('osm-road-centerline') && ids.includes('osm-area-highway'));
  assert.equal(r.candidates.find((c) => c.sourceId === 'official-road-area').recommendedRank, 1);
  assert.equal(r.currentOsmCenterline.hasAreaGeometry, false);
  assert.ok(r.currentOsmCenterline.uniqueFeatureIds > 30000);
});

test('[31A] conflict audit: Building∩Water 実計算 / 他ペア pending / EXPLAINED=INFO', { skip: !fs.existsSync(CONFLICTS) && 'no conflicts' }, () => {
  const c = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  assert.ok(c.pairStatus.BUILDING_WATER.computed, 'Building∩Water が計算されていない');
  // 31B: ROAD_WATER / 31C: BUILDING_ROAD / 31D: BUILDING_RAIL + PARK_BUILDING も実計算。
  //   LAND_SEA のみ canonical land 未構築で pending。
  assert.equal(c.pairStatus.LAND_SEA.computed, false, 'LAND_SEA は canonical land 未構築で pending のはず');
  assert.ok((c.bySeverity.INFO || 0) > 0, 'EXPLAINED (INFO) が 0 — 意味付けが機能していない');
  assert.equal(c.RESULT, 'AUDIT-DONE');
});

test('[31A] validator レポートが PASS / production・protected 不変', { skip: !fs.existsSync(VALIDATION) && 'no validation' }, () => {
  const v = JSON.parse(fs.readFileSync(VALIDATION, 'utf-8'));
  assert.equal(v.RESULT, 'PASS');
  assert.equal(v.schemaSelfCheck, 'PASS');
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (!fs.existsSync(p)) continue;
    assert.ok(!/canonical-geometry-schema|CANONICAL_LAYERS/.test(fs.readFileSync(p, 'utf-8')), rel + ' に混入');
  }
});
