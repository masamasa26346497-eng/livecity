#!/usr/bin/env node
// tools/validate/building-coverage-click-ux.js
// [Mission 34C §32] 建物 coverage 改善と click intent 改善の検証。
//   brilliaTowerDojimaInvestigated = true / validMissingBuildingsRecovered = true
//   fabricatedBuildingCount = 0 / duplicateIncrease = 0
//   buildingPositionMutation = 0 / projectionMutation = 0
//   dragOpensCard = false / rotateOpensCard = false / wheelOpensCard = false
//   explicitClickOpensCard = true / productionModified = false / protectedModified = false
//   → BUILDING_COVERAGE_CLICK_UX_SUCCESS / BUILDING_COVERAGE_CLICK_UX_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { stripComments } from './max-plateau-lod.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  fixture: P('data', 'reports', 'building-fixture-trace.json'),
  citywide: P('data', 'reports', 'building-coverage-citywide.json'),
  v3build: P('data', 'reports', 'osm-fallback-v3-build.json'),
  clickQa: P('data', 'reports', 'click-intent-qa.json'),
  perf: P('data', 'reports', 'coverage-click-perf.json'),
  plateauMissing: P('data', 'reports', 'plateau-missing-audit.json'),
  landmarkCov: P('data', 'reports', 'landmark-building-coverage.json'),
  missing: P('data', 'processed', 'osaka-city', 'osm-fallback-v3', 'missing-candidates.json'),
  v2Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  v3Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv3'),
  recoveredDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v3-recovered'),
  v2Public: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  v3Public: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv3'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'building-coverage-click-ux-validation.json'),
};
// §5 現行の表示総数。V3 はこれを土台に「足すだけ」で、1 件も変えない。
export const V2N_FEATURE_COUNT = 600764;
// §18/§19 click intent のしきい値（HTML と一致していることを確かめる）
export const CLICK_SPEC = { movePx: [4, 8], touchMovePx: [8, 16], wheelBlockMs: [150, 250], maxMs: [400, 1200] };
// §27 受け入れ
export const CLICK_ACCEPT = { singleClickSuccessPct: 95, falseOpen: 0 };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const inR = (v, [lo, hi]) => typeof v === 'number' && v >= lo && v <= hi;

/** §1 V2N の建物が V3 でも 1 件残らず同じ座標のままか（サンプル照合）。 */
export function compareV2ToV3(sampleTiles = 40) {
  const files = fs.readdirSync(F.v2Dir).filter(isTile);
  const step = Math.max(1, Math.floor(files.length / sampleTiles));
  const res = { tilesCompared: 0, featuresCompared: 0, missingInV3: 0, geometryChanged: 0, sample: [] };
  for (let i = 0; i < files.length; i += step) {
    const f = files[i];
    const a = rj(path.join(F.v2Dir, f)), b = rj(path.join(F.v3Dir, f));
    if (!a) continue;
    res.tilesCompared++;
    if (!b) { res.missingInV3 += (a.features || []).length; continue; }
    const byId = new Map((b.features || []).map((ft) => [ft.canonicalId, ft]));
    for (const ft of (a.features || [])) {
      res.featuresCompared++;
      const o = byId.get(ft.canonicalId);
      if (!o) { res.missingInV3++; if (res.sample.length < 5) res.sample.push({ id: ft.canonicalId, issue: 'V3 に無い' }); continue; }
      if (JSON.stringify(o.coordinates) !== JSON.stringify(ft.coordinates)) {
        res.geometryChanged++;
        if (res.sample.length < 5) res.sample.push({ id: ft.canonicalId, issue: 'geometry が違う' });
      }
    }
  }
  return res;
}

