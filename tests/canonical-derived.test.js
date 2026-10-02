// tests/canonical-derived.test.js
// [Mission 31F] Canonical Parks / Rail / Resolved / Derived pipeline の検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { simplifyRing, simplifyGeometry, ringSelfIntersects, ringArea } from '../tools/lib/geometry-simplify.js';
import { classifyPark } from '../tools/build-canonical-parks.js';
import { CANONICAL_STATION_COUNT } from '../tools/lib/canonical-baseline.js';
import { lodForDistance, makeCanonicalLayerAdapter, resolvePick, UI_COMPAT, RUNTIME_LAYERS } from '../tools/lib/canonical-runtime-adapter.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const rpt = (n) => { const p = P('data', 'reports', n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; };
const DERIVED = P('data', 'processed', 'osaka-city', 'derived');

// ── geometry-simplify（純ロジック）──
test('[31F] simplifyRing: 頂点を減らすが退化・自己交差させない', () => {
  const ring = [];
  for (let i = 0; i < 40; i++) ring.push([Math.cos(i / 40 * 2 * Math.PI) * 100 + (i % 2 ? 1 : 0), Math.sin(i / 40 * 2 * Math.PI) * 100]);
  const s = simplifyRing(ring, 8, 4);
  assert.ok(s.length < ring.length, '頂点が減っていない ' + s.length);
  assert.ok(s.length >= 4);
  assert.equal(ringSelfIntersects(s), false, 'simplify 後に自己交差');
  assert.ok(ringArea(s) > 20000, '面積が消失 ' + ringArea(s));
});

test('[31F] simplifyGeometry: tolerance 0 は不変 / Polygon が消滅したら null', () => {
  const poly = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  assert.deepEqual(simplifyGeometry('Polygon', poly, 0).coordinates, poly);
  const tiny = [[[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]];
  assert.equal(simplifyGeometry('Polygon', tiny, 12), null, '極小 polygon は tolerance 12m で消滅 → null');
});

test('[31F] simplifyGeometry: LineString 端点保持', () => {
  const line = [[0, 0], [1, 0.1], [2, -0.1], [3, 0.05], [10, 0]];
  const s = simplifyGeometry('LineString', line, 2);
  assert.deepEqual(s.coordinates[0], line[0]);
  assert.deepEqual(s.coordinates[s.coordinates.length - 1], line[line.length - 1]);
  assert.ok(s.coordinates.length <= line.length);
});

// ── §7 park classification ──
test('[31F] classifyPark: landuse=grass を park 扱いしない', () => {
  assert.equal(classifyPark({ leisure: 'park' }).parkClass, 'park');
  assert.equal(classifyPark({ landuse: 'grass' }).parkClass, 'grass');
  assert.equal(classifyPark({ landuse: 'grass' }).rankable, false);
  assert.equal(classifyPark({ landuse: 'recreation_ground' }).parkClass, 'recreation_ground');
  assert.equal(classifyPark({ leisure: 'golf_course' }).parkClass, 'sports_ground');
  assert.equal(classifyPark({ leisure: 'playground' }).parkClass, 'playground');
});

// ── canonical parks build ──
test('[31F] canonical parks: grass 分離 / 31E RECLASSIFY 反映 / validator PASS', { skip: !rpt('canonical-parks-build.json') && 'no build' }, () => {
  const b = rpt('canonical-parks-build.json');
  assert.equal(b.RESULT, 'PASS');
  assert.ok(b.byParkClass.grass > 100, 'grass が parkClass=grass になっていない');
  assert.ok(b.byParkClass.park > 1000);
  assert.ok((b.byParkClass['misclassified-block'] || 0) >= 1, '31E RECLASSIFY 反映なし');
  const v = rpt('canonical-parks-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.grassViolation, 0);
  assert.equal(v.checks.classNull, 0);
  assert.equal(v.checks.provMissing, 0);
});

// ── canonical rail build ──
test('[31F] canonical rail: line geometry / lodClass 分離 / 骨格路線 / validator PASS', { skip: !rpt('canonical-rail-build.json') && 'no build' }, () => {
  const b = rpt('canonical-rail-build.json');
  assert.equal(b.RESULT, 'PASS');
  assert.ok(b.featureCount > 2000);
  assert.equal(b.stationCount, CANONICAL_STATION_COUNT, '駅は線とは別 payload');
  assert.ok(b.byLodClass.major > 500 && b.byLodClass.urban > 100);
  const v = rpt('canonical-rail-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.majorRouteMissing, 0);
  assert.equal(v.checks.continuityRegressions, 0);
  assert.equal(v.checks.provMissing, 0);
  // geometry は line
  const dir = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
  const tf = fs.readdirSync(dir).find((f) => /^tile_/.test(f));
  const t = JSON.parse(fs.readFileSync(path.join(dir, tf), 'utf-8'));
  assert.ok(['LineString', 'MultiLineString'].includes(t.features[0].geometryType));
});

// ── resolved canonical ──
test('[31F] resolved canonical: lineage / corrections 追跡 / reversible', { skip: !fs.existsSync(P('data', 'processed', 'osaka-city', 'canonical', 'resolved', 'index.json')) && 'no resolved' }, () => {
  const idx = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'resolved', 'index.json'), 'utf-8'));
  assert.equal(idx.RESULT, 'PASS');
  assert.equal(idx.correctionErrors, 0);
  assert.ok(idx.totalFeatures > 500000);
  const water = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'resolved', 'water.json'), 'utf-8'));
  assert.equal(water.reversible, true);
  assert.ok(water.corrections.appliedCount >= 1, 'water の 安治川 correction が追跡されていない');
  assert.ok(water.baseCanonical.hash, 'baseCanonical hash なし');
});

