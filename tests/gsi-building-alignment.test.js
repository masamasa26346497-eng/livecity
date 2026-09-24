// tests/gsi-building-alignment.test.js
// [Mission 31G-FIX20] GSI Building Alignment Ground Truth。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[FIX20 §27] gsi-building-alignment validator が PASS', { skip: !rpt('gsi-building-alignment-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-building-alignment-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['rawMutation', 'canonicalBuildingMutation', 'canonicalRoadMutation', 'fakeMatch',
    'crsMismatchUntracked', 'runtimeMagicOffset', 'lowConfidenceUsedForCalibration']) {
    assert.equal(v.checks[k], 0, k + ' が 0 でない: ' + v.checks[k]);
  }
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX20 §28] classification は4択のいずれか', () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j) return;
  const ALLOWED = ['SYSTEMATIC_BUILDING_SHIFT_CONFIRMED', 'DATUM_TRANSFORM_REQUIRED', 'NO_SYSTEMATIC_BUILDING_SHIFT', 'INSUFFICIENT_MATCHING_DATA'];
  assert.ok(ALLOWED.includes(j.classification), '不正な classification: ' + j.classification);
});

test('[FIX20 §1] raw data が無い現状では正直に GSI_BUILDING_OUTLINE_RAW_DATA_MISSING と記録している', () => {
  const rawDir = R('data', 'raw', 'gsi', 'building-outline');
  const hasRealFiles = fs.existsSync(rawDir) && fs.readdirSync(rawDir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.'));
  if (hasRealFiles) return;
  const j = rpt('gsi-building-alignment.json');
  if (!j) return;
  assert.equal(j.RESULT, 'GSI_BUILDING_OUTLINE_RAW_DATA_MISSING');
  assert.equal(j.classification, 'INSUFFICIENT_MATCHING_DATA');
  assert.equal(j.outlineCount, 0);
});

test('[FIX20 §29] canonical building / road は完全不変（今回615,617棟を書き換えていない）', () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const j = rpt('gsi-building-alignment.json');
  if (j && j.sourceTruthProtection) {
    assert.equal(j.sourceTruthProtection.canonicalBuildingUnchanged, true);
    assert.equal(j.sourceTruthProtection.canonicalRoadUnchanged, true);
  }
});

test('[FIX20 §19] runtime に building座標への magic offset hack が無い', { skip: !html && 'no html' }, () => {
  assert.doesNotMatch(html, /buildingGroup\.position\.[xz]\s*\+=/);
  assert.doesNotMatch(html, /__BUILDING_ALIGNMENT_OFFSET__/);
});

test('[FIX20 §21/§22] [Building Alignment] / [Top Down Alignment] トグルが Canonical status panel に統合されている（既定OFF）', { skip: !html && 'no html' }, () => {
  assert.match(html, /let buildingAlignmentVisible = false;/);
  assert.match(html, /let topDownActive = false;/);
  assert.match(html, /id = 'building-alignment-toggle';/);
  assert.match(html, /id = 'top-down-alignment-toggle';/);
  const panelStart = html.indexOf('function ensureStatusUI_()');
  const panelEnd = html.indexOf('function renderStatus()', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  assert.match(panel, /alignBox\.appendChild\(alignBtn\); alignBox\.appendChild\(topDownBtn\);/);
  assert.match(panel, /statusEl\.appendChild\(alignBox\);/);
});

test('[FIX20 §22] Top Down は既存 camera system（cs.ph）を直接使い、新しい camera system は作らない', { skip: !html && 'no html' }, () => {
  assert.match(html, /if \(topDownActive\) \{ topDownSavedPh = cs\.ph; cs\.ph = 0\.08; \}/);
});

test('[FIX20 §23] 3D building は半透明化していない前提でも判定は ground footprint 基準（renderOrderで確実に上に描画）', { skip: !html && 'no html' }, () => {
  assert.match(html, /mesh\.renderOrder = REN\.building \+ 10;/);
});

test('[FIX20] 動的: toggleBuildingAlignment / toggleTopDownAlignment が例外なく動作する', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__TOGGLE_BUILDING_ALIGNMENT__, 'function');
  assert.equal(typeof w.__TOGGLE_TOP_DOWN_ALIGNMENT__, 'function');
  await w.__TOGGLE_BUILDING_ALIGNMENT__();
  const d1 = w.__BUILDING_ALIGNMENT_DEBUG__();
  assert.equal(d1.visible, true);
  // 実データ(alignment-pairs-sample.json)が public に無いためstatusは missing のはず（捏造していない証跡）
  assert.ok(['missing', 'ready', 'empty'].includes(d1.status));
  w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  const d2 = w.__BUILDING_ALIGNMENT_DEBUG__();
  assert.equal(d2.topDownActive, true);
  w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  assert.equal(w.__BUILDING_ALIGNMENT_DEBUG__().topDownActive, false);
});

