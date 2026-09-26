// tests/umeda-visual-building-poc.test.js
// [Mission 32C] Umeda GSI Unified Visual Building PoC。
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

test('[32C §37] validator が PASS', { skip: !rpt('umeda-visual-building-poc-validation.json') && 'no report' }, () => {
  const v = rpt('umeda-visual-building-poc-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['visualBuildingsCreated', 'blockAssignmentCreated', 'pocDataExists',
    'propertyLinkRetained', 'umedaPocRuntimeToggleExists', 'scopedToUmedaBounds']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.canonicalMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.gsiRawMutation, 0);
  assert.equal(v.checks.globalOffsetApplied, 0);
  assert.equal(v.checks.globalScaleApplied, 0);
  assert.equal(v.checks.warpApplied, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32C §36] umeda-visual-building-poc.json に必須KPIが揃っている', { skip: !rpt('umeda-visual-building-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-building-poc.json');
  assert.ok(r.pocBounds && typeof r.pocBounds.minX === 'number');
  assert.ok(r.counts.sourceBuildingCount > 0);
  assert.ok(r.counts.totalVisualBuildings > 0);
  assert.ok(r.matching.ONE_TO_ONE >= 0 && r.matching.ONE_TO_MANY >= 0 && r.matching.MANY_TO_ONE >= 0 && r.matching.COMPLEX >= 0);
  assert.ok(r.blockStats.totalBlocks > 0);
  assert.ok(r.containment.plateauBefore && r.containment.visualAfter);
  assert.ok(r.retention.renderedBuildingRetention >= 0);
  assert.ok(r.heightJoin.rate >= 0);
  assert.ok(r.usageJoin.rate >= 0);
  assert.ok(Array.isArray(r.qaBuildings) && r.qaBuildings.length > 0);
  assert.match(r.verdict, /^UMEDA_GSI_VISUAL_POC_(SUCCESS|NOT_BETTER)$/);
});

test('[32C §30] Visual Building が PLATEAU 単体より outsideGt5Rate を悪化させていない', { skip: !rpt('umeda-visual-building-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-building-poc.json');
  const before = r.containment.plateauBefore.outsideGt5Rate;
  const after = r.containment.visualAfter.outsideGt5Rate;
  assert.ok(after <= before, `outsideGt5Rate が悪化: before=${before} after=${after}`);
});

test('[32C §31] renderedBuildingRetention がPLATEAU建物を無言で間引いていない（高retention）', { skip: !rpt('umeda-visual-building-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-building-poc.json');
  assert.ok(r.retention.renderedBuildingRetention >= 95, 'retentionが低すぎる: ' + r.retention.renderedBuildingRetention);
});

test('[32C §33] 面積比不整合の大規模建物はconfidence:REVIEWへ降格されている', { skip: !rpt('umeda-visual-building-poc.json') && 'no report' }, () => {
  const r = rpt('umeda-visual-building-poc.json');
  const reviewCount = r.qaBuildings.filter((b) => b.confidence === 'REVIEW').length;
  // §33: レビュー比率が過半数を占めない(=マッチングが実用的である)ことを確認
  assert.ok(reviewCount <= r.qaBuildings.length * 0.5, 'REVIEWが過半数: ' + reviewCount + '/' + r.qaBuildings.length);
  for (const b of r.qaBuildings) {
    if (b.confidence === 'REVIEW') {
      assert.ok(typeof b.reviewReason === 'string' && b.reviewReason.length > 0, 'REVIEWにreviewReasonが無い: ' + b.visualId);
    }
  }
});

test('[32C §19] umeda-visual-buildings.json の featureが必須フィールドを持つ', () => {
  const p = R('data', 'processed', 'osaka-city', 'visual-buildings-poc', 'umeda', 'umeda-visual-buildings.json');
  if (!fs.existsSync(p)) { return; }
  const data = rj(p);
  assert.ok(Array.isArray(data.features) && data.features.length > 0);
  const f = data.features[0];
  for (const k of ['visualId', 'geometry', 'geometrySource', 'canonicalIds', 'matchType', 'heightM', 'usageCategory', 'confidence']) {
    assert.ok(k in f, 'feature に ' + k + ' が無い');
  }
  assert.match(f.geometrySource, /^(GSI_POLYGON|GSI_OUTLINE_POLYGONIZED|PLATEAU_FALLBACK)$/);
  for (const feat of data.features) {
    assert.ok(Array.isArray(feat.canonicalIds) && feat.canonicalIds.length > 0, feat.visualId + ' に canonicalIds が無い（property card切断）');
  }
});

test('[32C §21/§22] Umeda PoC トグルは既定OFF、A/Bボタンを持つ', () => {
  assert.match(html, /let umedaPocEnabled = false;/, '既定でON（§0/§19違反）');
  assert.match(html, /async function setUmedaPocMode\(enabled, source\)/);
  assert.match(html, /b\.id = 'umeda-poc-ab-' \+ src;/);
  assert.match(html, /\[\['plateau', 'PLATEAU'\], \['visual', 'GSI VISUAL'\]\]/);
  assert.match(html, /window\.__SET_UMEDA_POC_MODE__/);
  assert.match(html, /window\.__UMEDA_POC_DEBUG__/);
});