/** §6/§10 回収分が本当に OSM 由来か（捏造が無いか）。 */
export function checkRecoveredProvenance() {
  const miss = rj(F.missing);
  const byId = new Map(((miss && miss.candidates) || []).map((c) => [c.canonicalId, c]));
  const res = { checked: 0, noSourceId: 0, sourceIdMismatch: 0, ringMismatch: 0, notOsmBuilding: 0,
    fromPoint: 0, ids: new Set(), sample: [] };
  for (const f of fs.readdirSync(F.recoveredDir)) {
    if (!isTile(f)) continue;
    const doc = rj(path.join(F.recoveredDir, f));
    for (const ft of (doc.features || [])) {
      res.checked++;
      res.ids.add(ft.canonicalId);
      const src = ft.source || {};
      if (src.geometrySource !== 'osm-building') { res.notOsmBuilding++; continue; }
      const ids = src.sourceIds || [];
      const m = /^cg_bldg_osm_(\d+)$/.exec(ft.canonicalId);
      if (!ids.length) { res.noSourceId++; continue; }
      if (!m || ids[0] !== 'way/' + m[1]) { res.sourceIdMismatch++; continue; }
      // §6 point からの押し出しではないこと（頂点 3 未満は作れない）
      const ring = ft.coordinates && ft.coordinates[0];
      if (!ring || ring.length < 3) { res.fromPoint++; continue; }
      // 監査時に OSM から読んだ footprint と一致するか
      const c = byId.get(ft.canonicalId);
      if (c && JSON.stringify(c.ring.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100])) !== JSON.stringify(ring)) {
        res.ringMismatch++;
        if (res.sample.length < 5) res.sample.push({ id: ft.canonicalId, issue: 'OSM footprint と違う' });
      }
    }
  }
  return res;
}

