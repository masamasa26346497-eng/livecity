// tests/visual-buildings.test.js
// [Mission 32B] GSI Unified Building Placement — Visual Building Geometry。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[32B §37] validator が PASS', { skip: !rpt('visual-buildings-validation.json') && 'no report' }, () => {
  const v = rpt('visual-buildings-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['visualBuildingsBuilt', 'gsiGeometryUsed', 'canonicalBuildingCountMatches',
    'visualBuildingBlockAssigned', 'majorOutsideRateReported', 'correctionNotAppliedByDefault',
    'visualBuildingsRuntimeToggleExists']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.canonicalBuildingMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.gsiBuildingMutation, 0);
  assert.equal(v.checks.gsiRoadMutation, 0);
  assert.equal(v.checks.illegalGlobalOffset, 0);
  assert.equal(v.checks.illegalGlobalScale, 0);
  assert.equal(v.checks.illegalWarp, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32B §39] visual-buildings-build.json に必須KPIが揃っている', { skip: !rpt('visual-buildings-build.json') && 'no report' }, () => {
  const j = rpt('visual-buildings-build.json');
  assert.equal(j.canonicalBuildingCount, 615617);
  assert.ok(j.totalVisualBuildings > 0);
  assert.ok(j.gsiGeometryUsedCount > 0);
  assert.ok(j.plateauFallbackCount > 0);
  assert.equal(j.gsiGeometryUsedCount + j.plateauFallbackCount, j.totalVisualBuildings);
  assert.ok(j.relationshipCounts);
  for (const k of ['ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'COMPLEX']) assert.ok(k in j.relationshipCounts);
  assert.equal(j.geometrySourceCounts.PLATEAU_FALLBACK_ADJUSTED, 0, '§0/§17違反: 局所補正がデフォルトで適用されている');
});

test('[32B §28/§29] block containment(outsideRatio)が6地点+city sampleで測定されている', { skip: !rpt('visual-building-block-containment.json') && 'no report' }, () => {
  const j = rpt('visual-building-block-containment.json');
  assert.ok(j.citySample && typeof j.citySample.majorOutsideRate !== 'undefined');
  assert.equal(j.sites.length, 6);
  const names = j.sites.map((s) => s.site);
  for (const n of ['梅田', '中之島', '本町', '難波', '天王寺', '住吉']) assert.ok(names.includes(n), n + ' が無い');
  for (const s of j.sites) {
    assert.ok('reliableMeasurementCount' in s, '信頼できる測定件数(reliableMeasurementCount)が無い（openBlockと混同していないか要確認）');
  }
});

test('[32B §2] GSI BldA(building polygon)が実データから抽出されている（推測ではない）', () => {
  const m = rj(R('data', 'processed', 'osaka-city', 'gsi-building-area', 'manifest.json'));
  assert.ok(m);
  assert.ok(m.featureCountClean > 500000, 'GSI BldA件数が想定(50万超)を大幅に下回る: ' + m.featureCountClean);
  assert.equal(m.meshCodesImported.length, 6, '24区全域(6メッシュ)がインポートされていない');
});

test('[32B §0] Canonical Buildings/Roadsは一切変更されていない', () => {
  const b = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  const r = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(b.featureCount, 615617);
  assert.equal(r.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
});

test('[32B §23] 動的: Visual Buildingsトグルが既定OFF・切替後もresidual=0を維持', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__VISUAL_BUILDINGS_MODE__(), false, '既定でONになっている（§0/§19違反: defaultをGSIへ昇格させない）');
  w.__SET_VISUAL_BUILDINGS_MODE__(true);
  assert.equal(w.__VISUAL_BUILDINGS_MODE__(), true);
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residual.total, 0, 'Visual Buildings ON時にresidualが0でない: ' + JSON.stringify(residual));
  w.__SET_VISUAL_BUILDINGS_MODE__(false);
  assert.equal(w.__VISUAL_BUILDINGS_MODE__(), false);
});

test('[32B §26] Visual Building tileはcanonicalId(単一)とcanonicalIds(配列)の両方を保持する', () => {
  const dir = R('data', 'processed', 'osaka-city', 'visual-buildings');
  const files = fs.readdirSync(dir).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
  assert.ok(files.length > 0);
  const sample = rj(path.join(dir, files[0]));
  const f = sample.features[0];
  assert.ok(f.canonicalIds && Array.isArray(f.canonicalIds) && f.canonicalIds.length > 0);
  assert.ok('heightM' in f);
  assert.ok('usageCategory' in f);
});

test('[32B §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /visualBuildingsMode|setVisualBuildingsMode|visual-buildings\//, f + ' に混入');
  }
});