// ── derived geometry ──
test('[31F/31G] derived geometry: LOD 単調性 / near 完全性 / provenance / validator PASS', { skip: !rpt('derived-geometry-build.json') && 'no derived' }, () => {
  const b = rpt('derived-geometry-build.json');
  assert.equal(b.RESULT, 'PASS');
  for (const [layer, info] of Object.entries(b.layers)) {
    const c = ['far', 'mid', 'near'].map((l) => info.lod[l].distinctCanonicalIds);
    assert.ok(c[0] <= c[1] && c[1] <= c[2], layer + ' の LOD feature 数が単調でない ' + JSON.stringify(c));
    // 31G: near = resolved canonical の完全表現（ultra-near は廃止）
    assert.equal(b.completeness[layer]['near'].actualMissing, 0, layer + ' near に欠落');
    if (layer === 'roads' || layer === 'buildings') assert.ok(c[0] < c[2] * 0.5, layer + ' far が間引かれていない');
  }
  const v = rpt('derived-geometry-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['orphan', 'invalidGeom', 'correctionMissing', 'provMissing', 'bboxInvalid', 'topologyBreak', 'missingUltraNear', 'manifestMismatch']) {
    assert.equal(v.checks[k], 0, k + ' が 0 でない');
  }
});

test('[31F] derived feature: canonicalId / derivedFrom / simplificationToleranceM / correctionIds / sourceConfidence', { skip: !fs.existsSync(path.join(DERIVED, 'mid', 'roads', 'manifest.json')) && 'no derived' }, () => {
  const dir = path.join(DERIVED, 'mid', 'roads');
  const tf = fs.readdirSync(dir).find((f) => /^tile_/.test(f));
  const t = JSON.parse(fs.readFileSync(path.join(dir, tf), 'utf-8'));
  for (const k of ['tileId', 'layer', 'lod', 'bbox', 'featureCount', 'canonicalIds', 'sourceVersion', 'features']) assert.ok(k in t, 'tile schema に ' + k + ' が無い');
  const d = t.features[0];
  for (const k of ['canonicalId', 'derivedFrom', 'layer', 'lod', 'simplificationToleranceM', 'correctionIds', 'sourceConfidence']) assert.ok(k in d, 'derived feature に ' + k + ' が無い');
  assert.equal(d.derivedFrom, d.canonicalId);
  assert.equal(d.lod, 'mid');
  assert.equal(d.simplificationToleranceM, 6);
});

test('[31F] 安治川 harbor split が derived まで追跡されている', { skip: !fs.existsSync(path.join(DERIVED, 'near', 'water', 'manifest.json')) && 'no derived' }, () => {
  const dir = path.join(DERIVED, 'near', 'water');
  let found = null;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_/.test(f)) continue;
    for (const d of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).features || [])) {
      if (d.canonicalId === 'cg_water_river_x_water_e78261aa4e7e45' || d.canonicalId.startsWith('cg_water_harbor_anjigawa_split')) { found = d; break; }
    }
    if (found) break;
  }
  assert.ok(found, '安治川 or split-off が derived に無い');
  assert.ok(Array.isArray(found.correctionIds) && found.correctionIds.length > 0, 'correctionIds が追跡されていない');
});

// ── runtime adapter（§31/§32/§33）──
test('[31F] runtime adapter: lodForDistance / resolvePick / UI_COMPAT', () => {
  assert.equal(lodForDistance(20000), 'far');
  assert.equal(lodForDistance(5000), 'mid');
  assert.equal(lodForDistance(2000), 'near');
  assert.equal(lodForDistance(300), 'near'); // 31G: ultra-near 廃止
  const a = makeCanonicalLayerAdapter('buildings');
  assert.equal(a.layer, 'buildings');
  const pick = resolvePick({ canonicalId: 'cg_bldg_x', lod: 'near', attributes: { usageLabel: '事務所' }, sourceConfidence: 0.95, correctionIds: [] }, a);
  assert.equal(pick.canonicalId, 'cg_bldg_x');
  assert.equal(pick.attributes.usageLabel, '事務所');
  assert.equal(resolvePick(null, a), null);
  assert.ok(UI_COMPAT.buildingPopup && UI_COMPAT.wardSelection && UI_COMPAT.cityMode);
  assert.deepEqual(RUNTIME_LAYERS.sort(), ['buildings', 'parks', 'rail', 'roads', 'water']);
});

// ── §0: render 不変 ──
test('[31F] protected HTML に derived / canonical 混入なし（ward-ux-v1 は 31G で接続済み）（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/osaka-city\/derived|CanonicalRuntime|canonical-runtime-adapter|build-derived-geometry/.test(h), rel + ' に canonical 混入');
  }
});

// ── §23 conflict 再監査 ──
test('[31F] conflict 再監査: CRITICAL 0 / unclassified HIGH 0 / MANUAL_REVIEW 維持', { skip: !rpt('canonical-conflict-validation.json') && 'no validation' }, () => {
  const v = rpt('canonical-conflict-validation.json');
  assert.equal(v.RESULT, 'PASS');
  assert.equal(v.checks.critical, 0);
  assert.equal(v.checks.unexplainedHighAfter, 0);
  // canonical parks 反映で park HIGH は減る（misclassified-block は conflict から除外）
  const c = rpt('canonical-conflicts.json');
  assert.ok((c.unexplainedHighByCode.PARK_BUILDING || 0) <= 110, 'Park∩Building HIGH が 31E から増えている');
});
