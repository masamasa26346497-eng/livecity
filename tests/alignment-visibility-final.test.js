// tests/alignment-visibility-final.test.js
// [Mission ALIGNMENT-VISIBILITY-FINAL] PLATEAU footprint(cyan)/GSI Building Outline(magenta)の
//   独立overlay生成・Y/renderOrder分離・picking停止・6地点でのcount>0動的検証。
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

const SITE_IDS = ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi'];

test('[VISIBILITY-FINAL §20] validator が PASS', { skip: !rpt('alignment-visibility-final-validation.json') && 'no report' }, () => {
  const v = rpt('alignment-visibility-final-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['plateauFootprintIndependentSource', 'gsiBuildingOutlineIndependentSource',
    'refreshReferenceOverlaysExists', 'yOffsetSeparated', 'renderOrderSeparated', 'dedicatedMaterials',
    'pickingDisabledOnClick', 'pickingDisabledOnHover', 'propertyCardHiddenOnEnter',
    'overlayCountsUiExists', 'legendUiExists', 'gsiBuildingOutlineTiled', 'gsiBuildingOutlinePublished',
    'plateauFootprintSourceAvailable']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.geometryMutation, 0);
  assert.equal(v.checks.coordinateMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[VISIBILITY-FINAL §5/§6] Y offset と renderOrder が road<plateau<gsiBld の順で分離されている', () => {
  assert.match(html, /const Y_REF_PLATEAU = 0\.25;/);
  assert.match(html, /const Y_REF_GSI_BLD = 0\.30;/);
  assert.match(html, /const REN_REF_PLATEAU = REN\.building \+ 30;/);
  assert.match(html, /const REN_REF_GSI_BLD = REN\.building \+ 40;/);
});

test('[VISIBILITY-FINAL §7/§8] Reference専用 material が depthTest/depthWrite off・専用色で定義されている', () => {
  assert.match(html, /color: 0x00e5ff, transparent: true, opacity: 0\.95, depthTest: false, depthWrite: false/);
  assert.match(html, /color: 0xff00d4, transparent: true, opacity: 0\.95, depthTest: false, depthWrite: false/);
});

test('[VISIBILITY-FINAL] 動的: 6地点全てで PLATEAU/GSI Building/GSI Road Edge の count が 0 でない（§11/§12）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  for (const id of SITE_IDS) {
    const active = await w.__SET_REFERENCE_ALIGNMENT__(true, id);
    assert.equal(active, true, id + ' で ON にならなかった');
    const dbg = w.__REFERENCE_ALIGNMENT_DEBUG__();
    assert.ok(dbg.overlay.plateauFootprintCount > 0, id + ': PLATEAU footprint count が0（§12: Canonical building overlay generation bug）');
    assert.ok(dbg.overlay.plateauFootprintVisible > 0, id + ': PLATEAU footprint visible が0');
    assert.ok(dbg.overlay.gsiBuildingOutlineCount > 0, id + ': GSI building outline count が0（§11: runtime接続bug）');
    assert.ok(dbg.overlay.gsiBuildingOutlineVisible > 0, id + ': GSI building outline visible が0');
    assert.ok(dbg.overlay.gsiRoadEdgeCount > 0, id + ': GSI road edge count が0');
    assert.equal(dbg.orthographic, true, id + ': orthographic が true でない');
    assert.equal(dbg.visible3DBuildings, 0, id + ': 通常3D building meshが非表示になっていない');
  }
  await w.__SET_REFERENCE_ALIGNMENT__(false);
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residual.total, 0, 'Reference Alignment 6地点巡回後も residual が0でない: ' + JSON.stringify(residual));
});

test('[VISIBILITY-FINAL §10] site切替のたびに overlay が refresh され、前siteのcountに固定されない', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  await w.__SET_REFERENCE_ALIGNMENT__(true, 'umeda');
  const umeda = w.__REFERENCE_ALIGNMENT_DEBUG__().overlay;
  await w.__SET_REFERENCE_ALIGNMENT__(true, 'sumiyoshi');
  const sumiyoshi = w.__REFERENCE_ALIGNMENT_DEBUG__().overlay;
  // 住吉は梅田よりPLATEAU footprint数が多い実測値（8,352 vs 1,986・共有db参照）のため、
  // 同じ値のまま固定されていれば refresh されていない証拠になる。
  assert.notEqual(umeda.plateauFootprintCount, sumiyoshi.plateauFootprintCount, 'site切替後もPLATEAU footprint countが変わっていない（refresh漏れ疑い）');
});

test('[VISIBILITY-FINAL §14] Reference Alignment 中は building click/hover ガードが両方存在する', () => {
  const clickIdx = html.indexOf("window.addEventListener('click',e=>{");
  const clickSlice = html.slice(clickIdx, clickIdx + 800);
  assert.match(clickSlice, /CanonicalRuntime\.isReferenceAlignmentActive/);
  const moveIdx = html.lastIndexOf("window.addEventListener('mousemove',e=>{", html.indexOf('function selectBuilding'));
  const moveSlice = html.slice(moveIdx, moveIdx + 600);
  assert.match(moveSlice, /CanonicalRuntime\.isReferenceAlignmentActive/);
});

test('[VISIBILITY-FINAL §21] currentSampleのmethodology note が正直に記録されている（centroid-to-centroidではない旨）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  const w = r.window;
  await w.__SET_REFERENCE_ALIGNMENT__(true, 'umeda');
  const dbg = w.__REFERENCE_ALIGNMENT_DEBUG__();
  assert.ok(dbg.currentSampleMethodologyNote && /centroid-to-centroid/.test(dbg.currentSampleMethodologyNote));
});

test('[VISIBILITY-FINAL §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /ReferencePlateauFootprint|ReferenceGsiBuildingOutline|REF_PLATEAU_MAT|REF_GSI_BLD_MAT/, f + ' に混入');
  }
});
