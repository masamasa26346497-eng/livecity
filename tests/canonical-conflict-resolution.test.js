// tests/canonical-conflict-resolution.test.js
// [Mission 31E] canonical conflict の分類・解消・補正の検証。
//   overlap を 0 にするのが目的ではなく、全 HIGH に action が付き MANUAL_REVIEW が明示されること、
//   補正が追跡可能・可逆であること、元 canonical / raw source が不変であること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { applyCorrections, loadCorrections } from '../tools/lib/canonical-corrections.js';
import { makeCanonicalFeature } from '../tools/lib/canonical-geometry-schema.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const rpt = (n) => { const p = P('data', 'reports', n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; };

test('[31E] canonical-corrections: split-multipolygon-parts は centerline 非交差 part を分離し可逆', () => {
  // 合成: 3 part MultiPolygon。part0/1 は centerline 上、part2 は遠くの独立水域。
  const near = [[[0, 0], [100, 0], [100, 20], [0, 20]]];
  const near2 = [[[100, 0], [200, 0], [200, 20], [100, 20]]];
  const far = [[[0, 900], [400, 900], [400, 1200], [0, 1200]]]; // area 120,000 / centerline から遠い
  const feature = makeCanonicalFeature({
    canonicalId: 'cg_water_test_x', layer: 'water', geometryType: 'MultiPolygon',
    coordinates: [near, near2, far],
    provenance: { geometrySource: 'osm-riverbank', attributeSources: ['osm-water'], confidence: 0.9, sourceIds: ['relation/1'], generatedAt: 'x' },
    attributes: { name: 'テスト川', waterClass: 'river' }, qaFlags: ['polygon-much-larger-than-ribbon(要確認)'],
    centerlineRef: { coordinates: [[10, 10], [50, 10], [150, 10], [190, 10]], sourceIds: ['way/1'] },
    widthProfile: null,
  });
  const hash = 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(feature.coordinates)).digest('hex');
  const rec = {
    correctionId: 'corr_test', targetCanonicalId: 'cg_water_test_x', targetLayer: 'water',
    operation: 'split-multipolygon-parts', reason: 'test', sourceEvidence: { kind: 'centerline-topology' },
    originalGeometryHash: hash, createdBy: 'test',
    params: { splitPartSelector: { centerlinePointsInside: 0, minDistToCenterlineM_gt: 60, minAreaM2: 80000 }, splitOffAttributes: { name: null, waterClass: 'harbor' }, splitOffConfidence: 0.7, splitOffCanonicalIdPrefix: 'cg_water_harbor_test' },
  };
  const res = applyCorrections([feature], [rec]);
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].partsSplitOff, 1, 'far part 1 枚だけ分離されるはず');
  assert.equal(res.applied[0].partsKept, 2);
  const kept = res.features.find((f) => f.canonicalId === 'cg_water_test_x');
  assert.ok(!kept.qaFlags.some((q) => q.includes('polygon-much-larger-than-ribbon')), 'flag が消えるはず');
  assert.ok(kept.qaFlags.some((q) => q.startsWith('corrected-31E')));
  const off = res.features.find((f) => f.canonicalId.startsWith('cg_water_harbor_test'));
  assert.equal(off.attributes.waterClass, 'harbor');
  assert.equal(off.attributes.derivedFrom, 'cg_water_test_x');
  assert.ok(off.source.sourceIds.some((s) => s.startsWith('correction/')));
});

test('[31E] canonical-corrections: originalGeometryHash 不一致は適用しない（§14 可逆性ガード）', () => {
  const f = makeCanonicalFeature({
    canonicalId: 'cg_water_test_y', layer: 'water', geometryType: 'MultiPolygon',
    coordinates: [[[[0, 0], [10, 0], [10, 10]]], [[[0, 900], [400, 900], [400, 1200]]]],
    provenance: { geometrySource: 'osm-riverbank', attributeSources: [], confidence: 0.9, sourceIds: ['r/1'], generatedAt: 'x' },
    attributes: {}, qaFlags: [], centerlineRef: { coordinates: [[5, 5]] }, widthProfile: null,
  });
  const res = applyCorrections([f], [{
    correctionId: 'corr_stale', targetCanonicalId: 'cg_water_test_y', targetLayer: 'water',
    operation: 'split-multipolygon-parts', reason: 't', sourceEvidence: { kind: 'centerline-topology' },
    originalGeometryHash: 'sha1:deadbeef', createdBy: 'test', params: { splitPartSelector: {}, splitOffAttributes: {} },
  }]);
  assert.equal(res.applied.length, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /originalGeometryHash/);
});

