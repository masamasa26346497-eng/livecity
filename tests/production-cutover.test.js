// tests/production-cutover.test.js
// [Mission 32U] PRODUCTION CUTOVER
//   production HTML は ward-ux-v1（development で確定した production candidate）から
//   ビルドプロファイル 1 行だけを変えて生成したものであること。
//   production では開発用 QA UI が出ず、既定が V2 CORRECTED + OSM V2 / ROAD V3 であること。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderProductionHtml, buildProductionHtml } from '../tools/build-production-html.js';
import { stripComments } from '../tools/validate/production-data-integrity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const prod = fs.readFileSync(PROD, 'utf-8');
const prodCode = stripComments(prod);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('[32U] production は cutover 時のビルド成果物そのもの（手編集されていない）', () => {
  // production は tools/build-production-html.js が dev から生成する。以後のミッションで dev だけが
  // 進んでいる間も、production は「最後に昇格したビルド」と完全一致していなければならない。
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256, 'production-cutover-build.json が無い');
  assert.equal(sha(PROD), build.productionSha256, 'production が最後のビルド成果物と一致しない（手編集の疑い）');
  assert.match(prod, /const LIVECITY_BUILD_PROFILE = 'production';/);
});

test('[32U] dev が昇格時点から進んでいなければ production は dev の生成結果と一致する', () => {
  const dev = fs.readFileSync(DEV, 'utf-8');
  const build = rpt('production-cutover-build.json');
  if (build && build.devSha256 && build.devSha256 !== sha(DEV)) {
    // development が先行している状態（次の cutover で production へ反映する）。
    assert.notEqual(renderProductionHtml(dev), prod, 'dev が進んでいるのに production と一致している（ビルド記録の不整合）');
    return;
  }
  assert.equal(renderProductionHtml(dev), prod);
  assert.equal(buildProductionHtml({ check: true }).identical, true);
  // 差分は 1 行だけ
  const a = dev.split(/\r?\n/), b = prod.split(/\r?\n/);
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diff.length, 1, JSON.stringify(diff));
  assert.match(a[diff[0]], /const LIVECITY_BUILD_PROFILE = 'development';/);
  assert.match(b[diff[0]], /const LIVECITY_BUILD_PROFILE = 'production';/);
});

test('[32U §16] production では開発用 overlay が CSS で隠れる（コードは残す）', () => {
  for (const id of ['canonical-runtime-status', 'residual-detail-panel', 'ward-diag', 'perf-hud', 'scale-ruler-label', 'fps']) {
    assert.match(prod, new RegExp(`html\\[data-livecity-build="production"\\] #${id}`), id);
  }
  assert.match(prod, /try \{ document\.documentElement\.setAttribute\('data-livecity-build', LIVECITY_BUILD_PROFILE\); \}/);
  // QA 用のコード自体は残っている（§16: コードを残してもよい）
  assert.match(prod, /buildings-version-/);
  assert.match(prod, /__SET_MAP_AUDIT_MODE__/);
});

test('[32U §2/§3/§6/§8] production の既定構成', () => {
  // [Mission 35G] ユーザー承認のうえ V4（618,749）へ昇格した。V2N の namespace 定数は残る。
  assert.match(prodCode, /let buildingsVersion = 'V4';/);
  assert.match(prodCode, /const BASE_V4_FINAL = BASE\.replace\(\/\\\/derived\$\/, '\/derived-v4-final'\);/);
  assert.match(prodCode, /let roadVisualMode = 'ROAD_V3';/);
  assert.doesNotMatch(prodCode, /let gsiEdgeEnabled = true;/);
  assert.match(prodCode, /let gsiEdgeEnabled = false;/);
});

test('[32U §9/§10/§11/§12] production の property card 方針', () => {
  assert.match(prodCode, /\/building-facts\/tile_/);
  assert.match(prodCode, /function heightIsMeasured\(basis\) \{ return basis === 1 \|\| basis === 2 \|\| basis === 4; \}/);
  for (const re of [/推定利回り/, /想定賃料/, /id="pc-memo"/, /推定階数/, /yieldRate/, /rentLow/, /function estimateFloors\(/]) {
    assert.doesNotMatch(prodCode, re, String(re));
  }
});

test('[32U §18] production 起動時 self-check がある', () => {
  assert.match(prod, /window\.__PRODUCTION_SELF_CHECK__ = function \(\) \{/);
  assert.match(prod, /if \(LIVECITY_BUILD_PROFILE === 'production'\) \{/);
  assert.match(prod, /console\.warn\('\[LiveCity\] production self-check MISMATCH', r\);/);
});

test('[32U §1/§23] protected は不変', () => {
  const baseline = rpt('baselines/prod-protected-hashes.json');
  assert.ok(baseline && baseline.prot, 'baseline hash が無い');
  assert.equal(sha(PROT), baseline.prot);
});

test('[32U §19-§22] 実ブラウザ QA', { skip: skip('production-cutover-qa.json') }, () => {
  const qa = rpt('production-cutover-qa.json');
  assert.equal(qa.sites.length, 9);
  for (const s of qa.sites) {
    assert.equal(s.pickedExpected, true, s.site);
    assert.equal(s.hover, 'block', s.site);
    assert.equal(s.cardDisplay, 'block', s.site);
    assert.deepEqual(s.forbidden, [], s.site);
    assert.equal(s.residual, 0, s.site);
  }
  assert.equal(qa.rivers.length, 2);
  assert.deepEqual(qa.consoleErrors, []);
  for (const f of qa.fetchAudit.forbidden) assert.equal(f.count, 0, f.id);
  assert.ok(qa.fetchAudit.v2nBuildingRequests > 0);
  assert.equal(qa.finalSelfCheck.ok, true, JSON.stringify(qa.finalSelfCheck));
  assert.equal(qa.performance.length, 2);
});

test('[32U §26] validator が PASS', { skip: skip('production-cutover-validation.json') }, () => {
  const v = rpt('production-cutover-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'PRODUCTION_CUTOVER_SUCCESS');
  assert.equal(v.productionDefaultBuildingMode, 'V2_NEW_OSM');
  assert.equal(v.productionBuildingCount, 600764);
  assert.equal(v.productionRoadMode, 'ROAD_V3');
  assert.equal(v.productionRawGsiEdge, false);
  assert.equal(v.productionUsesBuildingFacts, true);
  for (const k of ['productionFakeYield', 'productionFakeRent', 'productionFakeNote', 'productionDevPanelsVisible', 'protectedModified']) {
    assert.equal(v[k], false, k);
  }
  assert.equal(v.productionLegacyResidual, 0);
  assert.equal(v.v1ProductionFetch, 0);
  assert.equal(v.oldOsmProductionFetch, 0);
});