export async function validateBuildingCoverageClickUx() {
  const errors = [], warnings = [];
  const raw = fs.readFileSync(F.dev, 'utf-8');
  const html = stripComments(raw);
  const fixture = rj(F.fixture), citywide = rj(F.citywide), v3 = rj(F.v3build), click = rj(F.clickQa), perf = rj(F.perf);

  // ── §2 Brillia Tower Dojima の調査 ───────────────────────────────────────
  let brilliaTowerDojimaInvestigated = false, brillia = null;
  if (!fixture) errors.push('§2: building-fixture-trace.json が無い');
  else {
    const t = (fixture.traces || []).find((x) => x.fixture === 'brillia-tower-dojima' && !x.canonicalMatch);
    brillia = t ? {
      osmWayId: t.osm.wayId, levels: t.osm.tags['building:levels'], building: t.osm.tags.building,
      areaM2: t.osm.areaM2, centroid: t.osm.centroid, wardId: t.ward.wardId,
      canonicalMatch: t.canonicalMatch, canonicalNearby: t.canonicalNearby,
      inDerived: t.derived, wasFallbackCandidate: t.osmFallbackCandidate,
    } : null;
    // 「raw / canonical / derived / placement / ward index をすべて辿った」ことを求める
    const tracedAll = (fixture.traces || []).length > 0
      && (fixture.traces || []).every((x) => x.derived && 'near' in x.derived && 'mid' in x.derived && 'far' in x.derived);
    brilliaTowerDojimaInvestigated = !!(brillia && tracedAll);
    if (!brilliaTowerDojimaInvestigated) errors.push('§2: Brillia Tower Dojima の追跡結果が揃っていない');
    // 回収されたか
    const rec = rj(F.missing);
    const found = rec && (rec.candidates || []).some((c) => c.wayId === (brillia && brillia.osmWayId));
    if (brillia && !found) errors.push('§10: Brillia Tower Dojima が回収候補に入っていない');
    if (brillia) brillia.recovered = !!found;
  }

  // ── §4/§8/§12 市内全域の監査と回収 ──────────────────────────────────────
  let validMissingBuildingsRecovered = false, coverage = null;
  if (!citywide) errors.push('§4: building-coverage-citywide.json が無い');
  else if (!v3 || !v3.canonical) errors.push('§10: osm-fallback-v3-build.json が無い（回収を実行していない）');
  else {
    coverage = {
      osmInCity: citywide.osmScan.inCity,
      canonicalBefore: citywide.canonical.total,
      classified: citywide.counts,
      recovered: v3.canonical.recovered,
      selfDuplicateDropped: v3.canonical.selfDuplicateDropped,
      totalAfter: v3.canonical.mergedFeatureCount,
      byWard: v3.canonical.byWard,
    };
    if (citywide.canonical.total !== V2N_FEATURE_COUNT) errors.push('§5: 監査時の canonical 総数が 600,764 でない: ' + citywide.canonical.total);
    if (v3.canonical.baseFeatureCount !== V2N_FEATURE_COUNT) errors.push('§5: V3 の土台が V2N（600,764）でない: ' + v3.canonical.baseFeatureCount);
    if (v3.canonical.mergedFeatureCount !== v3.canonical.baseFeatureCount + v3.canonical.recovered) {
      errors.push('§12: V3 の総数が「V2N + 回収分」になっていない');
    }
    if (!(v3.canonical.recovered > 0)) errors.push('§10: 回収した建物が 0 件');
    // 24 区すべてで監査している（一部の区だけ直していない）
    const wards = Object.keys(v3.canonical.byWard || {});
    if (wards.length < 24) warnings.push('§4: 回収が ' + wards.length + ' 区にとどまっている');
    validMissingBuildingsRecovered = v3.canonical.recovered > 0 && wards.length >= 20
      && v3.canonical.mergedFeatureCount === v3.canonical.baseFeatureCount + v3.canonical.recovered;
  }

  // ── §7 raw PLATEAU との差 ───────────────────────────────────────────────
  const pm = rj(F.plateauMissing);
  let plateauMissing = null;
  if (!pm) warnings.push('§7: plateau-missing-audit.json が無い');
  else {
    const k = pm.counts;
    plateauMissing = { rawUniqueIds: k.rawUniqueIds, duplicatedAcrossCopies: k.duplicatedAcrossCopies,
      inCanonical: k.inCanonical, notInCanonical: k.notInCanonical, outsideCity: k.outsideCity,
      reEditionOfExisting: k.reEditionOfExisting, insideCityMissing: k.insideCityMissing, byWard: pm.byWardMissing };
    if (k.inCanonical !== pm.canonicalPlateauIds) errors.push('§7: canonical の PLATEAU が raw の中に全件見つからない');
    if (k.noPosition + k.outsideCity + (k.reEditionOfExisting || 0) + k.insideCityMissing !== k.notInCanonical) {
      errors.push('§7: raw との差の内訳が合わない');
    }
    if (k.insideCityMissing > 0) warnings.push('§7: canonical に入っていない市内 PLATEAU 建物が ' + k.insideCityMissing + ' 棟ある（34C では未取り込み）');
  }

  // ── §14 landmark に建物表現があるか ────────────────────────────────────
  const lc = rj(F.landmarkCov);
  let landmarkCoverage = null;
  if (!lc) warnings.push('§14: landmark-building-coverage.json が無い');
  else {
    landmarkCoverage = { landmarks: lc.landmarks, counts: lc.counts, unresolved: lc.unresolved.length };
    if (lc.unresolved.length) warnings.push('§14: 建物表現が無い landmark ' + lc.unresolved.length + ' 件');
    // §1/§6 registry の point から建物を作っていないこと
    const src = fs.readFileSync(P('tools', 'audit', 'landmark-building-coverage.js'), 'utf-8');
    if (/toFallbackRecord|recoveredFeature|extrude/i.test(src)) errors.push('§14: landmark registry から建物を作っている');
  }

  // ── §1/§6 捏造していない ────────────────────────────────────────────────
  let prov = null, fabricatedBuildingCount = null;
  if (fs.existsSync(F.recoveredDir)) {
    prov = checkRecoveredProvenance();
    fabricatedBuildingCount = prov.notOsmBuilding + prov.noSourceId + prov.sourceIdMismatch + prov.ringMismatch + prov.fromPoint;
    if (fabricatedBuildingCount > 0) errors.push('§6: OSM footprint に由来しない建物がある ' + JSON.stringify({
      notOsmBuilding: prov.notOsmBuilding, noSourceId: prov.noSourceId, sourceIdMismatch: prov.sourceIdMismatch,
      ringMismatch: prov.ringMismatch, fromPoint: prov.fromPoint }));
    prov.ids = prov.ids.size;
  } else { errors.push('§10: 回収分の canonical が無い'); }
  // §6 POI / facility / address point から建物を作っていない
  const builder = fs.existsSync(P('tools', 'build-osm-fallback-v3.js')) ? stripComments(fs.readFileSync(P('tools', 'build-osm-fallback-v3.js'), 'utf-8')) : '';
  if (/facilit|amenity|poi|address|extrudePoint/i.test(builder)) errors.push('§6: POI / 施設 / 住所点から建物を作っている疑い');

  // ── §9 二重建物を増やしていない ─────────────────────────────────────────
  let duplicateIncrease = null, dupDetail = null;
  if (v3 && v3.canonical && citywide) {
    const cands = rj(F.missing);
    const badCls = ((cands && cands.candidates) || []).filter((c) => c.cls !== 'VALID_FALLBACK' && c.cls !== 'AMBIGUOUS').length;
    // 回収 id が V2N に既にあってはいけない
    let collision = 0;
    const v2Ids = new Set();
    const files = fs.readdirSync(F.v2Dir).filter(isTile);
    for (const f of files) for (const ft of ((rj(path.join(F.v2Dir, f)) || {}).features || [])) v2Ids.add(ft.canonicalId);
    for (const f of fs.readdirSync(F.recoveredDir)) {
      if (!isTile(f)) continue;
      for (const ft of ((rj(path.join(F.recoveredDir, f)) || {}).features || [])) if (v2Ids.has(ft.canonicalId)) collision++;
    }
    dupDetail = { retainedClassOnly: badCls === 0, badClassCount: badCls, idCollisionWithV2N: collision,
      selfDuplicateDropped: v3.canonical.selfDuplicateDropped, selfDuplicatePairs: (v3.canonical.selfDuplicatePairs || []).length };
    duplicateIncrease = (badCls > 0 ? badCls : 0) + collision;
    if (duplicateIncrease > 0) errors.push('§9: 二重建物が増えている ' + JSON.stringify(dupDetail));
  }

  // ── §1 建物位置 / 投影は変えない ────────────────────────────────────────
  const cmp = fs.existsSync(F.v3Dir) ? compareV2ToV3() : null;
  const v2Manifest = rj(path.join(F.v2Dir, 'manifest.json')) || {};
  const v2CountOk = v2Manifest.featureCount === V2N_FEATURE_COUNT;
  if (!v2CountOk) errors.push('§1: V2N の建物数が変わっている: ' + v2Manifest.featureCount);
  const v2PublicUntouched = fs.existsSync(path.join(F.v2Public, 'manifest.json'));
  const buildingPositionMutation = (!v2CountOk || !cmp || cmp.geometryChanged > 0 || cmp.missingInV3 > 0) ? 1 : 0;
  if (buildingPositionMutation) errors.push('§1: V2N の建物が V3 で変わっている ' + JSON.stringify(cmp));
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§1: projection が変わっている');
  if (/latLonToJPRect\s*\(/.test(html)) errors.push('§1: Zone VII 変換が復活している');

  // ── §17-§22 click intent（コード）─────────────────────────────────────
  const clickCode = {
    hasIntent: /const CLICK_INTENT = \{/.test(html),
    // 旧ガード（常に false で効いていなかった）を残していない
    oldGuardRemoved: !/window\.addEventListener\('click',e=>\{\s*if\(cs\.drag\) return;/.test(html.replace(/\n\s*\/\/[^\n]*/g, '')),
    gateInClick: /if \(!clickIntentAllows\(\)\) return;/.test(html),
    downHook: /clickIntentDown\(e\.clientX, e\.clientY, 'mouse', e\.button\)/.test(html),
    upHook: /clickIntentUp\(\);/.test(html),
    moveHook: /clickIntentMove\(e\.clientX, e\.clientY\)/.test(html),
    wheelHook: /CLICK_INTENT\.lastWheelT = \(typeof performance/.test(html),
    // §20 カメラが動いたかは値で見る（camUpd が呼ばれたかでは見ない）
    cameraByState: /function clickIntentCameraMoved\(\)/.test(html) && /CLICK_INTENT\.camAt = \{ x: cs\.tgt\.x/.test(html),
    touchStart: /clickIntentDown\(e\.touches\[0\]\.clientX/.test(html),
    touchEnd: /addEventListener\('touchend',\(\)=>\{ clickIntentUp\(\); \}/.test(html),
    pinch: /CLICK_INTENT\.forceGesture = true/.test(html),
    escapeCloses: /if \(e\.key !== 'Escape'\) return;/.test(html),
    debugHook: /window\.__CLICK_INTENT_DEBUG__/.test(html),
  };
  for (const [k, v] of Object.entries(clickCode)) if (!v) errors.push('§17-§26: click intent の実装が足りない: ' + k);
  const thr = {
    movePx: Number((html.match(/MOVE_PX: (\d+(?:\.\d+)?),/) || [])[1]),
    touchMovePx: Number((html.match(/TOUCH_MOVE_PX: (\d+(?:\.\d+)?),/) || [])[1]),
    maxMs: Number((html.match(/MAX_MS: (\d+),/) || [])[1]),
    wheelBlockMs: Number((html.match(/WHEEL_BLOCK_MS: (\d+),/) || [])[1]),
  };
  if (!inR(thr.movePx, CLICK_SPEC.movePx)) errors.push('§19: ドラッグ判定のしきい値が範囲外: ' + thr.movePx);
  if (!inR(thr.touchMovePx, CLICK_SPEC.touchMovePx)) errors.push('§26: touch のしきい値が範囲外: ' + thr.touchMovePx);
  if (!inR(thr.wheelBlockMs, CLICK_SPEC.wheelBlockMs)) errors.push('§21: ホイール抑制時間が範囲外: ' + thr.wheelBlockMs);
  if (!inR(thr.maxMs, CLICK_SPEC.maxMs)) warnings.push('§18: クリックとみなす最大時間が想定外: ' + thr.maxMs);

  // ── §27 click intent（実測）───────────────────────────────────────────
  let dragOpensCard = null, rotateOpensCard = null, wheelOpensCard = null, explicitClickOpensCard = null, clickTotals = null;
  if (!click) errors.push('§27: click-intent-qa.json が無い（実ブラウザ計測が未実行）');
  else {
    clickTotals = click.totals;
    dragOpensCard = click.totals.panFalseOpen > 0;
    rotateOpensCard = click.totals.rotateFalseOpen > 0;
    wheelOpensCard = click.totals.wheelFalseOpen > 0;
    explicitClickOpensCard = click.totals.singleClickSuccessPct >= CLICK_ACCEPT.singleClickSuccessPct;
    if (dragOpensCard) errors.push('§22: pan で card が開く ' + click.totals.panFalseOpen);
    if (rotateOpensCard) errors.push('§22: rotate で card が開く ' + click.totals.rotateFalseOpen);
    if (wheelOpensCard) errors.push('§22: wheel zoom で card が開く ' + click.totals.wheelFalseOpen);
    if (!explicitClickOpensCard) errors.push('§27: single click の成功率が ' + click.totals.singleClickSuccessPct + '%（目標 ' + CLICK_ACCEPT.singleClickSuccessPct + '%）');
    // gesture が本当に camera を動かしていたか（計測が空振りしていないことの確認）
    const moved = click.totals.panMoved + click.totals.rotateMoved + click.totals.wheelMoved;
    const want = (click.sites || []).length * click.reps * 3;
    if (moved < want * 0.9) warnings.push('§27: gesture で camera が動いた回数が少ない ' + moved + '/' + want);
    if (!click.totals.persistenceOk) errors.push('§24: camera 操作で card が閉じる / 別建物へ切り替わる');
  }

  // ── §15 COVERAGE QA は dev だけ ─────────────────────────────────────────
  const coverageQaAvailable = /window\.__COVERAGE_QA__/.test(html) && /coverageQaBtn\.id = 'coverage-qa-toggle';/.test(html)
    && /const CoverageQaLayer = \(function \(\) \{/.test(html);
  if (!coverageQaAvailable) warnings.push('§15: COVERAGE QA が無い');
  // §11 V3 namespace が runtime に入っている
  const v3Wired = /V3: BASE_V3_OSMV3/.test(html) && /\['V3', 'V3 \+ RECOVERED'/.test(html);
  if (!v3Wired) errors.push('§11: runtime に V3 namespace が入っていない');
  // §11 既存 V2N はそのまま残っている
  const v2nKept = /V2N: BASE_V2_OSMV2/.test(html) && fs.existsSync(path.join(F.v2Public, 'manifest.json'));
  if (!v2nKept) errors.push('§11: derived-v2-osmv2 を壊している');

  // ── production / protected ──────────────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('production HTML が変更されている（34C は development のみ）');
  if (protectedModified !== false) errors.push('protected HTML が変更されている');
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  if (/__COVERAGE_QA__|__CLICK_INTENT_DEBUG__/.test(prodHtml)) errors.push('§15: production に QA 用の仕組みが入っている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '34C', RESULT,
    classification: errors.length ? 'BUILDING_COVERAGE_CLICK_UX_FAILED' : 'BUILDING_COVERAGE_CLICK_UX_SUCCESS',
    brilliaTowerDojimaInvestigated, validMissingBuildingsRecovered,
    fabricatedBuildingCount, duplicateIncrease,
    buildingPositionMutation, projectionMutation,
    dragOpensCard, rotateOpensCard, wheelOpensCard, explicitClickOpensCard,
    productionModified, protectedModified,
    brillia, coverage, provenance: prov, duplicates: dupDetail,
    plateauMissing, landmarkCoverage,
    // §16 「実データがあるのに出ていない」と分かっていて、まだ解決していないもの
    unresolvedKnownBuildings: {
      plateauInCityNotAdopted: plateauMissing ? plateauMissing.insideCityMissing : null,
      osmDuplicateClassNotAdded: citywide ? (citywide.counts.LIKELY_DUPLICATE) : null,
      landmarksWithoutBuilding: landmarkCoverage ? landmarkCoverage.unresolved : null,
      note: 'いずれも 34C では取り込んでいない。PLATEAU 側は年度違い・仕様差の切り分けが必要で、重複判定 LIKELY は §9 の方針で除外している。',
    },
    v2ToV3: cmp, v2PublicUntouched, v3Wired, v2nKept, coverageQaAvailable,
    clickIntent: { code: clickCode, thresholds: thr, totals: clickTotals,
      sites: click ? (click.sites || []).map((s) => ({ site: s.site, mode: s.interactionMode,
        clickSuccessPct: s.singleClick.successPct, panFalseOpen: s.pan.falseOpen,
        rotateFalseOpen: s.rotate.falseOpen, wheelFalseOpen: s.wheelZoom.falseOpen,
        persistence: s.persistence })) : null },
    performance: perf || null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateBuildingCoverageClickUx().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
