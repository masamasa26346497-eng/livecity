// tests/umeda-visual-land-block-poc.test.js
// [Mission 32F] UMEDA VISUAL LAND BLOCK PoC。
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

test('[32F §34] validator が PASS', { skip: !rpt('umeda-visual-land-block-poc-validation.json') && 'no report' }, () => {
  const v = rpt('umeda-visual-land-block-poc-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.buildingScaleMutation, 0);
  assert.equal(v.checks.buildingPositionMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.roadV2Mutation, 0);
  assert.equal(v.checks.visualLandBlocksCreated, true);
  assert.equal(v.checks.buildingRetention, true);
  assert.equal(v.checks.rawGsiEdgeHiddenInNormalPoc, true);
  assert.equal(v.checks.landBlockTerminologyCorrect, true);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32F §33] umeda-visual-land-block-poc.json に必須フィールドが揃っている', { skip: !rpt('umeda-visual-land-block-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-land-block-poc.json');
  assert.ok(r.bounds);
  assert.ok(r.landBlock.count > 0);
  assert.ok(r.buildingContainment.total > 0);
  assert.equal(r.buildingContainment.inside99 + r.buildingContainment.inside95 + r.buildingContainment.inside80 + r.buildingContainment.below80, r.buildingContainment.total);
  assert.ok(r.buildingRoadOverlap);
  assert.equal(r.rawGsiEdgeNormalDisplay, false);
  assert.equal(r.renderedBuildingRetention, 100);
  assert.match(r.verdict, /^VISUAL_LAND_BLOCK_POC_(SUCCESS|NOT_BETTER)$/);
});

test('[32F §16] Block containment KPI(inside99/95/80/below80)が実データに基づく', { skip: !rpt('umeda-visual-land-block-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-land-block-poc.json');
  const c = r.buildingContainment;
  assert.ok(c.inside99 > c.below80 * 0.5, '街区への収まりが著しく悪い(要再検討): inside99=' + c.inside99 + ' below80=' + c.below80);
});

test('[32F §17] Building∩ROAD V2 Carriageway が32Eの梅田実測とおおむね整合する', { skip: !rpt('umeda-visual-land-block-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-land-block-poc.json');
  assert.ok(r.buildingRoadOverlap.overlapRatio < 0.15, '32Eの梅田実測(0.0565)から大きく乖離: ' + r.buildingRoadOverlap.overlapRatio);
});

test('[32F §28] Land Block fragmentation が過度でない(tiny+sliverが全体の大半を占めない)', { skip: !rpt('umeda-visual-land-block-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-land-block-poc.json');
  const totalRaw = r.landBlock.count + r.landBlock.tinyCount + r.landBlock.sliverCount;
  const fragRatio = (r.landBlock.tinyCount + r.landBlock.sliverCount) / totalRaw;
  assert.ok(fragRatio < 0.7, 'tiny/sliver比率が高すぎる: ' + fragRatio);
});

test('[32F §2] block生成コードがParcel/Lot/筆界/敷地境界という用語を使っていない', () => {
  const buildSrc = fs.readFileSync(R('tools', 'build-umeda-visual-land-block-poc.js'), 'utf-8');
  const codeLinesOnly = buildSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeLinesOnly, /\bparcel\b|\blot\b|筆界|敷地境界/i);
  assert.match(buildSrc, /VISUAL LAND BLOCK/);
  // runtime側は新規追加した[Mission 32F]ブロックの範囲内だけを確認する(HTML全体には既存の
  // ParkingLayer関連コードで正当な「lot」「敷地境界」用法が別途存在するため、全文検索は誤検出になる)。
  const start = html.indexOf('[Mission 32F] UMEDA VISUAL LAND BLOCK PoC');
  const end = html.indexOf("showRoadVisualModeIsLandBlockOrQa_() { return");
  assert.ok(start > 0 && end > start, 'Mission 32Fのruntimeコード範囲が特定できない');
  // コメント行(自己説明として「Parcelではない」等と書いている行)は除外し、実装コード行だけを確認する
  // (32B illegalWarp・32D parcel conflation audit と同種の自己参照false-positiveをここでも回避)。
  const sectionCodeLinesOnly = html.slice(start, end).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(sectionCodeLinesOnly, /\bparcel\b|\blot\b|筆界|敷地境界/i);
});

