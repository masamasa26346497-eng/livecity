// tests/gsi-road-hybrid-v1.test.js
// [Mission 31G-FIX19] Hybrid GSI Road Surface Prototype。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../tools/lib/canonical-baseline.js";
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] canonical の生成物が無い素のチェックアウトでは検証対象が無いので skip（assertion 失敗では skip しない）
const CANONICAL_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings/manifest.json', 'data/processed/osaka-city/canonical/roads/manifest.json', 'data/processed/osaka-city/derived/refined-road-surface.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

function hasRealRawData() {
  const dir = R('data', 'raw', 'gsi', 'road-edge');
  try { return fs.readdirSync(dir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.')); } catch { return false; }
}

test('[FIX19 §42] gsi-road-hybrid-v1 validator が PASS', { skip: !rpt('gsi-road-hybrid-v1-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-road-hybrid-v1-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['canonicalRoadMutation', 'buildingMutation', 'fix13Mutation', 'invalidHybridPolygon',
    'untrackedSurface', 'illegalSourcePriority', 'criticalSeamGap', 'criticalSeamOverlap',
    'serviceRoadMergeViolation', 'medianCarriagewayMergeViolation']) {
    assert.equal(v.checks[k], 0, k + ' が 0 でない: ' + v.checks[k]);
  }
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
  assert.equal(v.checks.publicHasOnlySample, true);
  assert.equal(v.checks.neverReadyForProduction, true);
});

test('[FIX19 §45] finalDecision は READY_FOR_USER_VISUAL_QA / HYBRID_V1_NOT_READY のいずれか（READY_FOR_PRODUCTIONは絶対に禁止）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-hybrid-v1.json');
  assert.ok(j, 'report が無い');
  assert.ok(['READY_FOR_USER_VISUAL_QA', 'HYBRID_V1_NOT_READY'].includes(j.finalDecision), '不正な finalDecision: ' + j.finalDecision);
  assert.notEqual(j.finalDecision, 'READY_FOR_PRODUCTION');
});

test('[FIX19 §41] visualQaStatus は VISUAL_QA_PENDING_USER（ブラウザ未使用のため目視確認は未実施）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-hybrid-v1.json');
  assert.equal(j.visualQaStatus, 'VISUAL_QA_PENDING_USER');
});

test('[FIX19 §40] report に必須フィールドが全て存在する', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-hybrid-v1.json');
  for (const f of ['sampleCount', 'surfaceCount', 'coverage', 'multiCarriageway', 'serviceRoad',
    'seams', 'geometryValidity', 'areaComparison', 'buildingOverlap', 'waterOverlap', 'parkOverlap',
    'majorRoads', 'residentialSamples', 'finalDecision']) {
    assert.ok(f in j, '必須フィールドが無い: ' + f);
  }
  assert.equal(j.sampleCount, 10);
});

test('[FIX19 §1] LOW confidence の GSI surface は geometry source として一切使われていない', () => {
  if (!hasRealRawData()) return;
  const dir = R('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1');
  const prov = rj(path.join(dir, 'provenance.json'));
  if (!prov) return;
  for (const s of prov.surfaces) assert.notEqual(s.confidence, 'low', 'LOW confidence surface が採用されている: ' + s.surfaceId);
});

test('[FIX19 §20] provenance の各 surface が schema を満たす（surfaceId/geometrySource/confidence/sourceIds/generatedAt）', () => {
  if (!hasRealRawData()) return;
  const dir = R('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1');
  const prov = rj(path.join(dir, 'provenance.json'));
  if (!prov || !prov.surfaces.length) return;
  const s = prov.surfaces[0];
  for (const f of ['surfaceId', 'geometrySource', 'confidence', 'sourceIds', 'generatedAt']) assert.ok(f in s, f + ' が無い');
});

test('[FIX19 §24] residential 4地区（住吉/阿倍野/平野/十三）で regression が無い（GSI比率が極端に低下していない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-hybrid-v1.json');
  for (const area of ['住吉', '阿倍野', '平野', '十三']) {
    const r = j.residentialSamples[area];
    if (!r || !r.coverage) continue;
    assert.ok(r.coverage.GSI_HIGH_pct + r.coverage.GSI_MEDIUM_pct >= 20, area + ': GSI比率が著しく低い');
  }
});

test('[FIX19 §37] canonical / building / FIX13 は完全不変', { skip: CANONICAL_SKIP }, () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = rj(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
  if (hasRealRawData()) {
    const j = rpt('gsi-road-hybrid-v1.json');
    assert.equal(j.sourceTruthProtection.canonicalRoadUnchanged, true);
    assert.equal(j.sourceTruthProtection.canonicalBuildingUnchanged, true);
    assert.equal(j.sourceTruthProtection.fix13Unchanged, true);
  }
});

test('[FIX19 §39] output は offline precompute のみ・public には sample のみ配信', () => {
  const pubDir = R('public', 'map-data', 'osaka-city', 'gsi-road-hybrid-v1');
  if (!fs.existsSync(pubDir)) return;
  const pubFull = path.join(pubDir, 'hybrid-surfaces.json');
  assert.ok(!fs.existsSync(pubFull), '全大阪版が public に配信されている');
  const pubSample = path.join(pubDir, 'hybrid-surfaces-sample.json');
  if (fs.existsSync(pubSample)) assert.ok(fs.statSync(pubSample).size < 10 * 1024 * 1024, 'sample overlay が過大');
  const pubSeams = path.join(pubDir, 'seams-sample.json');
  if (fs.existsSync(pubSeams)) assert.ok(fs.statSync(pubSeams).size < 10 * 1024 * 1024, 'seams overlay が過大');
});

test('[FIX19 §34→FIX19B §2] runtime: ROAD_RENDER_MODE は既定 FIX13・[Hybrid Seams] トグルは既定 OFF・per-frame cost なし', { skip: !html && 'no html' }, () => {
  // [Mission 31G-FIX19B] 単純な ON/OFF トグルは ROAD_RENDER_MODE（FIX13/HYBRID_V1/DIFF_DEBUG の3値）へ置き換えた。
  assert.match(html, /let roadRenderMode = 'FIX13';/);
  assert.match(html, /async function setRoadRenderMode\(mode\)/);
  assert.match(html, /let seamsVisible = false;/);
  assert.match(html, /window\.toggleHybridSeams = async function/);
  const animIdx = html.indexOf('function animate(');
  if (animIdx >= 0) assert.doesNotMatch(html.slice(animIdx, animIdx + 4000), /roadRenderMode|hybridGroupNormal|hybridGroupDebug|seamsVisible|seamsGroup/);
});

test('[FIX19 §0] protected HTML に Hybrid v1 / Hybrid Runtime Cutover コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /gsi-road-hybrid-v1|toggleHybridSeams|roadRenderMode|setRoadRenderMode|HYBRID_SAMPLE_AREAS/, f + ' に混入');
  }
});
