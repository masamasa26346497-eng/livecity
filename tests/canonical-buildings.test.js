// tests/canonical-buildings.test.js
// [Mission 31D] Canonical Buildings 正式化 + road polygon source 取得準備。
//   PLATEAU 優先 / OSM fallback 統合 / duplicate 0 / invalid geometry 0 / provenance 100% /
//   usage null 0 / ward assignment / attributes 分離 / 5 ペア conflict / BuildingTileLayer 不変。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateCanonicalFeature, isValidConfidence, ringAreaM2, SOURCE_PRIORITY, SOURCE_REGISTRY } from '../tools/lib/canonical-geometry-schema.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const MANIFEST = path.join(DIR, 'manifest.json');
const ATTR_DIR = path.join(DIR, 'attributes');
const BUILD = P('data', 'reports', 'canonical-building-build.json');
const VALIDATION = P('data', 'reports', 'canonical-building-validation.json');
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const PREVIEW = P('data', 'reports', 'canonical-building-preview.geojson');
const ROAD_ACQ = P('data', 'reports', 'road-polygon-source-acquisition.json');
const GEOM_VAL = P('data', 'reports', 'canonical-geometry-validation.json');

const hasBuild = fs.existsSync(MANIFEST);
const manifest = hasBuild ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) : null;
// tile を全部読むと重いので先頭/中間/末尾の 3 tile を sample
function sampleFeatures() {
  const tf = fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f));
  const idx = [...new Set([0, Math.floor(tf.length / 2), tf.length - 1])].filter((i) => i >= 0);
  const out = [];
  for (const i of idx) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf[i]), 'utf-8'));
    const at = JSON.parse(fs.readFileSync(path.join(ATTR_DIR, tf[i]), 'utf-8'));
    for (const f of (t.features || [])) out.push({ f, a: at.attributes[f.canonicalId] });
  }
  return out;
}
const sample = hasBuild ? sampleFeatures() : [];

test('[31D] canonical buildings manifest: source priority / plateau+fallback count', { skip: !hasBuild && 'no build' }, () => {
  assert.equal(manifest.coordinateConvention, 'znorth-neg-v1');
  assert.equal(manifest.layer, 'buildings');
  assert.deepEqual(manifest.sourcePriority.map((p) => p.sourceId), SOURCE_PRIORITY.buildings.map((p) => p.sourceId));
  assert.equal(manifest.featureCount, manifest.plateauCount + manifest.fallbackCount);
  assert.ok(manifest.plateauCount >= 573000 && manifest.plateauCount <= 575000, 'PLATEAU count ' + manifest.plateauCount + '（baseline 574,112）');
  assert.ok(manifest.fallbackCount >= 41000 && manifest.fallbackCount <= 41510, 'fallback count ' + manifest.fallbackCount + '（baseline 41,507）');
});

test('[31D] build report: count 差分の説明 / duplicate 0 / PLATEAU priority', { skip: !fs.existsSync(BUILD) && 'no report' }, () => {
  const b = JSON.parse(fs.readFileSync(BUILD, 'utf-8'));
  assert.equal(b.RESULT, 'PASS');
  assert.equal(b.duplicateCanonicalId, 0);
  assert.ok(Array.isArray(b.countExplanation) && b.countExplanation.length >= 3, 'count 差分の説明が無い（§11）');
  assert.equal(b.plateauPriorityMaintained, true);
  assert.equal(b.attributesSeparated, true, 'attributes 分離フラグ（§5）');
  assert.equal(b.usage.normalizedUsageNull, 0, 'normalizedUsage null（§7）');
  // §4: fallback の PLATEAU duplicate は除外済み
  assert.ok(b.dedup.fallbackDuplicateOfPlateauExcluded <= 10, 'PLATEAU duplicate 除外 ' + b.dedup.fallbackDuplicateOfPlateauExcluded);
});

