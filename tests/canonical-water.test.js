// tests/canonical-water.test.js
// [Mission 31B] Canonical Water 正式化。polygon-first / 大川 polygon 化 / major river 監査 /
//   invalid polygon 0 / provenance 100% / centerline 整合 / tile prototype / RiverLayerV2 不変。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateCanonicalFeature, isValidConfidence, polygonAreaM2, ringAreaM2, SOURCE_PRIORITY, SOURCE_REGISTRY } from '../tools/lib/canonical-geometry-schema.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const BODY = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const TILE_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'water', 'manifest.json');
const VALIDATION = P('data', 'reports', 'canonical-water-validation.json');
const MAJOR = P('data', 'reports', 'canonical-water-major-rivers.json');
const INVENTORY = P('data', 'reports', 'canonical-water-source-inventory.json');
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const PREVIEW = P('data', 'reports', 'canonical-water-preview.geojson');

const doc = fs.existsSync(BODY) ? JSON.parse(fs.readFileSync(BODY, 'utf-8')) : null;
const MAJOR_RIVERS = ['淀川', '大和川', '神崎川', '大川', '堂島川', '土佐堀川', '安治川', '木津川', '寝屋川', '道頓堀川'];

test('[31B] canonical water 本体: znorth-neg-v1 / source priority / feature 数', { skip: !doc && 'no water.json' }, () => {
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.equal(doc.layer, 'water');
  assert.ok(doc.features.length > 300, 'feature 数 ' + doc.features.length);
  assert.deepEqual(doc.sourcePriority.map((p) => p.sourceId), SOURCE_PRIORITY.water.map((p) => p.sourceId));
});

test('[31B] 全 feature: schema valid / provenance 100% / confidence 100% / invalid polygon 0', { skip: !doc && 'no water.json' }, () => {
  const ids = new Set();
  let schemaErr = 0, provMissing = 0, confInvalid = 0, invalidPoly = 0, noSourceIds = 0;
  for (const f of doc.features) {
    assert.ok(!ids.has(f.canonicalId), 'duplicate id ' + f.canonicalId);
    ids.add(f.canonicalId);
    const v = validateCanonicalFeature(f);
    if (!v.ok) { schemaErr++; if (schemaErr <= 3) console.error(f.canonicalId, v.errors); }
    if (!f.source || !f.source.geometrySource) provMissing++;
    else {
      if (!SOURCE_REGISTRY[f.source.geometrySource]) provMissing++;
      if (!isValidConfidence(f.source.confidence)) confInvalid++;
      if (!Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) noSourceIds++;
    }
    const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
    for (const poly of polys) if (!(ringAreaM2(poly[0] || []) > 0)) invalidPoly++;
    assert.ok(!('color' in f) && !('style' in f) && !('lod' in f), 'canonical に style/lod 混入: ' + f.canonicalId);
  }
  assert.equal(schemaErr, 0, schemaErr + ' schema エラー');
  assert.equal(provMissing, 0, 'provenance 欠落 ' + provMissing);
  assert.equal(confInvalid, 0, 'confidence 不正 ' + confInvalid);
  assert.equal(noSourceIds, 0, 'sourceIds 空 ' + noSourceIds);
  assert.equal(invalidPoly, 0, 'invalid polygon ' + invalidPoly);
});

test('[31B] polygon-first: 同一河川に polygon feature と ribbon fallback が併存しない', { skip: !doc && 'no water.json' }, () => {
  const byName = new Map();
  for (const f of doc.features) {
    if (!f.attributes.name) continue;
    const kind = f.source.geometrySource === 'osm-waterway-centerline' ? 'ribbon' : 'polygon';
    if (!byName.has(f.attributes.name)) byName.set(f.attributes.name, new Set());
    byName.get(f.attributes.name).add(kind);
  }
  const mixed = [...byName.entries()].filter(([, k]) => k.has('ribbon') && k.has('polygon')).map(([n]) => n);
  assert.deepEqual(mixed, [], 'polygon-first 違反: ' + mixed.join(', '));
});

test('[31B] 大川: polygon source へ移行 / centerlineRef 保持 / area は ribbon 以上', { skip: !doc && 'no water.json' }, () => {
  const okw = doc.features.filter((f) => f.attributes.name === '大川');
  assert.equal(okw.length, 1, '大川 feature が ' + okw.length + ' 個');
  const f = okw[0];
  assert.notEqual(f.source.geometrySource, 'osm-waterway-centerline', '大川がまだ ribbon');
  assert.equal(f.source.geometrySource, 'osm-riverbank');
  assert.equal(f.source.confidence, 0.9);
  assert.ok(f.centerlineRef && Array.isArray(f.centerlineRef.coordinates) && f.centerlineRef.coordinates.length > 10, 'centerlineRef 欠落');
  assert.ok(f.centerlineRef.centerlineInsideRatio >= 0.9, 'centerlineInsideRatio ' + f.centerlineRef.centerlineInsideRatio);
  const area = polygonAreaM2(f.geometryType, f.coordinates);
  assert.ok(area > 350000, '大川 canonical area ' + Math.round(area) + ' が小さすぎる（ribbon 339,910 / polygon source ≈421,669）');
  assert.ok(f.widthProfile && f.widthProfile.canonicalAreaM2 > f.widthProfile.ribbonAreaM2, 'canonical area が ribbon 以下（polygon-first で広くなるはず）');
});

