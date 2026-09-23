#!/usr/bin/env node
// tools/validate/v2-dev-promotion.js
// [Mission 32P §29/§32] Corrected Building V2 + OSM fallback V2 の development 標準昇格を検証する。
//   → V2_DEV_PROMOTION_SUCCESS / V2_DEV_PROMOTION_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  merged: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  pubRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  dataRoot: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2'),
  v1PublicNear: P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json'),
  v2OldPublicNear: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected', 'near', 'buildings', 'manifest.json'),
  overlaps: P('data', 'processed', 'osaka-city', 'v2-final', 'building-overlaps.json'),
  road: P('data', 'reports', 'v2-final-road-overlap.json'),
  water: P('data', 'reports', 'v2-final-water-overlap.json'),
  placement: P('data', 'reports', 'v2-placement-policy.json'),
  perf: P('data', 'reports', 'v2-runtime-performance.json'),
  o2: P('data', 'reports', 'osm-fallback-v2-rebuild.json'),
  hist: P('data', 'reports', 'historical-invalidated-by-v2.json'),
  out: P('data', 'reports', 'v2-dev-promotion-validation.json'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}
export const PERF_LIMITS = Object.freeze({ minFpsRatio: 0.8, maxFrameP95Ratio: 1.25, frameP95SlackMs: 2 });

