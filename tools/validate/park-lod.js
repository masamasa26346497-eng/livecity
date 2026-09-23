#!/usr/bin/env node
// tools/validate/park-lod.js
// [見た目改善 Mission12] 公園 LOD validator CLI。
//   parks tile の area feature を面積で LARGE/MEDIUM/SMALL に分類し、以下を検証する:
//     - area finite / area > 0
//     - classification coverage（LARGE+MEDIUM+SMALL = 全 feature、未分類なし）
//     - id 重複なし
//     - polygon topology: 三角形の maxEdge / maxArea、giant geometry（bbox 対角 > 上限）なし
//     - bbox containment（大阪市外接矩形 + margin 内）
//
// 実行: node tools/validate/park-lod.js
//       node tools/validate/park-lod.js --parks public/map-data/osaka-city/parks

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { classifyParkArea, polygonAreaWithHoles, PARK_AREA_LARGE_M2, PARK_AREA_MEDIUM_M2 } from '../lib/park-lod.js';

const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const LIMITS = {
  maxBboxDiagM: 4000,     // 単一公園の bbox 対角がこれ超は assemble 異常（大阪城公園でも ~1.5km）
  maxTriangleEdgeM: 1800,
  maxTriangleAreaM2: 700000, // fan分割（検証用の粗い分割）基準。実描画は earcut。真の giant bug は桁違い(数百万m²)。
  bboxMarginM: 800,
};
const AUDIT_NAMES = ['大阪城公園', '長居公園', '鶴見緑地', '天王寺公園', '花博記念公園'];

function parseArgs(argv) {
  const a = { parks: path.join('public', 'map-data', 'osaka-city', 'parks'), report: path.join('data', 'reports', 'park-lod-validation.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--parks') a.parks = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

function loadParkFeatures(dir) {
  const byId = new Map();
  let dupIds = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind && ft.kind !== 'area') continue;
      if (byId.has(ft.id)) { dupIds++; continue; }
      byId.set(ft.id, ft);
    }
  }
  return { feats: [...byId.values()], dupIds };
}

