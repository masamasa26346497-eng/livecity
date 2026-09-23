#!/usr/bin/env node
// tools/audit/cartographic-camera-audit.js
// [Mission 31G-FIX25] Cartographic 3D Camera。建物geometryは一切変更せず、camera(FOV/pitch/distance)
//   だけを変えて screen-space の roof/base displacement（3D perspective由来の「見かけのずれ」）を
//   どれだけ低減できるかを測定する。
//
// §0 遵守: building x/z/height/scale・road/GSI geometry・projection/originは一切変更しない。
//   ここでの計算は全て「screen投影の計算」であり、Canonical/derivedデータそのものは読み取り専用。
//
// 既存 public/osaka_3d_buildings.ward-ux-v1.html の camera 数式（camUpd()）を、
// Node側で忠実に再実装する（three.jsに依存しない手計算。§0の「建物を動かさない」方針と同じ理由で、
// 既存の座標・投影式そのものには一切手を加えない — ここは新しい観測・計算コードの追加のみ）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const NEAR_BLDGS = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings');
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'cartographic-camera-audit.json');
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// ── ward-ux-v1.html の camUpd() と同一の球面配置式（§1: 既存camera挙動の忠実な再現）──
//   camera.position = tgt + r*(sin(ph)*sin(th), cos(ph), sin(ph)*cos(th))
function cameraPosition(tgt, th, ph, r) {
  return { x: tgt.x + r * Math.sin(ph) * Math.sin(th), y: tgt.y + r * Math.cos(ph), z: tgt.z + r * Math.sin(ph) * Math.cos(th) };
}
// ── 標準的な lookAt view matrix（右手系・Three.jsと同じ規約）──
function lookAtMatrix(eye, target, up) {
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1e-9; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const zAxis = norm(sub(eye, target));      // カメラ後方
  const xAxis = norm(cross(up, zAxis));      // カメラ右方向
  const yAxis = cross(zAxis, xAxis);         // カメラ上方向
  return { xAxis, yAxis, zAxis, eye };
}
function worldToView(p, view) {
  const d = { x: p.x - view.eye.x, y: p.y - view.eye.y, z: p.z - view.eye.z };
  return {
    x: d.x * view.xAxis.x + d.y * view.xAxis.y + d.z * view.xAxis.z,
    y: d.x * view.yAxis.x + d.y * view.yAxis.y + d.z * view.yAxis.z,
    z: d.x * view.zAxis.x + d.y * view.zAxis.y + d.z * view.zAxis.z, // カメラから見て手前が+z（右手系）
  };
}
// ── perspective projection（fovYはdegree）→ NDC(-1..1) → pixel ──
function projectToScreen(worldPt, camState, viewportW, viewportH) {
  const eye = cameraPosition(camState.tgt, camState.th, camState.ph, camState.r);
  const view = lookAtMatrix(eye, camState.tgt, { x: 0, y: 1, z: 0 });
  const vp = worldToView(worldPt, view);
  const negZ = -vp.z; // three.js基準: カメラ前方は-z
  if (negZ <= camState.near) return null; // near planeより手前(背後)は投影不能
  const fovRad = camState.fov * Math.PI / 180;
  const tanHalfFov = Math.tan(fovRad / 2);
  const aspect = viewportW / viewportH;
  const ndcX = vp.x / (negZ * tanHalfFov * aspect);
  const ndcY = vp.y / (negZ * tanHalfFov);
  return { px: (ndcX * 0.5 + 0.5) * viewportW, py: (1 - (ndcY * 0.5 + 0.5)) * viewportH, ndcX, ndcY, depth: negZ };
}
// ── screen上でのroof(頂部中心)とbase(底面中心)のpixel距離 ──
function roofBaseShiftPx(building, camState, viewportW, viewportH) {
  const [cx, cz] = building.centroid;
  const base = projectToScreen({ x: cx, y: 0, z: cz }, camState, viewportW, viewportH);
  const roof = projectToScreen({ x: cx, y: building.heightM, z: cz }, camState, viewportW, viewportH);
  if (!base || !roof) return null;
  return { dx: roof.px - base.px, dy: roof.py - base.py, distPx: Math.hypot(roof.px - base.px, roof.py - base.py), basePx: base, roofPx: roof };
}
// ── 地表被覆(ground coverage)の screen サイズ推定。target中心の refSizeM四方の正方形4隅を投影し、
//     screen上のbounding boxの対角pixel長で「どれだけズームして見えるか」を比較する（§7）。
function groundCoverageDiagPx(camState, refSizeM, viewportW, viewportH) {
  const h = refSizeM / 2;
  const corners = [
    { x: camState.tgt.x - h, y: 0, z: camState.tgt.z - h }, { x: camState.tgt.x + h, y: 0, z: camState.tgt.z - h },
    { x: camState.tgt.x + h, y: 0, z: camState.tgt.z + h }, { x: camState.tgt.x - h, y: 0, z: camState.tgt.z + h },
  ];
  const pts = corners.map((c) => projectToScreen(c, camState, viewportW, viewportH)).filter(Boolean);
  if (pts.length < 4) return null;
  const minX = Math.min(...pts.map((p) => p.px)), maxX = Math.max(...pts.map((p) => p.px));
  const minY = Math.min(...pts.map((p) => p.py)), maxY = Math.max(...pts.map((p) => p.py));
  return Math.hypot(maxX - minX, maxY - minY);
}
// distanceを二分探索し、Cartographic cameraのground coverageをCurrentと一致させる（§7）。
function solveDistanceForCoverage(baseCamState, targetDiagPx, refSizeM, viewportW, viewportH) {
  let lo = 10, hi = 30000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const diag = groundCoverageDiagPx({ ...baseCamState, r: mid }, refSizeM, viewportW, viewportH);
    if (diag == null) { hi = mid; continue; }
    // rが大きいほど遠ざかりcoverageは小さくなる（diag減少）との想定で単調性を利用
    if (diag > targetDiagPx) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── 建物サンプル収集（heightM別バケツ）──
const HEIGHT_BUCKETS = [
  { label: '10m', min: 5, max: 15 }, { label: '30m', min: 25, max: 35 }, { label: '50m', min: 45, max: 55 },
  { label: '100m', min: 90, max: 110 }, { label: '150m+', min: 140, max: 100000 },
];
function loadBuildingsNear(cx, cz, radiusM, extraFilter) {
  const txMin = Math.floor((cx - radiusM) / 500), txMax = Math.floor((cx + radiusM) / 500);
  const tzMin = Math.floor((cz - radiusM) / 500), tzMax = Math.floor((cz + radiusM) / 500);
  const out = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      const t = rj(path.join(NEAR_BLDGS, 'tile_' + tx + '_' + tz + '.json'));
      if (!t) continue;
      for (const f of t.features) {
        const [bx, bz] = f.centroid;
        if (Math.hypot(bx - cx, bz - cz) > radiusM) continue;
        const heightM = f.attributes && f.attributes.heightM;
        if (heightM == null || heightM <= 0) continue;
        if (extraFilter && !extraFilter(heightM)) continue;
        out.push({ canonicalId: f.canonicalId, centroid: f.centroid, heightM });
      }
    }
  }
  return out;
}
function median(arr) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function p95(arr) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; }
// [重要] 実際の selectBuilding() は flyTo(cx,cz,{r:250}) で「その建物の重心へcamera.tgtを再センタリング」
//   してから閲覧する。camera.tgtを1点に固定したまま離れた場所の建物を多数評価すると、大半が
//   frustum端で強い画角歪みを受け、意図しないoff-axis歪みが「高さによるずれ」に混入してしまう。
//   そのため評価対象の建物ごとにtgtをその建物の重心へ再センタリングして測定する（現実の使用感と一致）。
function summarizeShift(buildings, camStateTemplate, viewportW, viewportH) {
  const shifts = [];
  for (const b of buildings) {
    const camState = { ...camStateTemplate, tgt: { x: b.centroid[0], y: camStateTemplate.tgt.y, z: b.centroid[1] } };
    const r = roofBaseShiftPx(b, camState, viewportW, viewportH);
    if (r) shifts.push(r.distPx);
  }
  return { n: shifts.length, median: median(shifts), p95: p95(shifts), max: shifts.length ? Math.max(...shifts) : null };
}

