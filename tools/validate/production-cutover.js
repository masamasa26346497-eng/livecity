#!/usr/bin/env node
// tools/validate/production-cutover.js
// [Mission 32U §26] PRODUCTION CUTOVER の検証。
//   productionDefaultBuildingMode = V2_NEW_OSM / productionBuildingCount = 600764
//   productionRoadMode = ROAD_V3 / productionRawGsiEdge = false / productionUsesBuildingFacts = true
//   productionFakeYield|Rent|Note = false / productionLegacyResidual = 0 / productionDevPanelsVisible = false
//   v1ProductionFetch = 0 / oldOsmProductionFetch = 0 / protectedModified = false
//   → PRODUCTION_CUTOVER_SUCCESS / PRODUCTION_CUTOVER_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { buildProductionHtml } from '../build-production-html.js';
import { stripComments } from './production-data-integrity.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  prod: P('public', 'osaka_3d_buildings.html'),
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  qa: P('data', 'reports', 'production-cutover-qa.json'),
  uiVis: P('data', 'reports', 'production-ui-visibility.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  devPerf: P('data', 'reports', 'v2-runtime-performance.json'),
  perfRecheck: P('data', 'reports', 'production-perf-recheck.json'),
  canon: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  facts: P('data', 'reports', 'building-source-facts.json'),
  out: P('data', 'reports', 'production-cutover-validation.json'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function git(args) {
  try { return execFileSync('git', args, { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim(); } catch { return null; }
}

export async function validateProductionCutover() {
  const errors = [], warnings = [];
  const qa = rj(F.qa);
  if (!qa) {
    const out = { RESULT: 'FAIL', classification: 'PRODUCTION_CUTOVER_FAILED', errors: ['production-cutover-qa.json が無い'] };
    await writeJson(F.out, out); return out;
  }
  const prodHtml = fs.readFileSync(F.prod, 'utf-8');
  const code = stripComments(prodHtml);
  const self = qa.finalSelfCheck || qa.startup.selfCheck || {};
  const sites = qa.sites || [];

  // ── 生成物としての一致（dev からプロファイル 1 行だけ変えたもの） ──
  const build = buildProductionHtml({ check: true });
  const productionIsGeneratedFromDev = build.identical;
  if (!productionIsGeneratedFromDev) errors.push('§0: production HTML が dev からの生成結果と一致しない');
  const productionBuildProfile = /const LIVECITY_BUILD_PROFILE = 'production';/.test(prodHtml);
  if (!productionBuildProfile) errors.push('§16: production HTML のビルドプロファイルが production でない');

  // ── §2/§4/§5/§7/§8 building ──
  const productionDefaultBuildingMode = self.buildingMode || null;
  if (productionDefaultBuildingMode !== 'V2_NEW_OSM') errors.push('§2: production の既定 building mode が V2_NEW_OSM でない: ' + productionDefaultBuildingMode);
  const productionBuildingCount = self.buildingCount != null ? self.buildingCount : null;
  const canonCount = (rj(F.canon) || {}).featureCount;
  if (productionBuildingCount !== 600764 || canonCount !== 600764) errors.push(`§4: building count が 600,764 でない（runtime ${productionBuildingCount} / canonical ${canonCount}）`);
  const defaultsToV2N = /let buildingsVersion = 'V2N';/.test(code);
  if (!defaultsToV2N) errors.push('§2: HTML の既定 buildingsVersion が V2N でない');
  const placementV2 = self.placementVariant === 'v2-final';
  if (!placementV2) errors.push('§6: placement policy が v2-final でない: ' + self.placementVariant);

  // ── §3 road ──
  const productionRoadMode = self.roadMode || null;
  if (productionRoadMode !== 'ROAD_V3') errors.push('§3: production の road mode が ROAD_V3 でない: ' + productionRoadMode);
  const productionRawGsiEdge = self.rawGsiEdge === true;
  if (productionRawGsiEdge) errors.push('§3: raw GSI edge が ON になっている');

  // ── §9 building facts ──
  const factsRequests = (qa.fetchAudit || {}).buildingFactsRequests || 0;
  const productionUsesBuildingFacts = /\/building-facts\/tile_/.test(code) && factsRequests > 0;
  if (!productionUsesBuildingFacts) errors.push('§9: building-facts の lazy fetch が production で使われていない');

  // ── §10/§11/§12 property card ──
  const productionFakeYield = /推定利回り|yieldRate/.test(code);
  const productionFakeRent = /想定賃料|rentLow|rentHigh|estimateRentPerTsubo/.test(code);
  const productionFakeNote = /id="pc-memo"|const memos\s*=|仮の参考値/.test(code);
  const productionFakeFloors = /推定階数|function estimateFloors\(/.test(code);
  if (productionFakeYield) errors.push('§12: production に推定利回りが残っている');
  if (productionFakeRent) errors.push('§12: production に想定賃料が残っている');
  if (productionFakeNote) errors.push('§12: production に自動メモ / 仮値注記が残っている');
  if (productionFakeFloors) errors.push('§11: production に高さからの推定階数が残っている');
  const cardForbiddenHits = sites.flatMap((s) => (s.forbidden || []).map((w) => `${s.site}:${w}`));
  if (cardForbiddenHits.length) errors.push('§12: card に禁止表示が出た ' + JSON.stringify(cardForbiddenHits));
  const townChomeShown = sites.some((s) => s.townSectionVisible);
  if (townChomeShown) errors.push('§12: 未対応の町丁目 section が表示されている');
  const heightPolicyOk = /const showHeight = basis != null && heightIsMeasured\(basis\)/.test(code) && /function heightIsMeasured\(basis\) \{ return basis === 1 \|\| basis === 2 \|\| basis === 4; \}/.test(code);
  if (!heightPolicyOk) errors.push('§10: 高さの表示条件（実測のみ）が production に入っていない');

  // ── §13 最寄駅 / §14 検索 ──
  const stationOk = /const SOURCE = 'map-data\/osaka-city\/derived\/rail-stations\.json';/.test(code) && !/walkMin/.test(code) && !/const STATIONS = \[/.test(code);
  if (!stationOk) errors.push('§13: 最寄駅が canonical 駅データ・直線距離になっていない');
  const searchOk = /const inRange = isInside3dDataArea\(x, z\);/.test(code) && !/const inRange = Math\.abs\(x\) <= 2400 && Math\.abs\(z\) <= 550;/.test(code);
  if (!searchOk) errors.push('§14: 検索の範囲判定が 24 区基準になっていない');

  // ── §15 legacy ──
  const productionLegacyResidual = Math.max(
    qa.startup ? qa.startup.residual : 0,
    ...sites.map((s) => s.residual || 0),
    ...(qa.rivers || []).map((r) => r.residual || 0),
    (qa.smoke && qa.smoke.residual) || 0, (qa.smoke && qa.smoke.cityModeResidual) || 0,
  );
  if (productionLegacyResidual !== 0) errors.push('§15: legacy residual が 0 でない: ' + productionLegacyResidual);

  // ── §16/§17 UI ──
  const ui = qa.finalUi || qa.startup.ui || { devOnly: {}, userUi: {} };
  // production-ui-visibility.js が HTML 内の全 id から開発用 UI を洗い出した結果も合わせて見る
  const uiVis = rj(F.uiVis);
  if (!uiVis) warnings.push('§16: production-ui-visibility.json が無い（網羅確認をしていない）');
  const visibleDevPanels = [
    ...Object.entries(ui.devOnly).filter(([, v]) => v === 'visible').map(([k]) => k),
    ...((uiVis && uiVis.visibleDevUi) || []),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const productionDevPanelsVisible = visibleDevPanels.length > 0;
  if (productionDevPanelsVisible) errors.push('§16: 開発用 UI が production で見えている ' + JSON.stringify(visibleDevPanels));
  const missingUserUi = [
    ...Object.entries(ui.userUi).filter(([, v]) => v === 'absent').map(([k]) => k),
    ...((uiVis && uiVis.missingUserUi) || []),
  ].filter((v, i, a) => a.indexOf(v) === i);
  if (missingUserUi.length) errors.push('§17: 通常 UI が欠けている ' + JSON.stringify(missingUserUi));
  const devUiIdCount = uiVis ? uiVis.devUiIdCount : null;

  // ── §21 fetch 監査 ──
  const fa = qa.fetchAudit || { forbidden: [] };
  const forbiddenCounts = Object.fromEntries((fa.forbidden || []).map((f) => [f.id, f.count]));
  const v1ProductionFetch = (forbiddenCounts['v1-buildings'] || 0) + (forbiddenCounts['v1-building-placement'] || 0) + (forbiddenCounts['v1-ward-index'] || 0) + ((fa.namespaceCounters || {}).V1 || 0);
  const oldOsmProductionFetch = (forbiddenCounts['old-osm-buildings'] || 0) + ((fa.namespaceCounters || {}).V2 || 0);
  const rawGsiEdgeFetch = forbiddenCounts['raw-gsi-road-edge'] || 0;
  if (v1ProductionFetch !== 0) errors.push('§21: V1 building fetch が発生している: ' + v1ProductionFetch);
  if (oldOsmProductionFetch !== 0) errors.push('§21: 旧 OSM fallback fetch が発生している: ' + oldOsmProductionFetch);
  if (rawGsiEdgeFetch !== 0) errors.push('§21: raw GSI edge fetch が発生している: ' + rawGsiEdgeFetch);
  if (!(fa.v2nBuildingRequests > 0)) errors.push('§21: V2 new building fetch が 0');

  // ── §19/§20 9 地点 ──
  const siteOk = sites.length === 9 && sites.every((s) => s.pickedExpected && s.hover === 'block' && s.cardDisplay === 'block' && s.ward && s.station);
  if (!siteOk) errors.push('§19/§20: 地点 QA に失敗 ' + JSON.stringify(sites.map((s) => [s.site, s.pickedExpected, s.hover, s.ward, s.station])));
  const riverOk = (qa.rivers || []).length === 2;
  if (!riverOk) errors.push('§20: 河川地点の確認が不足');

  // ── §22 性能（32P の dev 実測と比較） ──
  // 32P の dev 実測（data/reports/v2-runtime-performance.json の benchmark.runs['<site>-V2N']）
  const devPerf = rj(F.devPerf);
  const devRuns = (devPerf && devPerf.benchmark && devPerf.benchmark.runs) || {};
  const recheck = rj(F.perfRecheck);
  const perf = (qa.performance || []).map((p) => {
    const ref = devRuns[p.site + '-V2N'] || null;
    const rc = (recheck && recheck.runs) ? recheck.runs.filter((r) => r.site === p.site) : [];
    return {
      site: p.site, fpsAverage: p.fpsAverage, fpsP5: p.fpsP5, frameMsP95: p.frameMsP95,
      drawCallsAvg: p.drawCallsAvg, trianglesAvg: p.trianglesAvg, jsHeapMB: p.jsHeapMB,
      loadingTilesMaxDuringBench: p.loadingTilesMaxDuringBench,
      devReference32P: ref ? { fpsAverage: ref.fpsAverage, fpsP5: ref.fpsP5, frameMsP95: ref.frameMsP95, drawCallsAvg: ref.drawCallsAvg, trianglesAvg: ref.trianglesAvg } : null,
      // Network 記録なしで測り直した値（production / development を同条件で比較）
      recheck: Object.fromEntries(rc.map((r) => [r.build, { fpsAverage: r.fpsAverage, fpsP5: r.fpsP5, frameMsP95: r.frameMsP95, drawCallsAvg: r.drawCallsAvg, trianglesAvg: r.trianglesAvg }])),
    };
  });
  const perfOk = perf.length === 2 && perf.every((p) => p.fpsAverage >= 30 && p.frameMsP95 <= 60);
  if (!perfOk) warnings.push('§22: 性能が基準（FPS 平均 30 以上 / frame P95 60ms 以下）を下回る ' + JSON.stringify(perf.map((p) => [p.site, p.fpsAverage, p.frameMsP95])));
  // production と development を同条件（Network 記録なし）で比べ、production 側だけが遅くなっていないか見る
  for (const p of perf) {
    const rc = p.recheck || {};
    if (rc.production && rc.development && rc.production.fpsAverage < rc.development.fpsAverage * 0.9) {
      warnings.push(`§22: ${p.site} は同条件比較で production の方が遅い（dev ${rc.development.fpsAverage} → prod ${rc.production.fpsAverage} FPS）`);
    }
  }

  // ── §23/§24 protected と rollback ──
  const baseline = rj(F.baseline) || {};
  const protSha = sha(F.prot);
  const protectedModified = baseline.prot ? protSha !== baseline.prot : (git(['status', '--porcelain', '--', 'public/osaka_3d_buildings.fullward-v3.html']) !== '');
  if (protectedModified) errors.push('§1/§23: protected HTML が変更されている');
  const rollback = {
    productionTrackedInGit: git(['ls-files', '--', 'public/osaka_3d_buildings.html']) === 'public/osaka_3d_buildings.html',
    previousProductionSha256: baseline.prodBeforeCutover32U || baseline.prod || null,
    previousProductionBlob: git(['rev-parse', 'HEAD:public/osaka_3d_buildings.html']),
    headCommit: git(['rev-parse', 'HEAD']),
    command: 'git checkout -- public/osaka_3d_buildings.html',
  };
  if (!rollback.productionTrackedInGit || !rollback.previousProductionBlob) errors.push('§24: production を git から復元できることを確認できない');

  // ── §28 smoke ──
  const sm = qa.smoke || {};
  const smokeOk = !!sm.wardSwitch && sm.cityMode === true && sm.cityModeResidual === 0 && !!sm.exitCity
    && sm.search && sm.search.msgShown === false && sm.search.distanceM <= 50
    && sm.zoomPan && sm.zoomPan.r1 < sm.zoomPan.r0 && sm.hoverClick === 'block'
    && sm.cardAfterClick === 'block' && sm.cardAfterClose === 'none' && sm.residual === 0;
  if (!smokeOk) errors.push('§28: smoke test に失敗 ' + JSON.stringify(sm));
  const consoleErrors = (qa.consoleErrors || []).length;
  if (consoleErrors) errors.push('§28: ブラウザ例外が出ている ' + JSON.stringify(qa.consoleErrors.slice(0, 3)));

  // ── §18 self-check ──
  const selfCheckOk = self.ok === true && self.profile === 'production';
  if (!selfCheckOk) errors.push('§18: 起動時 self-check が OK でない ' + JSON.stringify(self));

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32U', RESULT,
    classification: errors.length ? 'PRODUCTION_CUTOVER_FAILED' : 'PRODUCTION_CUTOVER_SUCCESS',
    productionDefaultBuildingMode, productionBuildingCount,
    productionRoadMode, productionRawGsiEdge,
    productionUsesBuildingFacts,
    productionFakeYield, productionFakeRent, productionFakeNote, productionFakeFloors,
    productionLegacyResidual, productionDevPanelsVisible, devUiIdCount, visibleDevPanels, missingUserUi,
    v1ProductionFetch, oldOsmProductionFetch, rawGsiEdgeFetch,
    protectedModified,
    productionIsGeneratedFromDev, productionBuildProfile, defaultsToV2N, placementV2,
    stationOk, searchOk, heightPolicyOk, townChomeShown, siteOk, riverOk, smokeOk, selfCheckOk,
    hashes: { production: sha(F.prod), dev: sha(F.dev), protectedNow: protSha, protectedBaseline: baseline.prot || null, productionBaselineBeforeCutover: baseline.prodBeforeCutover32U || baseline.prod || null },
    rollback, performance: perf,
    devPanels: ui.devOnly, userUi: ui.userUi,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateProductionCutover().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