function ringBbox(ring) {
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const p of ring) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mnz) mnz = p[1]; if (p[1] > mxz) mxz = p[1]; }
  return { minX: mnx, maxX: mxx, minZ: mnz, maxZ: mxz, diag: Math.hypot(mxx - mnx, mxz - mnz) };
}
// fan triangulation for edge/area limit checks (topology sanity only, not the render path)
function fanTris(ring) {
  const tris = [];
  for (let i = 1; i + 1 < ring.length; i++) tris.push([ring[0], ring[i], ring[i + 1]]);
  return tris;
}
function triMaxEdge(t) {
  return Math.max(
    Math.hypot(t[0][0] - t[1][0], t[0][1] - t[1][1]),
    Math.hypot(t[1][0] - t[2][0], t[1][1] - t[2][1]),
    Math.hypot(t[2][0] - t[0][0], t[2][1] - t[0][1]),
  );
}
function triArea(t) {
  return Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveProjectPath(args.parks);
  if (!fs.existsSync(dir)) {
    console.error(`[park-lod-validate] parks tile ディレクトリが見つかりません: ${toProjectRelativePath(dir)}`);
    process.exitCode = 1;
    return;
  }
  const { feats, dupIds } = loadParkFeatures(dir);
  console.log(`[park-lod-validate] parks=${feats.length}（id重複排除済み、重複 ${dupIds} 件スキップ）`);

  const errors = [], warns = [];
  const byClass = { large: 0, medium: 0, small: 0 };
  let unclassified = 0, nonFiniteArea = 0, nonPositiveArea = 0, giantGeom = 0, bboxViolations = 0;
  let totalArea = 0, maxEdgeSeen = 0, maxTriAreaSeen = 0;
  const audit = [];

  for (const f of feats) {
    if (!Array.isArray(f.p) || f.p.length < 3) { errors.push(`[${f.name || f.id}] 頂点数 < 3`); byClass.small++; continue; }
    const area = polygonAreaWithHoles(f.p, f.holes);
    if (!Number.isFinite(area)) { nonFiniteArea++; errors.push(`[${f.name || f.id}] area が非有限`); }
    else if (area <= 0) { nonPositiveArea++; errors.push(`[${f.name || f.id}] area <= 0`); }
    else totalArea += area;

    const cls = classifyParkArea(area);
    if (!(cls in byClass)) { unclassified++; errors.push(`[${f.name || f.id}] 未分類 (${cls})`); }
    else byClass[cls]++;

    const bb = ringBbox(f.p);
    if (bb.diag > LIMITS.maxBboxDiagM) { giantGeom++; errors.push(`[${f.name || f.id}] bbox対角 ${Math.round(bb.diag)}m > ${LIMITS.maxBboxDiagM}m（assemble異常の疑い）`); }
    const overX = Math.max(0, OSAKA_CITY_BBOX.minX - LIMITS.bboxMarginM - bb.minX, bb.maxX - (OSAKA_CITY_BBOX.maxX + LIMITS.bboxMarginM));
    const overZ = Math.max(0, OSAKA_CITY_BBOX.minZ - LIMITS.bboxMarginM - bb.minZ, bb.maxZ - (OSAKA_CITY_BBOX.maxZ + LIMITS.bboxMarginM));
    if (overX > 0 || overZ > 0) { bboxViolations++; errors.push(`[${f.name || f.id}] bboxが大阪市外接矩形+${LIMITS.bboxMarginM}mを外れる`); }

    for (const t of fanTris(f.p)) {
      const e = triMaxEdge(t), a = triArea(t);
      if (e > maxEdgeSeen) maxEdgeSeen = e;
      if (a > maxTriAreaSeen) maxTriAreaSeen = a;
      if (e > LIMITS.maxTriangleEdgeM) warns.push(`[${f.name || f.id}] triangle maxEdge ${Math.round(e)}m > ${LIMITS.maxTriangleEdgeM}m`);
      if (a > LIMITS.maxTriangleAreaM2) warns.push(`[${f.name || f.id}] triangle area ${Math.round(a)}m² > ${LIMITS.maxTriangleAreaM2}m²`);
    }

    if (f.name && AUDIT_NAMES.some((n) => f.name.includes(n))) {
      audit.push({ id: f.id, name: f.name, areaHa: +(area / 1e4).toFixed(2), class: cls, points: f.p.length, bboxDiagM: Math.round(bb.diag) });
    }
  }

  const classifiedTotal = byClass.large + byClass.medium + byClass.small;
  if (classifiedTotal !== feats.length) errors.push(`classification coverage: 分類合計 ${classifiedTotal} != feature数 ${feats.length}`);

  console.log(`  分類: LARGE=${byClass.large} MEDIUM=${byClass.medium} SMALL=${byClass.small}（閾値 L>=${PARK_AREA_LARGE_M2} / M>=${PARK_AREA_MEDIUM_M2} m²）`);
  console.log(`  総面積=${(totalArea / 1e6).toFixed(2)} km² / maxTriangleEdge=${Math.round(maxEdgeSeen)}m / maxTriangleArea=${Math.round(maxTriAreaSeen)}m²`);
  console.log(`  giantGeom=${giantGeom} bboxViolations=${bboxViolations} nonFiniteArea=${nonFiniteArea} nonPositiveArea=${nonPositiveArea} unclassified=${unclassified}`);
  console.log('  -- 大公園 audit --');
  for (const a of audit.sort((x, y) => y.areaHa - x.areaHa)) {
    console.log(`  [${a.class === 'large' ? 'LARGE' : a.class.toUpperCase()}] ${a.name}: ${a.areaHa}ha pts=${a.points} bboxDiag=${a.bboxDiagM}m`);
  }
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log(`  -- warns (${warns.length}件、先頭10) --`); for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(), parksDir: toProjectRelativePath(dir),
    parkCount: feats.length, dupIds, byClass, totalAreaKm2: +(totalArea / 1e6).toFixed(3),
    maxTriangleEdgeM: Math.round(maxEdgeSeen), maxTriangleAreaM2: Math.round(maxTriAreaSeen),
    giantGeom, bboxViolations, nonFiniteArea, nonPositiveArea, unclassified,
    thresholds: { largeM2: PARK_AREA_LARGE_M2, mediumM2: PARK_AREA_MEDIUM_M2 },
    errorCount: errors.length, warnCount: warns.length, errors, warns: warns.slice(0, 50),
    audit,
  };
  const reportPath = resolveProjectPath(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[park-lod-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
