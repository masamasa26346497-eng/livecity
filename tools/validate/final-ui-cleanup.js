#!/usr/bin/env node
// tools/validate/final-ui-cleanup.js
// [Mission 32R §15/§19] FINAL UI CLEANUP の検証。
//   buildingV2Mutation = 0 / roadV3Mutation = 0 / projectionMutation = 0
//   propertyCardVisibleAboveDevPanel = true
//   nearestStationUsesCanonicalStationData = true / nearestStationUsesWorldDistance = true
//   staleNankoMinamiSearchText = false
//   productionModified = false / protectedModified = false
//   → FINAL_UI_CLEANUP_SUCCESS / FINAL_UI_CLEANUP_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { classify } from '../audit/stale-ui-text-scan.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'final-ui-cleanup-qa.json'),
  scanBefore: P('data', 'reports', 'stale-ui-text-scan-before.json'),
  scanAfter: P('data', 'reports', 'stale-ui-text-scan-after.json'),
  canonStations: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'),
  pubStations: P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'),
  placement: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  wardIndex: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  cleanup32q: P('data', 'reports', 'pre-production-cleanup-validation.json'),
  out: P('data', 'reports', 'final-ui-cleanup-validation.json'),
};
const FROZEN = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-corrected/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-osm-fallback/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return m;
}

