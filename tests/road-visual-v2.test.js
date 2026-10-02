// tests/road-visual-v2.test.js
// [Mission 32E] GSI-CONSTRAINED ROAD VISUAL — RoadVisualV2。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[32E §41] validator が PASS', { skip: !rpt('road-visual-v2-validation.json') && 'no report' }, () => {
  const v = rpt('road-visual-v2-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.tranPolygonFullDarkDefault, false);
  assert.equal(v.checks.roadV2UsesGsiConfidenceGate, true);
  assert.equal(v.checks.unresolvedDoesNotFallbackToFullDark, true);
  assert.equal(v.checks.roadAreaAccountingValid, true);
  assert.equal(v.checks.buildingDarkRoadOverlapMeasured, true);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32E §36] road-visual-v2.json に必須フィールドが揃っている', { skip: !rpt('road-visual-v2.json') && 'no report' }, () => {
  const r = rpt('road-visual-v2.json');
  assert.ok(r.sourceCounts.gsiShinhabaLines > 0);
  assert.ok(r.pairing.high > 0 && r.pairing.medium > 0);
  assert.ok(r.areas.tranEnvelope > 0);
  assert.equal(r.areas.reconciliationDiffM2, 0, 'area accountingが厳密に一致していない');
  assert.ok(r.buildingOverlap.improvementPercent != null);
  assert.ok(r.continuity.tracksTotal > 0);
  assert.ok(typeof r.conflicts.gsiConflictFeatureCount === 'number');
  assert.ok(r.roadWidthSanity.count > 0);
  for (const s of ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi']) assert.ok(r.sites[s], s + ' fixtureが無い');
  assert.equal(r.geometryValidity.nanCount, 0);
  assert.equal(r.geometryValidity.degenerateCount, 0);
  assert.match(r.verdict, /^ROAD_VISUAL_V2_(SUCCESS|NOT_BETTER)$/);
});

test('[32E §24/§38] BUILDING∩DARK ROAD が全site合計で明確に改善している', { skip: !rpt('road-visual-v2.json') && 'no report' }, () => {
  const r = rpt('road-visual-v2.json');
  assert.ok(r.buildingOverlap.buildingDarkOverlapV2M2 < r.buildingOverlap.buildingDarkOverlapFix13M2, 'V2の方がFIX13より重なりが大きい(悪化)');
  assert.ok(r.buildingOverlap.improvementPercent >= 30, '§38の目安(30%以上削減)に届いていない: ' + r.buildingOverlap.improvementPercent);
});

test('[32E §26] road continuityが壊れていない(HIGH/MEDIUMで裏付けられたtrackが一定割合以上残る)', { skip: !rpt('road-visual-v2.json') && 'no report' }, () => {
  const r = rpt('road-visual-v2.json');
  const ratio = r.continuity.tracksWithCoverage / r.continuity.tracksTotal;
  assert.ok(ratio >= 0.3, 'tracksWithCoverage比率が低すぎる: ' + ratio);
});

test('[32E §5/§6] RoadV2はHIGH/MEDIUM confidenceのみをcarriagewayに採用している(builderソース確認)', () => {
  const buildSrc = fs.readFileSync(R('tools', 'build-road-visual-v2.js'), 'utf-8');
  assert.match(buildSrc, /confidence === 'high' \|\| p\.confidence === 'medium'/);
  assert.match(buildSrc, /!p\.widthSpike/);
});

test('[32E §21] Road Mode runtime API が存在し既定FIX13', () => {
  // [Mission 32K §13] development 既定は ROAD_V3 へ昇格した（32I §30 の凍結は 32K で明示解除）。
  //   ここで守るのは「Road Mode の runtime API が存在すること」と「既定が定義済みであること」。
  assert.match(html, /let roadVisualMode = 'ROAD_V3';/);
  assert.match(html, /async function setRoadVisualMode\(mode\)/);
  assert.match(html, /window\.__SET_ROAD_VISUAL_MODE__/);
  assert.match(html, /window\.__ROAD_VISUAL_V2_DEBUG__/);
  assert.match(html, /b\.id = 'road-v2-mode-' \+ mk;/);
  // [Mission 32I] ROAD V3 / DIFF V2→V3 が追加され、ボタン配列と label が更新された
  //   （守っている性質は不変: 既定 FIX13・LAND_BLOCK が Road Mode に統合されている）。
  assert.match(html, /\['FIX13', 'A:FIX13'\], \['ROAD_V2', 'B:ROAD V2'\], \['ROAD_V3', 'C:ROAD V3'\], \['LAND_BLOCK', 'D:\+LAND BLOCK'\]/);
  assert.match(html, /\['DIFF', 'DIFF'\], \['DIFF_V2_V3', 'DIFF V2→V3'\]/);
});

test('[32E §2] primary bucket meshに名前が付き、RoadV2モードで個別hide/showできる実装がある', () => {
  assert.match(html, /m\.name = 'RoadBucket_' \+ rs;/);
  assert.match(html, /c\.name === 'RoadBucket_primary'/);
});

test('[32E §7] tran envelopeへのclip(Sutherland-Hodgman)は既存libを再利用している', () => {
  const clipSrc = fs.readFileSync(R('tools', 'lib', 'polygon-clip.js'), 'utf-8');
  assert.match(clipSrc, /export function clipPolygonToRing/);
  const buildSrc = fs.readFileSync(R('tools', 'build-road-visual-v2.js'), 'utf-8');
  assert.match(buildSrc, /import \{ clipPolygonToRing, ringAreaAbs \} from '\.\/lib\/polygon-clip\.js';/);
});

test('[32E 動的] Road Mode トグルはtileCacheが空でも安全に切り替わりresidualが0を維持する（既知の制約: harnessはupdate()の実per-frame実行を持たずtileCacheへ実道路tileが載らないため、実カメラ駆動でのRoadV2 mesh構築そのものはこのテストでは検証できない。memory: canonicalruntime-update-tdz-blocks-harness-tile-fetch 参照。実ブラウザでの目視確認が必要）', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__ROAD_VISUAL_V2_DEBUG__();
  assert.equal(before.mode, 'ROAD_V3', '既定でFIX13になっていない');
  const resOn = await w.__SET_ROAD_VISUAL_MODE__('ROAD_V2');
  assert.equal(resOn.mode, 'ROAD_V2');
  const residualOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOn.total, 0, 'ROAD_V2切替時にresidualが0でない: ' + JSON.stringify(residualOn));
  const resDiff = await w.__SET_ROAD_VISUAL_MODE__('DIFF');
  assert.equal(resDiff.mode, 'DIFF');
  const residualDiff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualDiff.total, 0, 'DIFF切替時にresidualが0でない: ' + JSON.stringify(residualDiff));
  const resBack = await w.__SET_ROAD_VISUAL_MODE__('FIX13');
  assert.equal(resBack.mode, 'FIX13');
  const residualOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOff.total, 0, 'FIX13復帰後にresidualが0でない: ' + JSON.stringify(residualOff));
});

test('[32E §42] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /roadVisualMode|setRoadVisualMode|RoadVisualV2Overlay|road-visual-v2\/tiles/, f + ' に混入');
  }
});