test('[32F §18/§21/§22] Road Mode に LAND_BLOCK が統合され、LAND BLOCK QA トグルが既定OFF', () => {
  assert.match(html, /let landBlockQaEnabled = false;/);
  assert.match(html, /async function setLandBlockQaEnabled\(on\)/);
  // [Mission 32I] モード判定が個別比較から ROAD_VISUAL_MODES 配列へ変わった。
  //   LAND_BLOCK が受理モードに含まれ続けていることを検証する（守っている性質は不変）。
  assert.match(html, /const ROAD_VISUAL_MODES = \[[^\]]*'LAND_BLOCK'[^\]]*\];/);
  assert.match(html, /if \(ROAD_VISUAL_MODES\.indexOf\(mode\) < 0\) return \{ mode: roadVisualMode \};/);
  assert.match(html, /window\.__SET_LAND_BLOCK_QA__/);
  assert.match(html, /window\.__LAND_BLOCK_POC_DEBUG__/);
  // [Mission 32I] ROAD V3 / DIFF V2→V3 が追加され、ボタン配列と label が更新された
  //   （守っている性質は不変: 既定 FIX13・LAND_BLOCK が Road Mode に統合されている）。
  assert.match(html, /\['FIX13', 'A:FIX13'\], \['ROAD_V2', 'B:ROAD V2'\], \['ROAD_V3', 'C:ROAD V3'\], \['LAND_BLOCK', 'D:\+LAND BLOCK'\]/);
  assert.match(html, /\['DIFF', 'DIFF'\], \['DIFF_V2_V3', 'DIFF V2→V3'\]/);
});

test('[32F §32] Land Block は merged geometry(1 mesh)で描画される(大量1-block-1-meshを避ける)', () => {
  assert.match(html, /function buildLandBlockPocMeshes\(\)/);
  assert.match(html, /for \(const b of landBlockPocData\.blocks\) pushPolygon\(pos, b\.geometry\.type, b\.geometry\.coordinates, LAND_BLOCK_POC_Y\);/);
  assert.match(html, /mesh\.name = 'UmedaLandBlockMesh';/);
});

test('[32F §31] Building geometryは変更しない(既存footprints/pickingパイプラインを再利用するだけ)', () => {
  assert.doesNotMatch(html, /function buildLandBlockPocMeshes[\s\S]{0,2000}pushExtrude/);
  // QA用のbuilding色分けは既存tileCache(buildings)のfootprintsを再利用しているだけで、
  // building独自のgeometry再構築(座標変更)は行っていないことを確認。
  assert.match(html, /if \(e\.layer !== 'buildings' \|\| !e\.footprints\) continue;/);
});

test('[32F 動的] LAND_BLOCKモード/QAトグルが安全に切り替わりresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__LAND_BLOCK_POC_DEBUG__();
  // [Mission 32K §13] runtime 既定は ROAD_V3 へ昇格した。
  assert.equal(before.roadMode, 'ROAD_V3');
  assert.equal(before.qaEnabled, false);
  const res = await w.__SET_ROAD_VISUAL_MODE__('LAND_BLOCK');
  assert.equal(res.mode, 'LAND_BLOCK');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterOn = w.__LAND_BLOCK_POC_DEBUG__();
  assert.equal(afterOn.blocksLoaded, true, 'blocks.jsonがfetchされていない');
  assert.equal(afterOn.blockCount, 178);
  assert.equal(afterOn.assignmentLoaded, true);
  assert.equal(afterOn.gsiEdgeHidden, true, '§4: raw GSI Road Edgeが隠れていない');
  const residualOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOn.total, 0, 'LAND_BLOCKモード中にresidualが0でない: ' + JSON.stringify(residualOn));

  const resQa = await w.__SET_LAND_BLOCK_QA__(true);
  assert.equal(resQa.enabled, true);
  const residualQa = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualQa.total, 0, 'LAND BLOCK QA中にresidualが0でない: ' + JSON.stringify(residualQa));

  await w.__SET_LAND_BLOCK_QA__(false);
  const resBack = await w.__SET_ROAD_VISUAL_MODE__('FIX13');
  assert.equal(resBack.mode, 'FIX13');
  const afterOff = w.__LAND_BLOCK_POC_DEBUG__();
  assert.equal(afterOff.gsiEdgeHidden, false, '§4: FIX13復帰後はraw GSI Road Edgeの隠蔽状態が解除されている');
  const residualOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOff.total, 0, 'FIX13復帰後にresidualが0でない: ' + JSON.stringify(residualOff));
});

test('[32F §35] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /landBlockQaEnabled|setLandBlockQaEnabled|UmedaLandBlockPocOverlay|visual-land-block-poc/, f + ' に混入');
  }
});