export async function validateV2DevPromotion() {
  const errors = [], warnings = [];
  const html = fs.readFileSync(F.html, 'utf-8');
  const merged = rj(F.merged) || {};
  const pubNear = rj(path.join(F.pubRoot, 'near', 'buildings', 'manifest.json')) || {};
  const pubPlacement = rj(path.join(F.pubRoot, 'building-placement', 'manifest.json')) || {};
  const dataPlacement = rj(path.join(F.dataRoot, 'building-placement', 'manifest.json')) || {};
  const perf = rj(F.perf);
  const road = rj(F.road), water = rj(F.water), placement = rj(F.placement), o2 = rj(F.o2);
  if (!perf || !road || !water || !placement) {
    const out = { RESULT: 'FAIL', classification: 'V2_DEV_PROMOTION_FAILED', errors: ['必要なレポートが無い'] };
    await writeJson(F.out, out); return out;
  }

  // ── §1/§2 default と QA ボタン ──
  const staticDefault = (html.match(/let buildingsVersion = '([A-Z0-9]+)';/) || [])[1];
  const st = perf.defaultStartup || {};
  const devDefaultBuildingMode = staticDefault === 'V2N' && st.buildingsVersion === 'V2N' ? 'V2_NEW_OSM' : (staticDefault || 'unknown');
  const v1Default = staticDefault === 'V1' || st.buildingsVersion === 'V1';
  const v1StillAvailableForQa = /\['V1', 'BLDG V1'/.test(html) && /\['V2', 'V2 \+ OLD OSM'/.test(html) && /\['V2N', 'V2 \+ NEW OSM'/.test(html)
    && /BUILDINGS_VERSION_BASE = \{ V1: BASE, V2: BASE_V2_CORRECTED, V2N: BASE_V2_OSMV2 \}/.test(html)
    && fs.existsSync(F.v1PublicNear) && fs.existsSync(F.v2OldPublicNear);
  if (devDefaultBuildingMode !== 'V2_NEW_OSM') errors.push('§1: development の既定が V2 + NEW OSM でない: ' + staticDefault + ' / runtime ' + st.buildingsVersion);
  if (v1Default) errors.push('§1: V1 が既定のまま');
  if (!v1StillAvailableForQa) errors.push('§2: V1 / V2+OLD OSM の QA 切替が失われている');

  // ── 件数 ──
  const plateauV2Count = merged.plateauCount;
  const osmFallbackV2Count = merged.fallbackCount;
  const totalBuildingCount = merged.featureCount;
  if (plateauV2Count !== 574112) errors.push('§4: PLATEAU V2 が 574112 でない: ' + plateauV2Count);
  if (osmFallbackV2Count !== 26652) errors.push('OSM fallback V2 が 26652 でない: ' + osmFallbackV2Count);
  if (totalBuildingCount !== 600764) errors.push('total が 600764 でない: ' + totalBuildingCount);
  if (pubNear.featureCount !== totalBuildingCount || pubPlacement.canonicalBuildingCount !== totalBuildingCount || st.buildingCount !== totalBuildingCount) {
    errors.push('§17/§24: 公開物・runtime の建物数が total と一致しない ' + JSON.stringify({ near: pubNear.featureCount, placement: pubPlacement.canonicalBuildingCount, runtime: st.buildingCount }));
  }
  if (pubNear.simplificationToleranceM !== 0) errors.push('§18: near の simplification tolerance が 0 でない');

  // ── §3/§4/§13/§17 旧データを使っていない ──
  const fb = st.fetchByNamespace || {};
  const reg = perf.regression || {};
  const delta = reg.fetchDelta || {};
  const oldOsmFallbackUsed = !(fb.V1 === 0 && fb.V2 === 0 && fb.VISUAL === 0 && fb.V2N > 0 && delta.V1 === 0 && delta.V2 === 0 && delta.VISUAL === 0 && delta.V2N > 0)
    || !(o2 && o2.oldFallbackNotUsedInV2Runtime === true && o2.staleInPublic.deprecatedIdsFound === 0);
  if (oldOsmFallbackUsed) errors.push('§3: default runtime が V1 / 旧 OSM namespace を読んでいる ' + JSON.stringify({ startup: fb, wardAndCityDelta: delta }));
  for (const [k, v] of [['afterWard', reg.afterWard], ['afterCity', reg.afterCity]]) {
    if (!v || v.version !== 'V2N') errors.push(`§30: ${k} で建物版が V2N でない`);
  }

  // ── §7/§24 表示既定 ──
  const roadMode = st.roadMode;
  const rawGsiEdgeDefault = st.rawGsiEdge;
  if (roadMode !== 'ROAD_V3' || !/let roadVisualMode = 'ROAD_V3';/.test(html)) errors.push('§7: road の既定が ROAD_V3 でない');
  if (rawGsiEdgeDefault !== false || !/let gsiEdgeEnabled = false;/.test(html)) errors.push('§24: Raw GSI Edge の既定が OFF でない');
  const statusText = st.statusText || '';
  for (const needle of ['Buildings: V2 CORRECTED + OSM V2', 'Count: 600,764', 'Road: ROAD V3', 'Raw GSI Edge: OFF', 'Placement: V2']) {
    if (!statusText.includes(needle)) errors.push('§24: status に「' + needle + '」が無い');
  }
  // legacy residual: 版に依存しない既存の未タグ mesh なら警告（V1 と V2N で内訳が同じか）。版で変わるならエラー。
  const rb = perf.residualByVersion || {};
  const sig = (x) => JSON.stringify(((x && x.probe) || []).map((p) => [p.type, p.positions]).sort());
  if (!rb.V1 || !rb.V2N) errors.push('residual の版別記録が無い');
  else if (rb.V1.total !== rb.V2N.total || sig(rb.V1) !== sig(rb.V2N)) errors.push('residual が建物版で変わる: V1 ' + rb.V1.total + ' / V2N ' + rb.V2N.total);
  else if (st.residual !== 0) warnings.push(`legacy residual ${st.residual}（V1 でも同じ ${rb.V1.total} 件・同じ mesh。建物版に依存しない既存の未タグ mesh）`);
  if (JSON.stringify(st.groupScale) !== '[1,1,1]' || JSON.stringify(st.groupRotation) !== '[0,0,0]') errors.push('建物 group に scale / rotation がある');

  // ── §11-§14 placement / ward index ──
  const ov = rj(F.overlaps);
  const placementGeneratedFromV2 = pubPlacement.variant === 'v2-final' && dataPlacement.generatedAt === pubPlacement.generatedAt
    && pubPlacement.uses31e === false && pubPlacement.usesV1Geometry === false && pubPlacement.roadSource === 'ROAD_V3'
    && /buildings-v2-osmv2/.test(pubPlacement.buildingSet || '') && ov && pubPlacement.overlapGeneratedAt === ov.generatedAt
    && st.placementVariant === 'v2-final';
  if (!placementGeneratedFromV2) errors.push('§11: placement が V2 から生成されたことを確認できない');
  const pc = placement.policyCounts;
  if (pc.DISPLAY + pc.SUPPRESS + pc.REVIEW + pc.EXEMPT !== totalBuildingCount) errors.push('§13: placement の合計が total と一致しない');
  const roadSuppress = Object.entries(placement.byReason).filter(([k]) => k.startsWith('SUPPRESS') && /road/.test(k)).reduce((a, [, n]) => a + n, 0);
  if (roadSuppress) errors.push('§12: 道路との重なりだけで SUPPRESS している: ' + roadSuppress);
  const suppressNonConflict = Object.keys(placement.byReason).filter((k) => k.startsWith('SUPPRESS') && k !== 'SUPPRESS high-confidence-water-conflict');
  if (suppressNonConflict.length) errors.push('§12: 高 confidence 以外の SUPPRESS がある: ' + suppressNonConflict.join(','));
  const pubWi = fs.existsSync(path.join(F.pubRoot, 'building-ward-index.json')) ? fs.readFileSync(path.join(F.pubRoot, 'building-ward-index.json'), 'utf-8') : '';
  const dataWi = fs.existsSync(path.join(F.dataRoot, 'building-ward-index.json')) ? fs.readFileSync(path.join(F.dataRoot, 'building-ward-index.json'), 'utf-8') : '';
  const wardIndexGeneratedFromV2 = !!pubWi && pubWi === dataWi && placement.wardIndex.generatedFromV2 === true && placement.wardIndex.wards === 24
    && placement.wardIndex.totalBuildings > 600000 && new Date(JSON.parse(dataWi).generatedAt) >= new Date(dataPlacement.generatedAt);
  if (!wardIndexGeneratedFromV2) errors.push('§14: ward index が V2 から再生成されたことを確認できない');

  // ── §5/§6/§8/§9 overlap ──
  const v3 = road.citywide.ROAD_V3, hist = road.historical.mission32I_v1Buildings;
  if (!(v3.overlapM2 >= 0 && road.buildingSet.total === totalBuildingCount)) errors.push('§6: ROAD V3 KPI が V2 建物で計算されていない');
  for (const s of ['umeda', 'honmachi', 'namba', 'tennoji', 'sumiyoshi', 'higashiyodogawa']) if (!road.sites[s]) errors.push('§5: ' + s + ' の再測定が無い');
  if (hist && hist.overlapM2 && v3.overlapM2 >= hist.overlapM2.v3) warnings.push('§6: V3 overlap が V1 時代より減っていない');
  const wc = water.citywide;
  const clsSum = Object.values(wc.byClass).reduce((a, v) => a + v.buildings, 0);
  if (clsSum !== wc.buildingsTouching) errors.push('§9: 水域重なりの分類漏れ ' + clsSum + ' / ' + wc.buildingsTouching);
  for (const r of ['大川', '淀川', '道頓堀川', '木津川', '安治川']) if (!water.focusRivers[r]) errors.push('§8: ' + r + ' の集計が無い');

  // ── §15/§16 picking / property ──
  const picks = perf.picking || [];
  const pickOk = picks.length >= 5 && picks.every((p) => p.pickedExpected && p.cardVisible && p.pcId && p.hover && p.hover.tip === 'block' && p.footprintsAtCentroid === 1);
  if (!pickOk) errors.push('§16: picking / hover / property card の確認に失敗 ' + JSON.stringify(picks.map((p) => [p.id, p.pickedExpected, p.cardVisible, p.hover && p.hover.tip, p.footprintsAtCentroid])));
  if (!(reg.searchSpot && reg.searchSpot.name)) errors.push('§15: スポット検索が動かない');

  // ── §19/§20 performance ──
  const runs = (perf.benchmark || {}).runs || {};
  const perfCmp = {};
  for (const site of ['umeda', 'sumiyoshi']) {
    const a = runs[site + '-V1'], b = runs[site + '-V2N'];
    if (!a || !b) { errors.push('§19: ' + site + ' の実測が無い'); continue; }
    perfCmp[site] = { fpsV1: a.fpsAverage, fpsV2N: b.fpsAverage, p95V1: a.frameMsP95, p95V2N: b.frameMsP95, trisV1: a.trianglesAvg, trisV2N: b.trianglesAvg, callsV1: a.drawCallsAvg, callsV2N: b.drawCallsAvg };
    if (b.seconds < 25) errors.push(`§19: ${site} の計測が 30 秒に満たない (${b.seconds})`);
    if (b.fpsAverage < a.fpsAverage * PERF_LIMITS.minFpsRatio) errors.push(`§20: ${site} で FPS が大きく悪化 ${a.fpsAverage} → ${b.fpsAverage}`);
    if (b.frameMsP95 > a.frameMsP95 * PERF_LIMITS.maxFrameP95Ratio + PERF_LIMITS.frameP95SlackMs) errors.push(`§20: ${site} で frame p95 が大きく悪化 ${a.frameMsP95} → ${b.frameMsP95}`);
  }
  if (!/Direct3D|D3D|OpenGL|Vulkan|Metal/i.test((perf.environment || {}).gpu || '') || /SwiftShader/i.test((perf.environment || {}).gpu || '')) warnings.push('§19: 実 GPU で計測されていない可能性: ' + (perf.environment || {}).gpu);
  if ((perf.consoleErrors || []).length) warnings.push('ブラウザで例外が出た: ' + perf.consoleErrors.length);

  // ── §26 historical ──
  const hi = rj(F.hist);
  if (!hi || hi.invalidated.length < 3) errors.push('§26: historical-invalidated-by-v2 の記録が無い');
  for (const e of (hi ? hi.invalidated : [])) {
    const j = rj(P(e.json));
    if (!j || !j.historicalStatus || j.historicalStatus.status !== 'historical-invalidated-by-v2') errors.push('§26: ' + e.json + ' に historicalStatus が無い');
    if (!fs.existsSync(P(e.md))) errors.push('§26: ' + e.md + ' が消えている');
  }

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

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32P', RESULT,
    classification: errors.length ? 'V2_DEV_PROMOTION_FAILED' : 'V2_DEV_PROMOTION_SUCCESS',
    devDefaultBuildingMode, v1Default, v1StillAvailableForQa,
    plateauV2Count, osmFallbackV2Count, totalBuildingCount,
    oldOsmFallbackUsed, roadMode, rawGsiEdgeDefault,
    placementGeneratedFromV2, wardIndexGeneratedFromV2,
    productionModified, protectedModified,
    placementCounts: pc, performance: perfCmp, perfLimits: PERF_LIMITS,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateV2DevPromotion().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