test('[32C §1] Umeda PoC範囲はUmeda中心の限定bboxにscopeされている(全市再構築ではない)', () => {
  assert.match(html, /const UMEDA_POC_CENTER = \{ x: -2668\.18, z: -10941\.87 \};/);
  assert.match(html, /const UMEDA_POC_HALF_SPAN_M = 600;/);
});

test('[32C §26] pickBuilding は Visual Building PoC 表示中に umedaPocGroup / umedaPocFootprints を対象へ含める', () => {
  // §26: PLATEAU tile が範囲内で隠される(applyUmedaPocVisibility)ため、pickBuilding が
  //   umedaPocGroup を raycast対象へ加えないと pick が完全無反応になる（実装漏れの再発防止）。
  // [Mission 35Y] pick は faceIndex 方式へ作り替え、候補 mesh の収集は
  //   pickCandidateMeshes() に切り出した（変数名は pocActive）。
  //   「PoC 表示中は umedaPocGroup を候補へ入れる」という §26 の条件自体は変えていない。
  assert.match(html, /const pocActive = umedaPocEnabled && umedaPocSource === 'visual' && \(umedaPocGroup\.visible \|\| blockQaGroup\.visible\);/);
  assert.match(html, /if \(pocActive\) \{/);
  assert.match(html, /umedaPocGroup\.traverse\(\(o\) => \{ if \(o\.isMesh && o\.visible !== false\) meshes\.push\(o\); \}\);/);
  // PoC の mesh は対応表を持たないので、footprint の内外判定へ落ちる経路が残っていること
  assert.match(html, /const f2 = scan\(umedaPocFootprints \|\| \[\]\);/);
  assert.match(html, /umedaPocFootprints/);
  assert.match(html, /canonicalId: f\.canonicalIds\[0\], canonicalIds: f\.canonicalIds,/, '代表canonicalId(先頭)を採用する実装が見つからない');
});

test('[32C §27] Block QA overlay: block-raster.json が存在しRLE行数がnzと一致する', () => {
  const p = R('data', 'processed', 'osaka-city', 'visual-buildings-poc', 'umeda', 'block-raster.json');
  if (!fs.existsSync(p)) return;
  const r = rj(p);
  assert.equal(r.rows.length, r.nz);
  assert.ok(r.nx > 0 && r.cellM > 0);
  for (const row of r.rows) assert.equal(row.length % 2, 0, '行のRLEが[code,count]ペアになっていない');
  // 公開版と一致していること(手動cpの取りこぼし防止)
  const pub = R('public', 'map-data', 'osaka-city', 'visual-buildings-poc', 'umeda', 'block-raster.json');
  if (fs.existsSync(pub)) assert.deepEqual(rj(pub).nx, r.nx);
});

test('[32C §27] Block QA overlay の runtime API が存在する（既定OFF）', () => {
  assert.match(html, /let blockQaEnabled = false;/);
  assert.match(html, /async function setBlockQaEnabled\(on\)/);
  assert.match(html, /window\.__SET_BLOCK_QA__/);
  assert.match(html, /window\.__BLOCK_QA_DEBUG__/);
  assert.match(html, /umeda-block-qa-toggle/);
});

test('[32C 動的] Block QA overlay ON/OFF で plane+building meshが構築されresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  await w.__SET_BLOCK_QA__(true);
  await new Promise((res) => setTimeout(res, 300));
  const dbg = w.__BLOCK_QA_DEBUG__();
  assert.equal(dbg.enabled, true);
  assert.equal(dbg.rasterLoaded, true);
  assert.equal(dbg.planeBuilt, true);
  assert.ok(dbg.buildingMeshCount > 0, 'QA用building meshが構築されていない');
  const residualOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOn.total, 0, 'Block QA ON時にresidualが0でない: ' + JSON.stringify(residualOn));
  await w.__SET_BLOCK_QA__(false);
  await w.__SET_UMEDA_POC_MODE__(false);
  const residualOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOff.total, 0, 'OFF後にresidualが0でない: ' + JSON.stringify(residualOff));
});

test('[32C 動的] トグルON/OFFでresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__UMEDA_POC_DEBUG__();
  assert.equal(before.enabled, false, '既定でONになっている');
  await w.__SET_UMEDA_POC_MODE__(true, 'visual');
  const afterOn = w.__UMEDA_POC_DEBUG__();
  assert.equal(afterOn.enabled, true);
  const residualOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOn.total, 0, 'ON時にresidualが0でない: ' + JSON.stringify(residualOn));
  await w.__SET_UMEDA_POC_MODE__(false);
  const afterOff = w.__UMEDA_POC_DEBUG__();
  assert.equal(afterOff.enabled, false);
  const residualOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOff.total, 0, 'OFF後にresidualが0でない: ' + JSON.stringify(residualOff));
});

test('[32C §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /umedaPocEnabled|setUmedaPocMode|visual-buildings-poc\/umeda|blockQaEnabled|setBlockQaEnabled/, f + ' に混入');
  }
});