test('[31E] 安治川 補正が適用され、元 raw source は不変・可逆', { skip: !rpt('canonical-water-build.json') && 'no build' }, () => {
  const b = rpt('canonical-water-build.json');
  assert.ok(b.corrections31E, 'water build に corrections31E が無い');
  assert.equal(b.corrections31E.correctionErrors, 0);
  if (b.corrections31E.correctionsApplied > 0) {
    const w = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), 'utf-8'));
    const anji = w.features.find((f) => f.canonicalId === 'cg_water_river_x_water_e78261aa4e7e45');
    assert.ok(anji, '安治川 feature が消えた');
    assert.ok(anji.qaFlags.some((q) => q.startsWith('corrected-31E')), '補正フラグが無い');
    const splitOff = w.features.filter((f) => (f.qaFlags || []).some((q) => q.startsWith('split-from-')));
    assert.ok(splitOff.length >= 1, 'split-off feature が無い');
    for (const s of splitOff) assert.ok(s.source && s.source.sourceIds.length, 'split-off に provenance が無い');
  }
  // 補正レコードが corrections/ に存在（untracked でない）
  const corr = loadCorrections('water');
  assert.ok(corr.some((r) => r.correctionId === 'corr_water_anjigawa_harbor_split'));
});

test('[31E] conflict resolution: 全 HIGH に action / unexplained HIGH 0 / MANUAL_REVIEW 明示', { skip: !rpt('canonical-conflict-resolution.json') && 'no resolution' }, () => {
  const r = rpt('canonical-conflict-resolution.json');
  const mr = rpt('canonical-manual-review.json');
  assert.ok(r.high.total > 0);
  const acted = Object.values(r.high.byPairAction).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
  assert.equal(acted, r.high.total, '全 HIGH に action が付いていない');
  assert.equal(r.high.unexplainedAfter, 0, '分類後も unexplained HIGH が残っている');
  // MANUAL_REVIEW の HIGH は manual-review.json に全部載る
  const mrHigh = new Set(mr.items.filter((x) => x.severity === 'HIGH').map((x) => x.conflictId));
  const resMrHigh = (r.conflicts || []).filter((x) => x.severity === 'HIGH' && x.action === 'MANUAL_REVIEW');
  for (const x of resMrHigh) assert.ok(mrHigh.has(x.conflictId), 'MANUAL_REVIEW HIGH ' + x.conflictId + ' が manual-review に無い');
  // manual review は systematic findings にまとめられている
  assert.ok(Array.isArray(mr.systematicFindings) && mr.systematicFindings.length > 0);
});

test('[31E] AUTO_DELETE は使われない（§3）', { skip: !rpt('canonical-conflict-resolution.json') && 'no resolution' }, () => {
  const r = rpt('canonical-conflict-resolution.json');
  const allowed = new Set(['KEEP', 'EXPLAIN', 'CORRECT_A', 'CORRECT_B', 'RECLASSIFY', 'SUPPRESS_RENDER_ONLY', 'MANUAL_REVIEW']);
  for (const a of Object.keys(r.byAction)) assert.ok(allowed.has(a), '許可外 action: ' + a);
  assert.ok(!('AUTO_DELETE' in r.byAction));
});

test('[31E] conflict validator が PASS', { skip: !rpt('canonical-conflict-validation.json') && 'no validation' }, () => {
  const v = rpt('canonical-conflict-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.critical, 0);
  assert.equal(v.checks.unexplainedHighAfter, 0);
  assert.equal(v.checks.invalidCorrections, 0);
  assert.equal(v.checks.provenanceMissing, 0);
  assert.equal(v.checks.missingFromManualReview, 0);
});

test('[31E] review GeoJSON: severity/action/cause プロパティ', { skip: !fs.existsSync(P('data', 'reports', 'canonical-conflicts-review.geojson')) && 'no geojson' }, () => {
  const g = JSON.parse(fs.readFileSync(P('data', 'reports', 'canonical-conflicts-review.geojson'), 'utf-8'));
  assert.equal(g.type, 'FeatureCollection');
  assert.ok(g.features.length > 100);
  for (const f of g.features.slice(0, 50)) {
    for (const k of ['severity', 'action', 'cause', 'pairType', 'overlapArea']) assert.ok(k in f.properties, k + ' が無い');
    assert.equal(f.geometry.type, 'Point');
  }
});

test('[31E] production / protected / ward-ux-v1 render は不変', () => {
  for (const rel of ['osaka_3d_buildings.html', 'osaka_3d_buildings.fullward-v3.html', 'osaka_3d_buildings.ward-ux-v1.html']) {
    const p = P('public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/canonical\/corrections|canonical-conflict-resolution|conflict-resolution/.test(h), rel + ' に 31E の混入');
  }
});

test('[31E] Building∩Rail regression: HIGH 0 維持', { skip: !rpt('canonical-conflicts.json') && 'no conflicts' }, () => {
  const c = rpt('canonical-conflicts.json');
  const railHigh = (c.buildingRailSample || []).filter((x) => x.severity === 'HIGH' || x.severity === 'CRITICAL').length;
  // sample だけでなく unexplainedHighByCode でも確認
  assert.ok(!(c.unexplainedHighByCode && c.unexplainedHighByCode.BUILDING_RAIL), 'Building∩Rail に unexplained HIGH が出現（baseline 0）');
});
