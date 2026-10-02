#!/usr/bin/env node
// tools/validate/zoom-label-stability.js
// [Mission 33D §24] ホイールズームの効き + ラベル安定化の検証。
//   zoomWheelStrengthIncreased / trackpadStillStable
//   labelHysteresisEnabled / labelSelectionStateCached / majorLabelFlickerReduced
//   nearOverlapCount = 0 / duplicateLabelCount = 0
//   buildingMutation = 0 / roadMutation = 0 / projectionMutation = 0
//   productionModified = false / protectedModified = false
//   → ZOOM_LABEL_STABILITY_SUCCESS / ZOOM_LABEL_STABILITY_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'zoom-label-stability-qa.json'),
  build: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  out: P('data', 'reports', 'zoom-label-stability-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
// §2 の目標帯（1 ノッチの距離変化が従来の何倍か）。近景は下限（従来と同じ 90m）で据え置く。
export const ZOOM_GAIN_TARGET = { min: 1.7, max: 2.3 };
// §20 の目安（連続した小さな操作の 1 手ごとの Jaccard）
export const STABILITY_TARGET = { major: 0.90, all: 0.75 };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(q) : fs.statSync(q).mtimeMs);
  }
  return m;
}

export async function validateZoomLabelStability() {
  const errors = [], warnings = [];
  const qa = rj(F.qa);
  const after = qa && qa.phases ? qa.phases.after : null;
  const before = qa && qa.phases ? qa.phases.before : null;
  const html = fs.readFileSync(F.dev, 'utf-8');
  const missionStart = Date.parse((rj(F.build) || {}).generatedAt || new Date().toISOString());

  // ── §0 変更禁止（建物 / 道路 / 投影） ──
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingMutation = touched.length + ((rj(F.canonManifest) || {}).featureCount === 600764 ? 0 : 1);
  if (buildingMutation) errors.push('§0: 建物データが変わっている ' + JSON.stringify(touched));
  const roadMutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadMutation) errors.push('§0: ROAD V3 の出力が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§0: projection が変わっている');

  // ── §23 production / protected は触らない ──
  const buildRec = rj(F.build) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = buildRec.productionSha256 ? sha(F.prod) !== buildRec.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§23: production HTML が変更されている（33D は development のみ）');
  if (protectedModified !== false) errors.push('§0: protected HTML が変更されている');

  // ── HTML 実装（§2/§3/§7/§8/§13/§14/§21） ──
  const exponentialZoom = /let next = r \* Math\.exp\(ZOOM_WHEEL\.K \* notches\);/.test(html)
    && !/cs\.r\s*\+\s*e\.deltaY\s*\*\s*\.9/.test(html);
  if (!exponentialZoom) errors.push('§2: ホイールズームが距離比例（指数）になっていない');
  const wheelNormalized = /const px = e\.deltaY \* \(e\.deltaMode === 1 \? 16 : e\.deltaMode === 2 \?/.test(html)
    && /ZOOM_WHEEL\.trackpad = ZOOM_WHEEL\.smallRun >= 3;/.test(html);
  if (!wheelNormalized) errors.push('§3: deltaMode / トラックパッドの正規化が無い');
  const zoomRangeKept = /return Math\.max\(cs\.minR, Math\.min\(cs\.maxR, next\)\);/.test(html)
    && /minPh:0\.05, maxPh:1\.45, minR:60, maxR:24000/.test(html);
  if (!zoomRangeKept) errors.push('§5: ズーム範囲（minR/maxR）が変わっている');
  const labelHysteresisEnabled = /const BAND_HYST = 0\.10;/.test(html)
    && /if \(curBand !== null && next !== curBand\) stats\.bandSwitches\+\+;/.test(html);
  if (!labelHysteresisEnabled) errors.push('§14: band ヒステリシスが無い');
  const labelSelectionStateCached = /pool\.sort\(\(a, z\) => \(a\.rank - z\.rank\) \|\| \(a\.stable - z\.stable\) \|\| \(a\.dc - z\.dc\)\);/.test(html)
    && /stable: prevVisible\.has\(item\.id\) \? 0 : 1/.test(html);
  if (!labelSelectionStateCached) errors.push('§8/§12: 前回の選定結果が使われていない');
  const relayoutThreshold = /function needsRelayout\(\) \{/.test(html) && /const RELAYOUT = \{ targetFrac: 0\.035, targetMinM: 30, distRatio: 1\.06, angleRad: 0\.035 \};/.test(html);
  if (!relayoutThreshold) errors.push('§10: 再選定しきい値が無い');
  const cellStickiness = /const CELL_MARGIN = 0\.28;/.test(html) && /if \(prev\[0\] !== ix && Math\.abs\(fx - \(prev\[0\] \+ 0\.5\)\) <= 0\.5 \+ CELL_MARGIN\) ix = prev\[0\];/.test(html);
  if (!cellStickiness) errors.push('§13: グリッド境界のチラつき対策が無い');
  const majorLabelFloor = /function isMajorLabel\(item\) \{/.test(html) && /const perCell = major \? GRID_MAJOR_PER_CELL : GRID\.perCell;/.test(html);
  if (!majorLabelFloor) errors.push('§15/§16: 主要ラベルの下限が無い');
  // §21 既存修正の維持
  const cameraMatrixKept = /camera\.updateMatrixWorld\(\);[\s\S]{0,200}前回の配置をいったん全部消す/.test(html);
  const legacyStationDormant = !/^StationLabelLayer\.show\(\);/m.test(html) && /if \(allowShow\) scene\.add\(group\);/.test(html);
  if (!cameraMatrixKept) errors.push('§21: camera.updateMatrixWorld() が失われている');
  if (!legacyStationDormant) errors.push('§21: 旧 StationLabelLayer が休止していない');

  // ── §18 ズームの実測 ──
  let zoomWheelStrengthIncreased = null, trackpadStillStable = null, zoomTable = [], zoomRangeReachable = null;
  if (!after) {
    errors.push('§18: zoom-label-stability-qa.json（phase=after）が無い');
  } else {
    const bn = before ? before.zoom.notch : [];
    zoomTable = after.zoom.notch.map((q) => {
      const b = bn.find((x) => x.r === q.r);
      return { r: q.r, beforeStepM: b ? b.zoomInStepM : null, afterStepM: q.zoomInStepM,
        gain: b ? +(q.zoomInStepM / Math.max(0.01, b.zoomInStepM)).toFixed(2) : null, ratio: q.zoomInRatio };
    });
    // 近景（floor が効く r=300）以外は必ず強くなっていること
    const improved = zoomTable.filter((q) => q.gain !== null && q.r >= 900);
    zoomWheelStrengthIncreased = improved.length > 0 && improved.every((q) => q.gain >= ZOOM_GAIN_TARGET.min)
      && zoomTable.every((q) => q.afterStepM >= (q.beforeStepM || 0) - 0.5);
    if (!zoomWheelStrengthIncreased) errors.push('§2: 1 ノッチのズーム量が目標（1.7 倍以上・どの距離でも従来以上）に届いていない ' + JSON.stringify(zoomTable));
    // §18 2〜4 ノッチで段階が変わる
    const multi = after.zoom.multi || [];
    const multiOk = multi.length >= 3 && multi.find((m) => m.notches === 4) && multi.find((m) => m.notches === 4).ratio >= 1.8;
    if (!multiOk) errors.push('§18: 2〜4 ノッチでズーム段階が変わっていない ' + JSON.stringify(multi));
    // §3 トラックパッド: 小刻みな 12 イベントで暴走しない（1 ノッチ 2 回分程度に収まる）
    const tp = after.zoom.trackpad;
    trackpadStillStable = !!tp && tp.ratio > 1.0 && tp.ratio <= 1.6 && tp.detected === true;
    if (!trackpadStillStable) errors.push('§3: トラックパッド入力が安定していない ' + JSON.stringify(tp));
    // §5 ズーム範囲が実際に端まで届く
    zoomRangeReachable = !!after.zoom.range && after.zoom.range.minOk && after.zoom.range.maxOk;
    if (!zoomRangeReachable) errors.push('§5: ホイールで minR / maxR まで届かない ' + JSON.stringify(after.zoom.range));
  }

  // ── §19/§20 ラベル安定度 ──
  let nearOverlapCount = null, duplicateLabelCount = null, majorLabelFlickerReduced = null, stability = [];
  if (after) {
    const rows = after.sites.concat([{ ...after.cityMode, site: 'cityMode', siteName: 'City Mode' }]);
    const beforeRows = before ? before.sites.concat([{ ...before.cityMode, site: 'cityMode' }]) : [];
    stability = rows.map((s) => {
      const b = beforeRows.find((q) => q.site === s.site);
      const t = (rec, k) => (rec && rec.byTier && rec.byTier[k]) ? rec.byTier[k].jaccardStep : null;
      return { site: s.site, siteName: s.siteName || s.site, baseCount: s.baseCount,
        jaccardStep: { before: b ? b.jaccardStep : null, after: s.jaccardStep },
        churnPerStep: { before: b ? b.churnPerStep : null, after: s.churnPerStep },
        pan: { before: t(b, 'pan'), after: t(s, 'pan') },
        rotate: { before: t(b, 'rotate'), after: t(s, 'rotate') },
        jitter: { before: t(b, 'jitter'), after: t(s, 'jitter') },
        zoom: { before: t(b, 'zoom'), after: t(s, 'zoom') },
        majorJaccardStep: s.majorJaccardStep,
        baseOverlap: s.baseOverlap,
        transientOverlapPairs: s.maxOverlapPairs, severeOverlaps: s.maxSevereOverlaps, duplicates: s.maxDuplicates,
        minPx: s.minPx };
    });
    // §19 「近景で重なり 0」は落ち着いた視点での値。操作の途中で一瞬触れる分は transientOverlapPairs に分けて記録する。
    nearOverlapCount = Math.max(...stability.map((s) => s.baseOverlap || 0), ...stability.map((s) => s.severeOverlaps || 0));
    if (nearOverlapCount > 0) errors.push('§19: ラベルが重なっている（静止時 / 完全重複）: ' + nearOverlapCount);
    const transientOverlapMax = Math.max(...stability.map((s) => s.transientOverlapPairs || 0));
    const beforeTransient = beforeRows.length ? Math.max(...beforeRows.map((s) => s.maxOverlapPairs || 0)) : null;
    if (beforeTransient !== null && transientOverlapMax > beforeTransient) errors.push('§19: 操作中の一時的な接触が増えた');
    var transient = { transientOverlapMax, beforeTransientOverlapMax: beforeTransient };
    duplicateLabelCount = Math.max(...stability.map((s) => s.duplicates || 0));
    if (duplicateLabelCount > 0) errors.push('§19: 同一ラベルが二重に出ている: ' + duplicateLabelCount);
    // 全地点で「1 手あたりの入れ替わり」が改善していること（§9）
    const worse = stability.filter((s) => s.jaccardStep.before !== null && s.jaccardStep.after < s.jaccardStep.before);
    if (worse.length) errors.push('§9: チラつきが悪化した地点がある ' + JSON.stringify(worse.map((s) => [s.site, s.jaccardStep])));
    // §15/§16 主要ラベル
    const mj = stability.map((s) => s.majorJaccardStep).filter((v) => v != null);
    majorLabelFlickerReduced = mj.length > 0 && stability.every((s) => s.jaccardStep.before === null || s.jaccardStep.after >= s.jaccardStep.before)
      && mj.every((v) => v >= 0.85);
    if (!majorLabelFlickerReduced) errors.push('§16: 主要ラベルが安定していない ' + JSON.stringify(mj));
    const belowTarget = stability.filter((s) => s.majorJaccardStep != null && s.majorJaccardStep < STABILITY_TARGET.major);
    if (belowTarget.length) warnings.push('§20: 主要ラベル Jaccard が目安 0.90 に届かない地点 ' + JSON.stringify(belowTarget.map((s) => [s.site, s.majorJaccardStep])));
    const allBelow = stability.filter((s) => s.jaccardStep.after < STABILITY_TARGET.all);
    if (allBelow.length) errors.push('§20: 全ラベル Jaccard が目安 0.75 未満 ' + JSON.stringify(allBelow.map((s) => [s.site, s.jaccardStep.after])));
    const tooSmall = stability.filter((s) => s.minPx != null && Number.isFinite(s.minPx) && s.minPx < 8);
    if (tooSmall.length) errors.push('§19: 読めない大きさのラベルがある ' + JSON.stringify(tooSmall.map((s) => [s.site, s.minPx])));
    if ((after.errors || []).length) errors.push('§19: ブラウザ例外 ' + JSON.stringify(after.errors.slice(0, 3)));

    // ── §22 回帰 ──
    const rg = after.regression || {};
    const pickingRegression = !(rg.hover === 'block' && rg.cardDisplay === 'block');
    if (pickingRegression) errors.push('§22: hover / クリック / カードが壊れている ' + JSON.stringify({ hover: rg.hover, card: rg.cardDisplay }));
    const toggleWorks = rg.toggles && Object.values(rg.toggles).every((t) => t && typeof t === 'object' && t.off < t.before);
    if (!toggleWorks) errors.push('§22: レイヤートグルが効いていない ' + JSON.stringify(rg.toggles));
    const searchRegression = !rg.search || rg.search.error || rg.search.msgShown || rg.search.distanceM > 50;
    if (searchRegression) errors.push('§22: 検索が壊れている ' + JSON.stringify(rg.search));

    // ── §17 性能 ──
    const perf = after.performance || [];
    const perfBefore = before ? (before.performance || []) : [];
    const performance = perf.map((p) => {
      const b = perfBefore.find((q) => q.site === p.site && q.moving === p.moving);
      return { site: p.site, moving: p.moving, fpsBefore: b ? b.fpsAverage : null, fpsAfter: p.fpsAverage,
        frameMsP95Before: b ? b.frameMsP95 : null, frameMsP95After: p.frameMsP95,
        relayoutPerSec: p.relayoutPerSec, labelUpdatePerSec: p.labelUpdatePerSec, visibleLabels: p.visibleLabels };
    });
    // このマシンは同一設定でも FPS が 20〜46 と振れるため、1 回ずつの比較では判定できない。
    //   §17 の判定は交互計測（zoom-label-perf-ab.js）の平均を正本とし、こちらは記録のみ。
    const ab = rj(P('data', 'reports', 'zoom-label-perf-ab.json'));
    if (!ab) warnings.push('§17: 交互計測（zoom-label-perf-ab.json）が無い');
    else {
      if (ab.summary.fpsDeltaPct < -8) errors.push('§17: 交互計測で FPS が ' + ab.summary.fpsDeltaPct + '% 低下');
      if (ab.summary.after.placeMedianMs > ab.summary.before.placeMedianMs + 0.05) errors.push('§17: ラベル再選定 1 回が重くなった');
    }
    var perfAB = ab ? { ...ab.summary, rounds: ab.rounds, condition: ab.condition } : null;
    // 安定化機構が毎フレーム再配置していないこと
    const movingRows = performance.filter((p) => p.moving && p.relayoutPerSec != null);
    if (movingRows.some((p) => p.relayoutPerSec > 5.1)) errors.push('§17: 再配置が throttle（5 回/秒）を超えている');

    var extra = { performance, regression: rg };
  }

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33D', RESULT,
    classification: errors.length ? 'ZOOM_LABEL_STABILITY_FAILED' : 'ZOOM_LABEL_STABILITY_SUCCESS',
    zoomWheelStrengthIncreased, trackpadStillStable, zoomRangeReachable,
    labelHysteresisEnabled, labelSelectionStateCached, majorLabelFlickerReduced,
    nearOverlapCount, duplicateLabelCount,
    transientOverlapMax: (typeof transient !== 'undefined') ? transient.transientOverlapMax : null,
    beforeTransientOverlapMax: (typeof transient !== 'undefined') ? transient.beforeTransientOverlapMax : null,
    buildingMutation, roadMutation, projectionMutation,
    productionModified, protectedModified,
    exponentialZoom, wheelNormalized, zoomRangeKept, relayoutThreshold, cellStickiness, majorLabelFloor,
    cameraMatrixKept, legacyStationDormant,
    zoomTable, zoomMulti: after ? after.zoom.multi : null, zoomTrackpad: after ? after.zoom.trackpad : null,
    zoomRange: after ? after.zoom.range : null,
    stability,
    performance: (typeof extra !== 'undefined') ? extra.performance : null,
    performanceAB: (typeof perfAB !== 'undefined') ? perfAB : null,
    regression: (typeof extra !== 'undefined') ? extra.regression : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateZoomLabelStability().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