export async function validateFinalUiCleanup() {
  const errors = [], warnings = [];
  const qa = rj(F.qa), before = rj(F.scanBefore), after = rj(F.scanAfter);
  if (!qa || !before || !after) {
    const out = { RESULT: 'FAIL', classification: 'FINAL_UI_CLEANUP_FAILED', errors: ['QA / scan レポートが無い'] };
    await writeJson(F.out, out); return out;
  }
  const missionStart = Date.parse(before.generatedAt);
  const html = fs.readFileSync(F.html, 'utf-8');

  // ── 変更禁止 ──
  const touched = FROZEN.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const merged = rj(P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json')) || {};
  const buildingV2Mutation = touched.length + (merged.featureCount === 600764 ? 0 : 1);
  if (buildingV2Mutation) errors.push('§0: Building V2 / OSM fallback V2 が変わっている ' + JSON.stringify(touched));
  const roadV3Mutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadV3Mutation) errors.push('§0: ROAD V3 が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (projectionMutation) errors.push('§0: projection / origin が変わっている');
  const placementMutation = [F.placement, F.wardIndex].filter((p) => fs.statSync(p).mtimeMs > missionStart).length;
  if (placementMutation) errors.push('§0: placement policy / ward index が変わっている');

  // ── §1-§4 property card > dev panel ──
  const css = /#prop-card\{z-index:99998 !important;max-height:calc\(100vh - var\(--lc-topbar-h\) - 28px\);overflow-y:auto !important\}/.test(html)
    && /body\.lc-prop-card-open #canonical-runtime-status\{right:calc\(20px \+ 280px \+ 12px\) !important\}/.test(html)
    && /classList\.toggle\('lc-prop-card-open', card\.style\.display === 'block'\)/.test(html);
  const panelZ = Number((html.match(/'position:fixed', 'right:12px', 'bottom:12px', 'z-index:(\d+)'/) || [])[1]);
  const cards = qa.cards || [];
  const allVp = [...cards.map((c) => ({ ...c.visibility, tag: c.site })), ...(qa.viewports || []).map((v) => ({ ...v, tag: v.viewport.join('x') }))];
  const propertyCardVisibleAboveDevPanel = css && panelZ < 99998 && cards.length === 6
    && allVp.every((v) => v.hiddenPoints === 0 && v.stationRowVisible && v.cardFullyInViewport && v.lastRowReachable)
    && cards.every((c) => c.visibility.panelOverlapsCard === false && c.visibility.panelVisible && c.visibility.bodyClassOpen)
    && qa.afterClose && qa.afterClose.bodyClassOpen === false && qa.afterClose.panelRight === 12;
  if (!propertyCardVisibleAboveDevPanel) errors.push('§1-§4: property card が開発用パネルに隠れる / 全文が見えない ' + JSON.stringify(allVp.map((v) => [v.tag, v.hiddenPoints, v.cardFullyInViewport, v.lastRowReachable])));
  if (!cards.every((c) => c.pickedExpected && c.hover === 'block')) errors.push('§14: hover / click で狙った建物が選ばれない');

  // ── §5-§10 最寄駅 ──
  const sameData = fs.existsSync(F.pubStations) && sha(F.pubStations) === sha(F.canonStations) && (rj(F.pubStations).stations || []).length === 233;
  const noHardcoded = !/const STATIONS = \[/.test(html) && !/STATIONS\[Math\.floor\(r\*STATIONS\.length\)\]/.test(html) && !/walkMin/.test(html);
  const nearestStationUsesCanonicalStationData = sameData && noHardcoded
    && /const SOURCE = 'map-data\/osaka-city\/derived\/rail-stations\.json';/.test(html)
    && cards.every((c) => c.nearest && c.nearest.source === 'map-data/osaka-city/derived/rail-stations.json' && c.nearest.count === 233);
  if (!nearestStationUsesCanonicalStationData) errors.push('§6: 最寄駅が canonical 駅データを使っていない ' + JSON.stringify({ sameData, noHardcoded }));
  const nearestStationUsesWorldDistance = /Math\.hypot\(st\.point\[0\] - x, st\.point\[1\] - z\)/.test(html)
    && /nearestStationText\(d\)/.test(html) && cards.every((c) => c.stationMatchesIndependentCalc);
  if (!nearestStationUsesWorldDistance) errors.push('§7: 最寄駅が建物重心からの world 距離で決まっていない（独立計算と不一致）');
  const walkingTimeShown = cards.some((c) => c.walkingTimeShown) || /（徒歩'\+/.test(html);
  if (walkingTimeShown) errors.push('§8: 直線距離を徒歩時間として表示している');
  if (!cards.every((c) => c.stationPlausible)) errors.push('§10: 駅が距離的に妥当でない地点がある ' + JSON.stringify(cards.map((c) => [c.site, c.station])));

  // ── §11-§13 検索文言・残存 ──
  const devUiBefore = before.hits.filter((h) => h.cls === 'dev-html-ui').length;
  const devAfter = after.hits.filter((h) => h.file === 'public/osaka_3d_buildings.ward-ux-v1.html');
  const staleNankoMinamiSearchText = /南港南/.test(html) || devAfter.length > 0
    || !(qa.search.outOfRange.msgShown && qa.search.outOfRange.msg.includes('現在の3Dデータ提供範囲外です') && !/南港南/.test(qa.search.outOfRange.msg));
  if (staleNankoMinamiSearchText) errors.push('§11-§13: 検索文言 / 開発版 HTML に旧表記が残る');
  for (const q of ['梅田', '難波', '天王寺', '本町']) {
    const r = qa.search[q];
    if (!r || r.msgShown || r.cameraToSpotM > 50 || !r.inside) errors.push(`§12: 「${q}」の検索で範囲外扱い / 移動しない ` + JSON.stringify(r));
  }
  const unexpectedAfter = after.hits.filter((h) => h.cls === 'dev-html-ui' || h.cls === 'other' || h.cls === 'public-data' && !/南港南(入口|出口)/.test(h.text));
  if (unexpectedAfter.length) warnings.push('分類外の残存: ' + JSON.stringify(unexpectedAfter.slice(0, 5).map((h) => h.file + ':' + h.line)));

  // ── §14 回帰 ──
  const reg = qa.regression || {};
  const regressionOk = ['V1', 'V2', 'V2N'].every((v) => reg['button-' + v] && reg['button-' + v].version === v && reg['button-' + v].residual === 0)
    && reg.ward && reg.ward.ward === 'kita' && reg.ward.residual === 0
    && reg.mapAudit && reg.mapAudit.on === true && reg.mapAudit.off === false
    && reg.refAlign && reg.refAlign.on === true && reg.refAlign.off === false
    && reg.afterQaModes && reg.afterQaModes.residual === 0 && reg.afterQaModes.visibleLegacyObjects === 0
    && reg.cityMode && reg.cityMode.active && reg.cityMode.residual === 0
    && reg.devPanelVisible === true && (reg.finalStatus || [])[0] === '[CANONICAL OK]'
    && (qa.consoleErrors || []).length === 0 && qa.startup.residual === 0;
  if (!regressionOk) errors.push('§14: 回帰確認に失敗');

  // ── production / protected ──
  // [Mission 33B] production は tools/build-production-html.js が生成する成果物。git の汚れではなく
  //   「最後に昇格したビルドと一致するか」で判定する（cutover 後も各 mission の validator を再実行できる）。
  const prodBuildRecord = rj(resolveProjectPath(path.join('data', 'reports', 'production-cutover-build.json')));
  const productionModified = (prodBuildRecord && prodBuildRecord.productionSha256)
    ? crypto.createHash('sha256').update(fs.readFileSync(resolveProjectPath(path.join('public', 'osaka_3d_buildings.html')))).digest('hex') !== prodBuildRecord.productionSha256
    : gitClean('public/osaka_3d_buildings.html') === false;
  const protectedModified = gitClean('public/osaka_3d_buildings.fullward-v3.html') === false;
  if (productionModified) errors.push('§0: production HTML が変更されている');
  if (protectedModified) errors.push('§0: protected HTML が変更されている');

  // 修正前後を同じ分類ルールで数える（before はルール調整前に取ったので現行ルールで分類し直す）
  const summarize = (scan) => {
    const hits = scan.hits.filter((h) => !/stale-ui-text-scan-/.test(h.file)).map((h) => ({ ...h, cls: classify(h.file, h.text) }));
    const byClass = {}; for (const h of hits) byClass[h.cls] = (byClass[h.cls] || 0) + 1;
    return { total: hits.length, byClass, devHtmlUi: hits.filter((h) => h.cls === 'dev-html-ui').length, devHtmlAny: hits.filter((h) => h.file === 'public/osaka_3d_buildings.ward-ux-v1.html').length };
  };
  const _unused = (scan) => ({ total: scan.total, byClass: scan.byClass, devHtmlUi: scan.hits.filter((h) => h.cls === 'dev-html-ui').length, devHtmlAny: scan.hits.filter((h) => h.file === 'public/osaka_3d_buildings.ward-ux-v1.html').length });
  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32R', RESULT,
    classification: errors.length ? 'FINAL_UI_CLEANUP_FAILED' : 'FINAL_UI_CLEANUP_SUCCESS',
    buildingV2Mutation, roadV3Mutation, projectionMutation, placementMutation,
    propertyCardVisibleAboveDevPanel, nearestStationUsesCanonicalStationData, nearestStationUsesWorldDistance,
    staleNankoMinamiSearchText, walkingTimeShown, regressionOk,
    productionModified, protectedModified,
    staleTextScan: { before: summarize(before), after: summarize(after), devHtmlUiBefore: devUiBefore },
    stations: cards.map((c) => ({ site: c.site, station: c.station, independent: c.expectedStation })),
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateFinalUiCleanup().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