test('[FIX20 §0] protected HTML に Building Alignment コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /buildingAlignmentVisible|gsi-building-outline|toggleTopDownAlignment/, f + ' に混入');
  }
});

// ═══════════════════════════════════════════════════════════════
// [Mission 31G-FIX21] 実データ投入後の測定結果に対するテスト。
// ═══════════════════════════════════════════════════════════════
function hasRealRawBuildingOutline() {
  const rawDir = R('data', 'raw', 'gsi', 'building-outline');
  try { return fs.readdirSync(rawDir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.')); } catch { return false; }
}

test('[FIX21 §1/§3/§4] 実raw dataがある場合、GSI CRS(JGD2024)が実測され、STATUSがIMPORTEDになっている', { skip: !hasRealRawBuildingOutline() && 'no real raw data' }, () => {
  const imp = rpt('gsi-building-outline-import.json');
  assert.ok(imp, 'import report が無い');
  assert.equal(imp.rawDataPresent, true);
  assert.equal(imp.STATUS, 'GSI_BUILDING_OUTLINE_IMPORTED');
  assert.ok(imp.sourceCrs.some((c) => /jgd2024/i.test(c)), 'JGD2024 が実測されていない: ' + JSON.stringify(imp.sourceCrs));
  assert.equal(imp.featureType.primary, 'BldL');
  assert.ok(imp.osakaFeatureCount > 0);
});

test('[FIX21 §11/§18/§39] 実データでの classification が4択のいずれかで、曖昧な結論になっていない', { skip: !hasRealRawBuildingOutline() && 'no real raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  assert.ok(j, 'alignment report が無い');
  assert.equal(j.RESULT, 'GSI_BUILDING_ALIGNMENT_MEASURED');
  const ALLOWED = ['SYSTEMATIC_BUILDING_SHIFT_CONFIRMED', 'DATUM_TRANSFORM_REQUIRED', 'NO_SYSTEMATIC_BUILDING_SHIFT', 'INSUFFICIENT_MATCHING_DATA'];
  assert.ok(ALLOWED.includes(j.classification), '不正な classification: ' + j.classification);
  assert.ok(j.matching.high + j.matching.medium + j.matching.low + j.matching.unmatched > 0, 'matching内訳が全0');
});

test('[FIX21 §15] corroboration フィールドが存在し、HIGH+MEDIUM の再検証結果を記録している（LOWは使っていない）', { skip: !hasRealRawBuildingOutline() && 'no real raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.alignment) return;   // INSUFFICIENT_MATCHING_DATA 等で alignment が無いケースはスキップ
  assert.ok(j.corroboration, 'corroboration フィールドが無い');
  assert.equal(typeof j.corroboration.highMediumCount, 'number');
  assert.ok(j.corroboration.highMediumCount >= j.matching.high, 'HIGH+MEDIUM件数がHIGH件数を下回っている');
});

test('[FIX21 §5] datumComparison.realMeasurement が実測ベースで記録されている（文献値のみで断定していない）', { skip: !hasRealRawBuildingOutline() && 'no real raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.datumComparison) return;
  if (j.classification === 'INSUFFICIENT_MATCHING_DATA') return;
  assert.ok(j.datumComparison.realMeasurement, 'realMeasurement が無い（実測ではなく文献値のみになっている）');
  assert.equal(typeof j.datumComparison.realMeasurement.magnitudeM, 'number');
});

test('[FIX21 §27] 実データで [Building Alignment] runtime overlay が実際にロードできる（動的・実fetch）', { skip: !hasRealRawBuildingOutline() && 'no real raw data' }, async () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.matching || j.matching.high === 0) return;   // HIGH match 0件ならoverlayも0件で正常
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  await w.__TOGGLE_BUILDING_ALIGNMENT__();
  const d = w.__BUILDING_ALIGNMENT_DEBUG__();
  assert.equal(d.status, 'ready', 'overlay が実データを読めていない: ' + JSON.stringify(d));
  assert.ok(d.pairCount > 0, 'pairCount が0（実データがpublicへ配信されていない疑い）');
  assert.ok(d.stats && d.stats.matching, 'stats（HIGH/MED/LOW/Unmatched）が読み込まれていない');
});

