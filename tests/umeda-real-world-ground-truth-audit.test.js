// tests/umeda-real-world-ground-truth-audit.test.js
// [Mission 32H] UMEDA REAL-WORLD GROUND TRUTH AUDIT（AUDIT ONLY）。
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
const REPORT = 'umeda-real-world-ground-truth-audit.json';

test('[32H §21] validator が PASS（AUDIT ONLY: 何も変更していない）', { skip: !rpt('umeda-real-world-ground-truth-audit-validation.json') && 'no report' }, () => {
  const v = rpt('umeda-real-world-ground-truth-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.landBlockMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.canonicalBuildings, 615617);
  assert.equal(v.checks.roadV2Features, 169468);
  assert.equal(v.checks.landBlocks, 178);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
  assert.equal(v.checks.overlayReadOnly, true);
});

test('[32H §3] 梅田(Kita区)の生PLATEAU CityGML を一次証拠として使っている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.equal(r.umedaRawPlateau.available, true);
  assert.ok(r.umedaRawPlateau.meshFilesUsed.length > 0, '使用したメッシュファイルが記録されていない');
  // 梅田中心を含む3次メッシュ 52350349 が実際に読まれていること
  assert.ok(r.umedaRawPlateau.meshFilesUsed.some((f) => f.includes('52350349')), '梅田中心メッシュが使われていない');
  assert.ok(r.umedaRawPlateau.srsName.some((s) => s.includes('6697')), 'srsNameが記録されていない');
  assert.equal(r.umedaRawPlateau.lod0Count + r.umedaRawPlateau.lod0RoofEdgeCount, r.umedaRawPlateau.buildingCount,
    'LOD0外形(FootPrint+RoofEdge)の総数が建物数と一致しない');
});

test('[32H §4] 梅田のLOD2は実在する（32Gの「LOD2なし」一般化の訂正）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.equal(r.lod2Availability.verdict, 'UMEDA_LOD2_AVAILABLE');
  assert.ok(r.lod2Availability.lod2SolidBuildings > 0);
  assert.ok(r.umedaRawPlateau.groundSurfaceCount > 0, 'GroundSurfaceが0件のまま');
  assert.ok(r.umedaRawPlateau.roofSurfaceCount > 0);
  assert.ok(r.umedaRawPlateau.wallSurfaceCount > 0);
});

test('[32H §15] LOD2は外形の独立証拠にならない（全geometryが同一平面外形）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  const f = r.lod2OutlineFinding;
  assert.ok(f.comparedBuildings > 0, 'LOD2比較が1件も行われていない');
  // 屋根投影がfootprintをほぼ100%覆い、GroundSurface面積比もほぼ1 ⇒ 同一ポリゴン
  assert.ok(f.roofProjectedCoverageOfFootprintMedian >= 0.99, '屋根投影の被覆中央値: ' + f.roofProjectedCoverageOfFootprintMedian);
  assert.ok(Math.abs(f.groundSurfaceVsFootprintAreaRatioMedian - 1) <= 0.02);
  assert.match(f.interpretation, /^LOD2_PROVIDES_NO_INDEPENDENT_OUTLINE/);
});

test('[32H §8/§9] Ground Truth の位置合わせを非建物 control point で確認している', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  const a = r.groundTruth.alignment;
  assert.ok(a.controlPointCount >= 10, 'control pointが10点未満: ' + a.controlPointCount);
  assert.ok(a.distanceToNearestOsmHighwayM.median != null);
  // 数十mずれた状態で建物を評価しない（§9）
  assert.ok(a.distanceToNearestOsmHighwayM.median <= 15, 'alignment中央値が大きすぎる: ' + a.distanceToNearestOsmHighwayM.median);
});

test('[32H 測定の健全性] 航空写真の不在を捏造で埋めていない', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.equal(r.orthophoto.available, false);
  assert.equal(r.orthophoto.source, null);
  assert.equal(r.orthophoto.captureDate, null);
  for (const k of ['boundsWest', 'boundsEast', 'boundsNorth', 'boundsSouth']) assert.equal(r.orthophoto[k], null, k + ' が捏造されている');
  assert.ok(r.orthophoto.substituteGroundTruth, '代替Ground Truthの明示が無い');
});

test('[32H 測定の健全性] 分類根拠にサンプル選定条件(道路/線路重なり)を使っていない', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  for (const b of r.problemBuildings) {
    assert.notEqual(b.classificationEvidence, 'ROAD_RAIL_OVERLAP', '循環論法: ' + b.gmlId);
  }
  // 「存在」と「不在」の証拠の非対称性が扱われていること
  assert.ok(r.groundTruth.evidenceAsymmetryNote.includes('不在'));
  const oversized = r.problemBuildings.concat(r.controlBuildings).filter((b) => b.classification === 'PLATEAU_FOOTPRINT_OVERSIZED');
  if (oversized.length > 0) assert.equal(r.groundTruth.osmAbsenceUsedAsEvidence, true, '不在ベースの判定なのに妥当性ゲート未通過');
});

test('[32H 測定の健全性] Ground Truth の情報量がベースラインと比較されている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  const e = r.evidenceSummary;
  assert.ok(e.osmCoverageOfRoadRailCells_baselineWithoutPlateauBuilding != null, 'ベースラインが測られていない');
  assert.ok(e.osmCoverageOfRoadRailPart_problemMedian != null);
  // ベースラインが飽和していれば証拠として弱い。飽和していないことを確認する。
  assert.ok(e.osmCoverageOfRoadRailCells_baselineWithoutPlateauBuilding < 0.5,
    'OSM建物が道路セルを広く覆っており、観測に情報量が無い: ' + e.osmCoverageOfRoadRailCells_baselineWithoutPlateauBuilding);
});