test('[31D] sample feature: schema valid / provenance / confidence / PLATEAU=0.95', { skip: !hasBuild && 'no build' }, () => {
  assert.ok(sample.length > 100);
  let schemaErr = 0, provErr = 0, plWrongConf = 0, styleLeak = 0;
  for (const { f } of sample) {
    const v = validateCanonicalFeature(f);
    if (!v.ok) { schemaErr++; if (schemaErr <= 2) console.error(f.canonicalId, v.errors); }
    if (!f.source || !SOURCE_REGISTRY[f.source.geometrySource] || !isValidConfidence(f.source.confidence) || !f.source.sourceIds.length) provErr++;
    if (f.source && f.source.geometrySource === 'plateau-building' && Math.abs(f.source.confidence - 0.95) > 1e-6) plWrongConf++;
    if ('color' in f || 'style' in f || 'attributes' in f && Object.keys(f.attributes || {}).length) styleLeak++;
  }
  assert.equal(schemaErr, 0);
  assert.equal(provErr, 0);
  assert.equal(plWrongConf, 0, 'PLATEAU confidence が 0.95 でない ' + plWrongConf);
  assert.equal(styleLeak, 0, 'canonical geometry に style / attributes payload 混入');
});

test('[31D] attributes 分離: geometry と別ファイル / usage・ward・height を保持（§5/§6/§7/§8）', { skip: !hasBuild && 'no build' }, () => {
  const wardIds = new Set(JSON.parse(fs.readFileSync(P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8')).wards.map((w) => w.wardId));
  let missingAttr = 0, usageNull = 0, wardInvalid = 0;
  for (const { f, a } of sample) {
    if (!a) { missingAttr++; continue; }
    if (!a.normalizedUsage || /その他\(null\)/.test(String(a.usageLabel))) usageNull++;
    if (a.wardId != null && !wardIds.has(a.wardId)) wardInvalid++;
    assert.ok('usageCategory' in a && 'heightM' in a && 'heightSource' in a && 'source' in a, f.canonicalId + ' 属性欠落');
  }
  assert.equal(missingAttr, 0);
  assert.equal(usageNull, 0, 'usage null（§7）');
  assert.equal(wardInvalid, 0, 'ward 不正（§8）');
  // attributes ディレクトリが存在
  assert.ok(fs.existsSync(ATTR_DIR) && fs.readdirSync(ATTR_DIR).some((f) => /^tile_/.test(f)), 'attributes tile が無い');
});

test('[31D] canonical-buildings validator が PASS', { skip: !fs.existsSync(VALIDATION) && 'no validation' }, () => {
  const v = JSON.parse(fs.readFileSync(VALIDATION, 'utf-8'));
  assert.equal(v.RESULT, 'PASS');
  for (const k of ['schemaErr', 'invalidFp', 'bboxInvalid', 'centroidInvalid', 'areaInvalid', 'provMissing', 'confInvalid', 'normalizedUsageNull', 'wardInvalid', 'plateauPriorityViolation']) {
    assert.equal(v.checks[k], 0, k + ' = ' + v.checks[k]);
  }
  assert.ok(v.plateauCount >= 573000);
});

test('[31D] canonical-geometry validator: 3 layer 統合（water / roads / buildings）', { skip: !fs.existsSync(GEOM_VAL) && 'no report' }, () => {
  const v = JSON.parse(fs.readFileSync(GEOM_VAL, 'utf-8'));
  assert.equal(v.RESULT, 'PASS');
  const layers = Object.values(v.layerStats).map((s) => s.layer);
  for (const need of ['water', 'roads', 'buildings']) assert.ok(layers.includes(need), need + ' layer が検査されていない');
});

test('[31D] conflict 監査: 5 ペア実計算（Building∩Water/Road/Rail + Road∩Water + Park∩Building）', { skip: !fs.existsSync(CONFLICTS) && 'no conflicts' }, () => {
  const c = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  for (const code of ['BUILDING_WATER', 'BUILDING_ROAD', 'ROAD_WATER', 'BUILDING_RAIL', 'PARK_BUILDING']) {
    assert.ok(c.pairStatus[code].computed, code + ' 未計算');
    assert.ok((c.byCode[code] || 0) > 0, code + ' の conflict が 0');
  }
  assert.equal(c.pairStatus.LAND_SEA.computed, false, 'LAND_SEA は canonical land 未構築で pending');
  // §13/§15: subway=地下 は EXPLAINED
  assert.ok((c.byCause.underground || 0) > 0, 'BUILDING_RAIL の subway=underground EXPLAINED が無い');
  // §16: park-facility は EXPLAINED
  assert.ok((c.byCause['park-facility'] || 0) > 0, 'PARK_BUILDING の park-facility EXPLAINED が無い');
  // baseline: 31D 時点で Building∩Water 142（geometry 不変）。
  //   31E で 安治川 harbor split（tracked correction）を適用し +1〜2（分離した harbon part が近傍建物と重なる）。
  //   それ以外の変動は無いこと。
  const wb = P('data', 'reports', 'canonical-water-build.json');
  const corrApplied = fs.existsSync(wb) && (JSON.parse(fs.readFileSync(wb, 'utf-8')).corrections31E || {}).correctionsApplied > 0;
  if (corrApplied) assert.ok(c.byCode.BUILDING_WATER >= 142 && c.byCode.BUILDING_WATER <= 145, 'Building∩Water ' + c.byCode.BUILDING_WATER + '（31E correction で 142→+1〜2 の想定）');
  else assert.equal(c.byCode.BUILDING_WATER, 142, 'Building∩Water baseline 142 から変化（§13）');
});

test('[31D] preview GeoJSON: 代表地点のみ / PLATEAU・fallback 識別可能', { skip: !fs.existsSync(PREVIEW) && 'no preview' }, () => {
  const gj = JSON.parse(fs.readFileSync(PREVIEW, 'utf-8'));
  assert.equal(gj.type, 'FeatureCollection');
  assert.ok(gj.features.length > 100 && gj.features.length <= 4000, 'preview は代表地点のみ（全量にしない §25）: ' + gj.features.length);
  const spots = new Set(gj.features.map((f) => f.properties.spot));
  assert.ok(spots.size >= 3, '代表地点が少なすぎる');
  const srcs = new Set(gj.features.map((f) => f.properties.source));
  assert.ok(srcs.has('plateau-building'), 'preview に PLATEAU が無い');
  for (const f of gj.features.slice(0, 20)) assert.ok('usageCategory' in f.properties && 'confidence' in f.properties);
});

test('[31D] road polygon source 取得準備（§19-23）', { skip: !fs.existsSync(ROAD_ACQ) && 'no report' }, () => {
  const r = JSON.parse(fs.readFileSync(ROAD_ACQ, 'utf-8'));
  const ids = r.sources.map((s) => s.sourceId);
  assert.ok(ids.includes('plateau-tran-road') && ids.includes('gsi-kiban-road-edge'), '公的 road polygon source 候補が足りない');
  const A = r.sources.find((s) => s.sourceId === 'plateau-tran-road');
  assert.equal(A.priority, 'A');
  assert.equal(A.geometryType.includes('polygon') || A.geometryType.includes('面'), true);
  assert.equal(r.repoScan.plateauTranPatternConfigured, true, 'data/plateau-sources.json に tranPattern が追加されていない（§20）');
  // GSI 道路縁は line → 直接 polygon 扱いしない注意（§21）
  const B = r.sources.find((s) => s.sourceId === 'gsi-kiban-road-edge');
  assert.match(JSON.stringify(B), /pairing/);
});

test('[31D] plateau-sources.json: tranPattern 追加（fetch-plateau は壊れていない）', () => {
  const ps = JSON.parse(fs.readFileSync(P('data', 'plateau-sources.json'), 'utf-8'));
  assert.ok(ps.patterns.tranPattern || ps.patterns.tranPatterns, 'tranPattern が無い');
  assert.equal(ps.patterns.bldgPattern, '(^|/)[^/]*bldg[^/]*\\.gml$', 'bldgPattern が変わった（building pipeline に影響）');
});

test('[31D] BuildingTileLayer / protected は不変（31D は render を触らない）（production は 32U cutover で promoted build）', () => {
  const dev = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
  if (fs.existsSync(dev)) {
    const h = fs.readFileSync(dev, 'utf-8');
    assert.ok(/const BuildingTileLayer = /.test(h), 'BuildingTileLayer が消えた');
    assert.ok(!/canonical\/buildings|canonical-building/.test(h), 'dev HTML に canonical buildings 参照が混入');
  }
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (fs.existsSync(p)) assert.ok(!/canonical-geometry-schema|canonical\/buildings/.test(fs.readFileSync(p, 'utf-8')), rel + ' に混入');
  }
});