test('[FIX21 §36] source protection: canonical building/road/FIX13 refined が完全不変', () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = rj(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
});

// ═══════════════════════════════════════════════════════════════
// [Mission 31G-FIX22] 大阪市24区 Building Alignment 最終検証（6メッシュ実データ）。
// ═══════════════════════════════════════════════════════════════
function hasCitywideMeshes() {
  const imp = rpt('gsi-building-outline-import.json');
  return !!(imp && imp.meshInventory && imp.meshInventory.meshCodesImported && imp.meshInventory.meshCodesImported.length >= 6);
}

test('[FIX22 §1] 6メッシュのraw inventoryが記録され、重複メッシュ(523514)が二重カウントされていない', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const imp = rpt('gsi-building-outline-import.json');
  assert.ok(imp.meshInventory, 'meshInventory が無い');
  assert.equal(imp.meshInventory.meshCodesImported.length, 6, 'importされたmesh数が6でない: ' + JSON.stringify(imp.meshInventory.meshCodesImported));
  for (const code of ['513573', '513574', '523503', '523504', '523513', '523514']) {
    assert.ok(imp.meshInventory.meshCodesImported.includes(code), 'mesh ' + code + ' が未取込');
  }
  assert.ok(imp.meshInventory.duplicateMeshSkipped.some((d) => d.meshCode === '523514'), '523514の重複スキップが記録されていない');
});

test('[FIX22 §2/§3] 24区coverageが再計算され、重要8区のcoverage判定が記録されている', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  assert.ok(j, 'alignment report が無い');
  assert.ok(j.citywideCoverage, 'citywideCoverage フィールドが無い');
  assert.equal(j.citywideCoverage.keyWards.length, 8);
  assert.equal(typeof j.citywideCoverage.sufficient, 'boolean');
  if (!j.citywideCoverage.sufficient) {
    assert.equal(j.RESULT, 'CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT', 'coverage不足なのにRESULTがそれを反映していない');
  }
});

test('[FIX22 §9] 24区全区分の内訳(byWardFull)が存在し、high/medium/low/unmatched件数を持つ', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.byWardFull) return;
  const ids = Object.keys(j.byWardFull);
  assert.ok(ids.length >= 24, '24区分のエントリが揃っていない: ' + ids.length);
  for (const w of ids) {
    const e = j.byWardFull[w];
    assert.equal(typeof e.highCount, 'number');
    assert.equal(typeof e.mediumCount, 'number');
  }
});

test('[FIX22 §10] 地域クラスタリング(byRegion)にNORTH/CENTRAL/EAST/SOUTH/BAYが定義されている', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.byRegion) return;
  for (const r of ['NORTH', 'CENTRAL', 'EAST', 'SOUTH', 'BAY']) {
    assert.ok(Array.isArray(j.byRegion.regions[r]) && j.byRegion.regions[r].length > 0, r + ' region未定義');
  }
});

test('[FIX22 §11] サンプル地区に新大阪・長居が追加され12地区になっている', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.bySample) return;
  assert.ok('新大阪' in j.bySample, '新大阪が bySample に無い');
  assert.ok('長居' in j.bySample, '長居が bySample に無い');
  assert.ok(Object.keys(j.bySample).length >= 12, 'サンプル地区数が12未満: ' + Object.keys(j.bySample).length);
});

test('[FIX22 §12/§13] 梅田・住吉の深掘り(deepDive)が記録されている', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.deepDive) return;
  assert.ok(j.deepDive.umeda, 'deepDive.umeda が無い');
  assert.ok(j.deepDive.sumiyoshi, 'deepDive.sumiyoshi が無い');
  assert.equal(j.deepDive.umeda.name, '梅田');
  assert.equal(j.deepDive.sumiyoshi.name, '住吉');
});

test('[FIX22 §8] robust statistics（MAD・trimmed mean）が alignment に記録されている', { skip: !hasCitywideMeshes() && 'no citywide raw data' }, () => {
  const j = rpt('gsi-building-alignment.json');
  if (!j || !j.alignment) return;
  assert.equal(typeof j.alignment.madDx, 'number');
  assert.equal(typeof j.alignment.madDz, 'number');
  assert.equal(typeof j.alignment.trimmedMeanDx, 'number');
  assert.equal(typeof j.alignment.trimmedMeanDz, 'number');
});