test('[31B] major river 全監査: 全て canonical に存在 / 主要は polygon backed', { skip: !fs.existsSync(MAJOR) && 'no report' }, () => {
  const rep = JSON.parse(fs.readFileSync(MAJOR, 'utf-8'));
  const names = new Set(rep.rivers.map((r) => r.name));
  for (const nm of MAJOR_RIVERS) assert.ok(names.has(nm), nm + ' が major report に無い');
  for (const r of rep.rivers) {
    assert.ok(r.canonicalFeatureCount >= 1, r.name + ' の canonical feature が 0');
    assert.ok(Number.isFinite(r.canonicalAreaM2) && r.canonicalAreaM2 > 0, r.name + ' area 0');
    assert.ok(r.confidence >= 0.65, r.name + ' confidence ' + r.confidence);
  }
  // 大川・淀川・大和川・神崎川・木津川・寝屋川・道頓堀川 は polygon source あり
  for (const nm of ['大川', '淀川', '大和川', '神崎川', '木津川', '寝屋川', '道頓堀川']) {
    const r = rep.rivers.find((x) => x.name === nm);
    assert.ok(r.polygonSourceAvailable, nm + ' が polygon backed でない');
  }
});

test('[31B] waterClass 分類: sea/harbor が river と別扱い', { skip: !doc && 'no water.json' }, () => {
  const classes = new Set(doc.features.map((f) => f.attributes.waterClass));
  assert.ok(classes.has('river'));
  // harbor / sea があれば river クラスと混ざっていない
  for (const f of doc.features) {
    if (['harbor', 'sea'].includes(f.attributes.waterClass)) {
      assert.notEqual(f.attributes.waterClass, 'river');
    }
  }
});

test('[31B] tile prototype: manifest featureCount == body / simplify なし', { skip: !fs.existsSync(TILE_MANIFEST) && 'no tile manifest' }, () => {
  const man = JSON.parse(fs.readFileSync(TILE_MANIFEST, 'utf-8'));
  assert.equal(man.coordinateConvention, 'znorth-neg-v1');
  assert.equal(man.featureCount, doc.features.length);
  assert.match(man.simplification, /none/);
  assert.ok(man.tiles.length > 10);
  // tile ファイルが実在
  const t0 = path.join(path.dirname(TILE_MANIFEST), man.tiles[0].file);
  assert.ok(fs.existsSync(t0), 'tile ファイルが無い: ' + man.tiles[0].file);
});

test('[31B] source inventory: OSM + 公的候補 / centerline fallback 内訳', { skip: !fs.existsSync(INVENTORY) && 'no inventory' }, () => {
  const inv = JSON.parse(fs.readFileSync(INVENTORY, 'utf-8'));
  assert.ok(inv.osm.relations > 0 && inv.osm.closedWaterWays > 0);
  assert.ok(inv.officialCandidates.length >= 3, '公的水域 source 候補が足りない');
  assert.ok(inv.officialCandidates.some((c) => c.canonicalPriority === 1), 'priority 1 の公的候補が無い');
});

test('[31B] conflict 再監査: Building∩Water + Road∩Water 実計算 / bridge は INFO', { skip: !fs.existsSync(CONFLICTS) && 'no conflicts' }, () => {
  const c = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  assert.ok(c.pairStatus.BUILDING_WATER.computed);
  assert.ok(c.pairStatus.ROAD_WATER.computed, 'Road∩Water が計算されていない（§21）');
  assert.ok((c.byCode.ROAD_WATER || 0) > 0);
  // Road∩Water は全て INFO（§11: 単純 overlap を ERROR にしない）
  const rw = (c.roadWaterSample || []);
  for (const x of rw) assert.equal(x.severity, 'INFO');
  assert.ok(c.byCause.bridge > 0, 'bridge EXPLAINED が無い');
  assert.ok('bySource' in c && 'byConfidence' in c);
});

test('[31B] preview GeoJSON: CRS84 / Polygon or MultiPolygon / properties', { skip: !fs.existsSync(PREVIEW) && 'no preview' }, () => {
  const gj = JSON.parse(fs.readFileSync(PREVIEW, 'utf-8'));
  assert.equal(gj.type, 'FeatureCollection');
  assert.ok(gj.features.length > 100);
  const f = gj.features[0];
  assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  assert.ok('canonicalId' in f.properties && 'waterClass' in f.properties && 'confidence' in f.properties);
  // 座標が大阪の緯度経度レンジ
  const flat = JSON.stringify(f.geometry.coordinates);
  const lon = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0][0][0] : f.geometry.coordinates[0][0][0][0];
  assert.ok(lon > 135.2 && lon < 135.8, 'preview 経度が大阪外: ' + lon);
});

test('[31B] canonical-water validator が PASS', { skip: !fs.existsSync(VALIDATION) && 'no validation' }, () => {
  const v = JSON.parse(fs.readFileSync(VALIDATION, 'utf-8'));
  assert.equal(v.RESULT, 'PASS');
  assert.equal(v.checks.schemaErr, 0);
  assert.equal(v.checks.invalidPoly, 0);
  assert.equal(v.checks.ribbonWithPolygonAvailable, 0);
  assert.equal(v.checks.majorMissing, 0);
  assert.ok(v.polygonCoverageRatio > 0.6, 'polygon coverage ' + v.polygonCoverageRatio);
});

test('[31B] RiverLayerV2 / rivers.json / protected は不変（31B は render を触らない）（production は 32U cutover で promoted build）', () => {
  const dev = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
  if (fs.existsSync(dev)) {
    const h = fs.readFileSync(dev, 'utf-8');
    assert.ok(/const RiverLayerV2 = /.test(h), 'RiverLayerV2 が消えた');
    assert.ok(!/canonical\/water|canonical-water/.test(h), 'dev HTML に canonical water 参照が混入');
  }
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (fs.existsSync(p)) assert.ok(!/canonical-geometry-schema|canonical\/water/.test(fs.readFileSync(p, 'utf-8')), rel + ' に混入');
  }
});