test('[32H §1/§2/§10] 問題群・対照群が各20棟以上で、全件が6分類のいずれか', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(r.problemSampleCount >= 20, '問題群が20棟未満: ' + r.problemSampleCount);
  assert.ok(r.controlSampleCount >= 20, '対照群が20棟未満: ' + r.controlSampleCount);
  const allowed = /^(REAL_OVERHEAD_STRUCTURE|FOOTPRINT_MATCHES_REAL_BUILDING|PLATEAU_FOOTPRINT_OVERSIZED|PLATEAU_FOOTPRINT_UNDERSIZED|TEMPORAL_CHANGE|AMBIGUOUS)$/;
  for (const b of r.problemBuildings.concat(r.controlBuildings)) {
    if (!b.located) continue;
    assert.match(b.classification, allowed, b.gmlId);
    assert.ok(b.classificationReason && b.classificationReason.length > 0, '判定理由が無い: ' + b.gmlId);
    // §11: 駅施設等を普通のbuildingと混ぜない
    assert.match(b.structureKind, /^(NORMAL|STATION|OVER_TRACK|DECK|CANOPY|COMPLEX)$/);
  }
});

test('[32H §14] 時点差（PLATEAU測量年 vs 比較データ年度）が記録されている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(Object.keys(r.temporalDates.plateauSurveyYears).length > 0);
  assert.ok(Object.keys(r.temporalDates.plateauCreationDates).length > 0);
  assert.ok(Array.isArray(r.temporalDates.gsiRoadEdgeVintages));
  assert.equal(typeof r.temporalConflictCount, 'number');
});

test('[32H §19/§20/§22] 最終分類・方針・STOPトークンが揃っている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.match(r.finalClassification, /^(REAL_STRUCTURE_DOMINANT|PLATEAU_FOOTPRINT_QUALITY_ISSUE|TEMPORAL_DATA_CONFLICT|MIXED_CAUSES|INSUFFICIENT_GROUND_TRUTH)$/);
  assert.match(r.stopToken, /^(REAL_WORLD_ROOT_CAUSE_IDENTIFIED|REAL_WORLD_GROUND_TRUTH_INSUFFICIENT)$/);
  assert.ok(r.recommendedPolicy && r.recommendedPolicy.policy);
  assert.match(r.H1Support.verdict, /^H1_(SUPPORTED|PARTIALLY_SUPPORTED|NOT_SUPPORTED)$/);
  assert.match(r.H2Support.verdict, /^H2_(SUPPORTED|NOT_ESTABLISHED)$/);
  assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0, '限界の開示が無い');
});

test('[32H §7] Reality QA overlay runtime API が存在し既定OFF', () => {
  assert.match(html, /let realityQaEnabled = false;/);
  assert.match(html, /async function setRealityQaEnabled\(on\)/);
  assert.match(html, /window\.__SET_REALITY_QA__/);
  assert.match(html, /window\.__REALITY_QA_DEBUG__/);
  assert.match(html, /reality-qa-toggle/);
  // §7: Orthographic Top Down 固定
  assert.match(html, /CanonicalRuntime\.isRealityQaActive\(\)\) return orthoCamera;/);
});

test('[32H §0/§7] QA overlay は read-only（building geometryを再構築しない）', () => {
  const start = html.indexOf('[Mission 32H §7] REALITY QA');
  const end = html.indexOf('function getRealityQaDebug()');
  assert.ok(start > 0 && end > start, 'Mission 32Hのruntimeコード範囲が特定できない');
  const section = html.slice(start, end);
  assert.doesNotMatch(section, /pushExtrude/);
  assert.match(section, /layerGroup\.buildings\.visible = false;/);   // §7: building extrusion OFF
  assert.match(section, /landBlockPocGroup\.visible = false;/);        // §7: Land Block OFF
  assert.match(section, /savedBuildingsVisibleBeforeRealityQa/);       // OFFで必ず戻す
  // §6: 画像は実world extent(4隅の緯度経度)からquadを張る（px数や手動伸縮ではない）
  assert.match(section, /const nw = geoToThree\(o\.north, o\.west\), ne = geoToThree\(o\.north, o\.east\);/);
  assert.match(section, /const sw = geoToThree\(o\.south, o\.west\), se = geoToThree\(o\.south, o\.east\);/);
  // Mission17 のガード（gnd の PlaneGeometry ちょうど1個）を弱めていない
  assert.doesNotMatch(section, /new THREE\.PlaneGeometry\(/);
});

test('[32H 動的] QA overlay ON/OFFで表示が復元されresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__REALITY_QA_DEBUG__();
  assert.equal(before.enabled, false, '既定でONになっている');
  await w.__SET_REALITY_QA__(true);
  await new Promise((res) => setTimeout(res, 300));
  const on = w.__REALITY_QA_DEBUG__();
  assert.equal(on.enabled, true);
  assert.equal(on.dataLoaded, true, 'overlay.jsonがfetchされていない');
  assert.ok(on.osmBuildingCount > 0, 'OSM建物レイヤーが空');
  assert.equal(on.buildingsHidden, true, '§7: 建物3D extrusionが隠れていない');
  assert.equal(on.orthophotoAvailable, false);
  // 別realmの配列なので deepStrictEqual は使わず中身で比較する
  assert.equal(Array.from(on.unavailableLayers).join(','), 'ORTHOPHOTO(base)');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA ON時にresidualが0でない');
  await w.__SET_REALITY_QA__(false);
  const off = w.__REALITY_QA_DEBUG__();
  assert.equal(off.enabled, false);
  assert.equal(off.buildingsHidden, false, 'OFF後に建物表示が復元されていない');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA OFF後にresidualが0でない');
});

test('[32H] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /realityQaEnabled|setRealityQaEnabled|reality-qa/, f + ' に混入');
  }
});