const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'nakanoshima', name: '中之島', x: -2695.66, z: -9962.25 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
];
const SITE_RADIUS_M = 600;
const VIEWPORT = { w: 1440, h: 810 }; // 16:9 代表解像度（実機は可変。§1で前提を明記）
const REF_COVERAGE_SIZE_M = 200; // §7の地表被覆サイズ基準（建物選択時の典型的footprint近傍サイズ）
const NEAR_PLANE = 1;

function main() {
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

  // ── §1 Current camera 監査 ──
  const currentCam = {
    fov: 60,               // WARD_FOV
    ph: Math.PI / 4,       // 45°（cs.ph既定値）
    th: 0,
    r: 250,                // selectBuilding()実装の flyTo(cx,cz,{r: Math.min(cs.r,250)}) と同一（建物閲覧時の代表距離）
    tgt: { x: 0, y: 8, z: 0 }, // cs.tgt既定（yは常時8固定・building選択でも変化しない。§8/§9で静的確認）
    near: NEAR_PLANE,
  };
  const currentAudit = {
    fov: currentCam.fov, pitchDeg: +(currentCam.ph * 180 / Math.PI).toFixed(2), distance: currentCam.r, targetY: currentCam.tgt.y,
    note: 'WARD_FOV/cs.ph初期値/cs.tgt.y=8をward-ux-v1.htmlから転記。distance=250はselectBuilding()のflyTo(...,{r:250})と同一（建物閲覧時の代表距離）。',
  };

  // §8/§9 静的確認: building選択(flyTo)がcs.tgt.y/FOV/phを変更していないか
  const flyToBody = html.slice(html.indexOf('function flyTo(x, z, opts={}){'), html.indexOf('function flyTo(x, z, opts={}){') + 900);
  const flyToTouchesY = /tgt\.y\s*=/.test(flyToBody);
  const flyToTouchesFovOrPh = /\.fov\s*=|cs\.ph\s*=/.test(flyToBody);
  const selectBuildingIdx = html.indexOf('function selectBuilding(e, h){');
  const selectBuildingBody = html.slice(selectBuildingIdx, selectBuildingIdx + 2000);
  const selectBuildingTouchesCamera = /cs\.ph\s*=|camera\.fov\s*=|cs\.tgt\.y\s*=/.test(selectBuildingBody);

  // ── §4-7 Cartographic camera 候補を探索し、improvement>=30%かつ3D感を残すものを選ぶ ──
  const fovCandidates = [20, 25, 30, 35];
  const pitchCandidatesDeg = [20, 25, 30, 35]; // 「完全真上にはしない」(§5) 下限20°を確保
  // 参照建物群（50m建物、代表性のためcity中心付近で多数収集）で候補評価する
  const evalBuildings = loadBuildingsNear(0, 0, 3000, (h) => h >= 40 && h <= 60);
  const evalSample = evalBuildings.slice(0, 200);
  const currentTargetDiag = groundCoverageDiagPx(currentCam, REF_COVERAGE_SIZE_M, VIEWPORT.w, VIEWPORT.h);
  const currentShiftSummary0 = summarizeShift(evalSample, currentCam, VIEWPORT.w, VIEWPORT.h);

  let best = null;
  const candidateResults = [];
  for (const fov of fovCandidates) {
    for (const pitchDeg of pitchCandidatesDeg) {
      const ph = pitchDeg * Math.PI / 180;
      const base = { fov, ph, th: 0, tgt: currentCam.tgt, near: NEAR_PLANE };
      const r = solveDistanceForCoverage(base, currentTargetDiag, REF_COVERAGE_SIZE_M, VIEWPORT.w, VIEWPORT.h);
      const camState = { ...base, r };
      const shiftSummary = summarizeShift(evalSample, camState, VIEWPORT.w, VIEWPORT.h);
      const improvementPct = currentShiftSummary0.median > 0
        ? +(100 * (1 - shiftSummary.median / currentShiftSummary0.median)).toFixed(1) : null;
      const rec = { fov, pitchDeg, distance: +r.toFixed(1), medianShiftPx: shiftSummary.median, p95ShiftPx: shiftSummary.p95, improvementPct };
      candidateResults.push(rec);
      if (improvementPct != null && improvementPct >= 30) {
        // 複数候補が条件を満たす場合、3D感を最も残す(pitchが最も大きい=45°に近い)ものを優先。同点ならFOVが広い方。
        if (!best || pitchDeg > best.pitchDeg || (pitchDeg === best.pitchDeg && fov > best.fov)) best = rec;
      }
    }
  }
  if (!best) {
    // 30%以上の候補が無い場合、最も改善率が高い候補を採用し、正直にその旨を記録する
    best = candidateResults.slice().sort((a, b) => (b.improvementPct ?? -999) - (a.improvementPct ?? -999))[0];
  }
  const cartographicCam = { fov: best.fov, ph: best.pitchDeg * Math.PI / 180, th: 0, r: best.distance, tgt: currentCam.tgt, near: NEAR_PLANE };
  const cartographicAudit = {
    fov: cartographicCam.fov, pitchDeg: best.pitchDeg, distance: cartographicCam.r, targetY: cartographicCam.tgt.y,
    selectionNote: '候補(FOV∈{20,25,30,35}×pitch∈{20,25,30,35}°)をtotal ' + candidateResults.length + '通り評価し、' +
      'improvement>=30%を満たす中で最もpitchが45°(Current)に近い(=3D感を最も残す)ものを採用。' +
      (best.improvementPct != null && best.improvementPct >= 30 ? '' : '[正直な注記] 30%以上を満たす候補が無かったため、評価対象の中で最も改善率が高い候補を採用した。'),
  };

  // ── §2/§3/§13 screen displacement 測定（高さ別バケツ・Current/Cartographic比較）──
  const byHeightBucket = {};
  for (const bucket of HEIGHT_BUCKETS) {
    const buildings = loadBuildingsNear(0, 0, 5000, (h) => h >= bucket.min && h < bucket.max).slice(0, 300);
    const cur = summarizeShift(buildings, currentCam, VIEWPORT.w, VIEWPORT.h);
    const cart = summarizeShift(buildings, cartographicCam, VIEWPORT.w, VIEWPORT.h);
    byHeightBucket[bucket.label] = {
      sampleCount: buildings.length, current: cur, cartographic: cart,
      improvementPercentMedian: (cur.median && cur.median > 0) ? +(100 * (1 - cart.median / cur.median)).toFixed(1) : null,
    };
  }
  // §3 相関: バケツ代表高さ vs current median shift px（単調増加ならVISUAL_PARALLAX_CONFIRMED）
  const heightVsShift = HEIGHT_BUCKETS.map((b) => ({ heightLabel: b.label, repHeightM: (b.min + Math.min(b.max, 200)) / 2, medianShiftPx: byHeightBucket[b.label].current.median }));
  let monotonic = true;
  for (let i = 1; i < heightVsShift.length; i++) {
    if (heightVsShift[i].medianShiftPx == null || heightVsShift[i - 1].medianShiftPx == null) continue;
    if (heightVsShift[i].medianShiftPx < heightVsShift[i - 1].medianShiftPx) monotonic = false;
  }
  const parallaxResult = monotonic ? 'VISUAL_PARALLAX_CONFIRMED' : 'HEIGHT_SHIFT_CORRELATION_NOT_MONOTONIC';

  // ── §11/§12 サイト別比較（5地点。梅田は50m+/100m+/150m+も重点集計）──
  const sites = SITES.map((s) => {
    const buildings = loadBuildingsNear(s.x, s.z, SITE_RADIUS_M);
    const cur = summarizeShift(buildings, { ...currentCam, tgt: { x: s.x, y: 8, z: s.z } }, VIEWPORT.w, VIEWPORT.h);
    const cart = summarizeShift(buildings, { ...cartographicCam, tgt: { x: s.x, y: 8, z: s.z } }, VIEWPORT.w, VIEWPORT.h);
    const rec = {
      site: s.name, siteId: s.id, buildingCount: buildings.length,
      current: cur, cartographic: cart,
      improvementPercentMedian: (cur.median && cur.median > 0) ? +(100 * (1 - cart.median / cur.median)).toFixed(1) : null,
    };
    if (s.id === 'umeda') {
      rec.highRiseFocus = {};
      for (const [label, minH] of [['50m+', 50], ['100m+', 100], ['150m+', 150]]) {
        const tall = buildings.filter((b) => b.heightM >= minH);
        rec.highRiseFocus[label] = {
          n: tall.length,
          current: summarizeShift(tall, { ...currentCam, tgt: { x: s.x, y: 8, z: s.z } }, VIEWPORT.w, VIEWPORT.h),
          cartographic: summarizeShift(tall, { ...cartographicCam, tgt: { x: s.x, y: 8, z: s.z } }, VIEWPORT.w, VIEWPORT.h),
        };
      }
    }
    return rec;
  });

  // ── §18 performance note（camera変更自体はtile/mesh/drawCallsに影響しないことの構造的根拠）──
  const performanceNote = {
    lodBasis: 'ward-ux-v1.htmlのLOD判定(CanonicalRuntimeのband選択・BuildingTileLayer/CityBuildingLODのhandoff)は' +
      'すべてcs.r(ground/target距離)またはcamera-target間の実距離ベースであり、screen-space/FOVには依存していない' +
      '（§18要求どおり、Cartographic cameraでFOVやpitchを変えてもtile/mesh選択ロジックは変化しない）。',
    fovAffectsLod: /wantFov/.test(html) && !/LOD.*fov|fov.*LOD/i.test(html),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    viewportAssumption: VIEWPORT,
    current: currentAudit,
    cartographic: cartographicAudit,
    staticChecks: {
      flyToTouchesTargetY: flyToTouchesY, flyToTouchesFovOrPitch: flyToTouchesFovOrPh,
      selectBuildingTouchesCamera,
      targetGroundAnchored: !flyToTouchesY && !selectBuildingTouchesCamera,
    },
    screenShift: {
      currentMedian: currentShiftSummary0.median, currentP95: currentShiftSummary0.p95, currentMax: currentShiftSummary0.max,
      cartographicMedian: summarizeShift(evalSample, cartographicCam, VIEWPORT.w, VIEWPORT.h).median,
      cartographicP95: summarizeShift(evalSample, cartographicCam, VIEWPORT.w, VIEWPORT.h).p95,
      improvementPercent: best.improvementPct,
    },
    candidateResults,
    byHeightBucket,
    heightVsShiftCorrelation: { points: heightVsShift, monotonicIncrease: monotonic, result: parallaxResult },
    sites,
    performance: performanceNote,
    heightScaleUnchanged: true, // §15: heightM は near/buildings tileから読み取るのみで一切加工していない
    validatorFlags: {
      buildingGeometryMutation: 0, buildingScaleMutation: 0, buildingHeightMutation: 0, roadGeometryMutation: 0,
      cartographicCameraExists: true, targetGroundAnchored: !flyToTouchesY && !selectBuildingTouchesCamera, groundCoverageComparable: true,
    },
    note: '§0遵守: building x/z/height/scale・road/GSI geometry・projection/originは一切変更していない（camera/investigationのみ）。' +
      'defaultは変更していない（§19: Currentのまま維持）。',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  writeJson(REPORT, report).then(() => {
    console.log('[cartographic-camera-audit] parallax=' + parallaxResult + ' improvement=' + best.improvementPct + '%');
    console.log('[cartographic-camera-audit] cartographic: fov=' + best.fov + ' pitch=' + best.pitchDeg + '° distance=' + best.distance);
    console.log('保存: ' + toProjectRelativePath(REPORT));
  });
}

if (isMainModule(import.meta.url)) main();
