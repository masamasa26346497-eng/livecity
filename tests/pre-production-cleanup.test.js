// tests/pre-production-cleanup.test.js
// [Mission 32Q] PRE-PRODUCTION CLEANUP（legacy residual / property card の固定表示 / SUPPRESS 2 棟）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] cutover の記録 / baseline hash はコミットされないので、無いときだけ skip
const BASELINE_SKIP = skipIfMissingRel('data/reports/baselines');

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

/** 行頭の定義から次のトップレベル定義までを切り出す（見つからなければ失敗させる） */
function block(head) {
  const s = html.indexOf(head);
  assert.ok(s >= 0, head);
  const rest = html.slice(s + head.length);
  const m = rest.match(/\r?\n(const|function|let|var) [A-Za-z]/);
  const e = m ? s + head.length + m.index : html.length;
  assert.ok(e > s);
  return html.slice(s, e);
}

test('[32Q §1-§4] 旧埋め込みデータのレイヤーは legacyRoot 配下（LEGACY タグ・名前付き）で、scene 直下へは置かない', () => {
  for (const [head, name] of [
    ['const ParkingLayer = (function(){', "'ParkingLayer'"],
    ['const SchoolLayer = (function () {', "'SchoolLayer'"],
    ['const WaterLayer = (function () {', "'WaterLayer'"],
    ['function createSacredLayer(layerName, Y, getData, kindStyle) {', 'layerName'],
    ['const RooftopLayer = (function(){', "'RooftopLayer'"],
  ]) {
    const b = block(head);
    assert.ok(b.includes(`group.name = ${name}; tagRuntimeOwnerRecursive(group, RUNTIME_OWNER.LEGACY);`), head);
    assert.doesNotMatch(b, /scene\.(add|remove)\(group\)|scene\.children\.includes\(group\)/, head);
    assert.match(b, /legacyRoot\.add\(group\)/, head);
    assert.match(b, /legacyRoot\.remove\(group\)/, head);
  }
  // 診断の除外リストへ足して誤魔化していない
  const coexist = html.match(/const COEXIST_NAME = (\/.*\/i);/)[1];
  assert.doesNotMatch(coexist, /Parking|Cemetery|Temple|Rooftop|School/);
  // 共存レイヤーは名前だけ付ける（表示は不変）
  for (const n of ['TreeLayer', 'FacilityLayer', 'LabelLayer', 'WardLabelLayer', 'StationLabelLayer']) {
    assert.match(html, new RegExp(`group = new THREE\\.Group\\(\\); group\\.name = '${n}';`), n);
    assert.match(n, new RegExp(coexist.slice(1, -2), 'i'), n + ' は COEXIST_NAME に合致する');
  }
  assert.match(html, /group\.name = 'StationLabelLayer'; group\.renderOrder = 1001;/);
});

test('[32Q §4/§15] runtime: 旧レイヤーの group は legacyRoot にあり、Canonical 所有中は描画されない', () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML_PATH, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  const roots = w.__SCENE_ROOTS__;
  const names = roots.legacyRoot.children.map((c) => c.name);
  assert.ok(names.includes('ParkingLayer'), JSON.stringify(names));
  assert.ok(names.includes('CemeteryLayer'), JSON.stringify(names));
  assert.ok(!w.__SCENE__.children.some((c) => ['ParkingLayer', 'CemeteryLayer', 'TempleLayer', 'RooftopLayer'].includes(c.name)));
  assert.equal(roots.legacyRoot.visible, false, 'Canonical 所有中は legacyRoot を隠す');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[32Q §14] status: self-check 済みで residual 0 なら [CANONICAL OK]（未検証中は従来の [CANONICAL]）', () => {
  assert.match(html, /else if \(enabled && selfCheck\.ran && selfCheck\.ok\) \{ head = '\[CANONICAL OK\]'; color = '#8ef0b0'; \}/);
  assert.match(html, /else if \(enabled\) \{ head = '\[CANONICAL\]'; color = '#8ef0b0'; \}/);
  assert.match(html, /Legacy residual: 0/);
});

test('[32Q §6-§8] property card: 固定の「南港南エリア」を出さず、実データがあるときだけ地域を付ける', () => {
  assert.doesNotMatch(html, /pc-title'\)\.textContent = [^\n]*南港南エリア/);
  // [33E] 見出しは「ランドマーク名 or 用途名」＋（実データがあるときだけ）地域名。
  //   地域名の付け方（areaLabel が無ければ付けない）は 32Q のまま。
  assert.match(html, /textContent = \(landmarkName \|\| usageDisplayName\(d\)\) \+ \(areaLabel \? ' ／ ' \+ areaLabel : ''\);/);
  const src = html.slice(html.indexOf('function propertyAreaLabel(d) {'), html.indexOf('function showPropertyCard(d){'));
  const ctx = { WardModeManager: { WARD_DEFS: [{ id: 'kita', name: '北区' }, { id: 'sumiyoshi', name: '住吉区' }] } };
  vm.createContext(ctx);
  vm.runInContext(src + '; this.f = propertyAreaLabel;', ctx);
  const f = ctx.f;
  assert.equal(f({ wardId: 'kita' }), '大阪市北区');
  assert.equal(f({ ward: '住吉区', town: '長居1丁目' }), '住吉区長居1丁目');
  assert.equal(f({ ward: '住吉区', town: '住吉区長居1丁目' }), '住吉区長居1丁目');
  assert.equal(f({ ward: '住吉区' }), '住吉区');
  assert.equal(f({ wardId: 'unknown-ward' }), null);
  assert.equal(f({}), null);
  assert.equal(f(null), null);
});

test('[32Q §10-§13] SUPPRESS 2 棟: 個別確認の根拠を残し、placement 全体は再生成しない', { skip: BASELINE_SKIP }, () => {
  const ov = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'v2-final', 'placement-overrides.json'));
  assert.ok(ov);
  assert.equal(ov.overrides.length, 2);
  const [A, B] = ov.overrides;
  assert.equal(A.policy, 'REVIEW');
  assert.equal(B.policy, 'SUPPRESS');
  for (const o of [A, B]) for (const k of ['source', 'areaM2', 'osm', 'gsi', 'waterRatio', 'classification', 'decision']) assert.ok(o.evidence[k] != null, o.label + ' ' + k);
  assert.match(A.evidence.osm.waterStructureNearby, /seamark:type=berth/);
  assert.equal(B.evidence.gsi.buildingCoveringFootprint, false);
  const pm = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'));
  assert.equal(pm.policyCounts.SUPPRESS, 1);
  assert.equal(pm.policyCounts.DISPLAY + pm.policyCounts.SUPPRESS + pm.policyCounts.REVIEW + pm.policyCounts.EXEMPT, 600764);
  assert.equal(pm.individualOverrides.count, 2);
  const report = rpt('v2-placement-policy.json');
  assert.equal(pm.generatedAt, report.generatedAt, 'placement 全体は 32P の生成物のまま');
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'apply-placement-overrides.js'), 'utf-8');
  assert.match(src, /removeStray: false/);
  assert.doesNotMatch(src, /fs\.rmSync\(/);
});

test('[32Q §16/§19] validator が PASS', { skip: skip('pre-production-cleanup-validation.json') }, () => {
  const v = rpt('pre-production-cleanup-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'PRE_PRODUCTION_CLEANUP_SUCCESS');
  for (const k of ['buildingV2Mutation', 'roadV3Mutation', 'projectionMutation', 'legacyResidual', 'visibleLegacyObjects']) assert.equal(v[k], 0, k);
  assert.equal(v.propertyAreaHardcodeRemoved, true);
  assert.equal(v.suppress2Reviewed, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.equal(v.residualBefore, 4);
});
