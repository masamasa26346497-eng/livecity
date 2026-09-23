#!/usr/bin/env node
// tools/audit/plateau-tran-coverage.js
// [Mission 31C2 §4/§30] PLATEAU tran:Road polygon のカバレッジと OSM centerline との位置整合を測る。
//   §30 STOP 条件（被覆不足 / CRS 不確定 / invalid 率過大 / OSM との位置差過大 / 年度・位置系不整合）を
//   数値で判定する。ここが PASS しない限り polygon-first 採用へ進まない。
//
// 実行: node tools/audit/plateau-tran-coverage.js
// 出力: data/reports/plateau-tran-coverage.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const TRAN = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const WARDS = P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const CONV_REPORT = P('data', 'reports', 'plateau-tran-conversion.json');
const OUT = P('data', 'reports', 'plateau-tran-coverage.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CELL = 100;             // カバレッジ格子（100m）
const HASH_M = 80;            // tran polygon 空間ハッシュ
const SAMPLE_EVERY_M = 25;    // centerline サンプル間隔
const MAX_SNAP_M = 60;        // これを超える最近傍距離は「対応なし」

// ── §30 判定しきい値（採用可否の事前定義）
export const STOP_THRESHOLDS = Object.freeze({
  minCityCellCoverage: 0.55,      // 市域の道路がある格子被覆の下限
  minWardsWithTran: 24,           // 24 区すべてに tran があること
  maxInvalidRate: 0.05,           // polygon invalid 率の上限
  maxMedianOffsetM: 8,            // OSM centerline → tran polygon 最近傍距離の中央値上限
  maxUnmatchedRatio: 0.35,        // 対応 polygon 無し centerline サンプルの割合上限
});

function pip(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function inWard(pt, ward) {
  for (const p of ward.polygons) {
    if (!pip(pt, p.outer)) continue;
    let hole = false;
    for (const h of (p.holes || [])) if (pip(pt, h)) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
/** 点から線分への距離。 */
function ptSegDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}
function outerRingsOf(poly) {
  return poly.geometryType === 'Polygon' ? [poly.coordinates[0]] : poly.coordinates.map((p) => p[0]);
}

/** build-canonical-roads.js の loadRoadFeatures と同じ読み方（tile_*.json / kind:'line' / ft.p）。 */
function loadOsmCenterlines() {
  const byId = new Map();
  if (!fs.existsSync(ROADS_DIR)) return [];
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || ft.p.length < 2) continue;
      if (!byId.has(ft.id)) byId.set(ft.id, { points: ft.p, name: ft.name || null, roadClass: ft.rc || ft.roadClass || null });
    }
  }
  return [...byId.values()];
}

async function main() {
  if (!fs.existsSync(TRAN)) { console.error('tran polygons.json が無い。先に convert-plateau-tran.js --convert'); process.exit(1); }
  console.log('[tran-coverage] 読込中...');
  const tj = JSON.parse(fs.readFileSync(TRAN, 'utf-8'));
  const polys = tj.polygons.filter((p) => p.surfaceKind === 'roadSurface');
  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards;
  const conv = fs.existsSync(CONV_REPORT) ? JSON.parse(fs.readFileSync(CONV_REPORT, 'utf-8')) : {};

  // ── §4 bbox / 面積 / 格子被覆
  let minX = 1e18, maxX = -1e18, minZ = 1e18, maxZ = -1e18, areaSum = 0;
  const cells = new Set();
  for (const p of polys) {
    const b = p.bbox;
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minZ < minZ) minZ = b.minZ; if (b.maxZ > maxZ) maxZ = b.maxZ;
    areaSum += p.areaM2;
    for (let x = Math.floor(b.minX / CELL); x <= Math.floor(b.maxX / CELL); x++)
      for (let z = Math.floor(b.minZ / CELL); z <= Math.floor(b.maxZ / CELL); z++) cells.add(x + ':' + z);
  }
  const bbox = { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minZ: +minZ.toFixed(1), maxZ: +maxZ.toFixed(1) };

  // ── §4 区別カバレッジ（polygon 代表点＝bbox 中心で区判定）
  const byWard = {};
  for (const w of wards) byWard[w.wardName] = { wardId: w.wardId, wardCode: w.wardCode, tranFeatureCount: 0, tranAreaM2: 0 };
  let outsideWards = 0;
  for (const p of polys) {
    const c = [(p.bbox.minX + p.bbox.maxX) / 2, (p.bbox.minZ + p.bbox.maxZ) / 2];
    let hit = null;
    for (const w of wards) {
      const b = w.bbox;
      if (c[0] < b.minX || c[0] > b.maxX || c[1] < b.minZ || c[1] > b.maxZ) continue;
      if (inWard(c, w)) { hit = w.wardName; break; }
    }
    if (hit) { byWard[hit].tranFeatureCount++; byWard[hit].tranAreaM2 += p.areaM2; }
    else outsideWards++;
  }
  for (const k of Object.keys(byWard)) {
    byWard[k].tranAreaM2 = +byWard[k].tranAreaM2.toFixed(0);
    byWard[k].tranAvailable = byWard[k].tranFeatureCount > 0;
  }
  const wardsWithTran = Object.values(byWard).filter((v) => v.tranAvailable).length;

  // ── §9/§10/§30 OSM centerline との位置整合
  console.log('[tran-coverage] OSM centerline 読込...');
  const cls = loadOsmCenterlines();
  // 空間ハッシュ
  const hash = new Map();
  polys.forEach((p, i) => {
    for (let x = Math.floor(p.bbox.minX / HASH_M); x <= Math.floor(p.bbox.maxX / HASH_M); x++)
      for (let z = Math.floor(p.bbox.minZ / HASH_M); z <= Math.floor(p.bbox.maxZ / HASH_M); z++) {
        const k = x + ':' + z; let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(i);
      }
  });
  const outerCache = new Map();
  const outersOf = (i) => { let o = outerCache.get(i); if (!o) outerCache.set(i, o = outerRingsOf(polys[i])); return o; };

  const offsets = [];
  let sampled = 0, inside = 0, unmatched = 0;
  for (const cl of cls) {
    for (let s = 0; s < cl.points.length - 1; s++) {
      const a = cl.points[s], b = cl.points[s + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / SAMPLE_EVERY_M));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        sampled++;
        const cand = hash.get(Math.floor(p[0] / HASH_M) + ':' + Math.floor(p[1] / HASH_M));
        if (!cand) { unmatched++; continue; }
        let best = Infinity, isIn = false;
        for (const i of cand) {
          for (const ring of outersOf(i)) {
            if (pip(p, ring)) { isIn = true; best = 0; break; }
            for (let q = 0, r = ring.length - 1; q < ring.length; r = q++) {
              const d = ptSegDist(p, ring[r], ring[q]);
              if (d < best) best = d;
            }
          }
          if (isIn) break;
        }
        if (isIn) { inside++; offsets.push(0); }
        else if (best <= MAX_SNAP_M) offsets.push(best);
        else unmatched++;
      }
    }
  }
  offsets.sort((a, b) => a - b);
  const q = (f) => (offsets.length ? +offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * f))].toFixed(2) : null);
  const insideRatio = sampled ? +(inside / sampled).toFixed(4) : 0;
  const unmatchedRatio = sampled ? +(unmatched / sampled).toFixed(4) : 1;

  // ── 市域格子被覆（OSM centerline が通る格子のうち tran がある割合）
  const clCells = new Set();
  for (const cl of cls) for (const p of cl.points) clCells.add(Math.floor(p[0] / CELL) + ':' + Math.floor(p[1] / CELL));
  let covered = 0;
  for (const k of clCells) if (cells.has(k)) covered++;
  const cityCellCoverage = clCells.size ? +(covered / clCells.size).toFixed(4) : 0;

  const invalidRate = conv.invalidRate != null ? conv.invalidRate : null;
  const checks = {
    crsDetermined: { ok: tj.sourceCrs === 'EPSG:6697' && tj.coordinateConvention === 'znorth-neg-v1', value: tj.sourceCrs + ' → ' + tj.coordinateConvention },
    bboxWithinCity: { ok: bbox.maxX > GROUND_EXTENT.minX && bbox.minX < GROUND_EXTENT.maxX && bbox.maxZ > GROUND_EXTENT.minZ && bbox.minZ < GROUND_EXTENT.maxZ, value: bbox },
    allWardsCovered: { ok: wardsWithTran >= STOP_THRESHOLDS.minWardsWithTran, value: wardsWithTran + '/24' },
    cityCellCoverage: { ok: cityCellCoverage >= STOP_THRESHOLDS.minCityCellCoverage, value: cityCellCoverage },
    invalidRate: { ok: invalidRate != null && invalidRate <= STOP_THRESHOLDS.maxInvalidRate, value: invalidRate },
    osmMedianOffset: { ok: q(0.5) != null && q(0.5) <= STOP_THRESHOLDS.maxMedianOffsetM, value: q(0.5) },
    osmUnmatchedRatio: { ok: unmatchedRatio <= STOP_THRESHOLDS.maxUnmatchedRatio, value: unmatchedRatio },
  };
  const failed = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);

  const report = {
    generatedAt: new Date().toISOString(),
    source: { file: toProjectRelativePath(TRAN), sourceCrs: tj.sourceCrs, axisOrder: tj.axisOrder, geometrySemantics: tj.geometrySemantics, sourceGmlCount: tj.sourceGmlCount },
    featureCount: polys.length,
    subsurfaceExcluded: tj.polygons.length - polys.length,
    totalAreaM2: +areaSum.toFixed(0),
    bbox, groundExtent: GROUND_EXTENT,
    cityCellCoverage, coveredCells: covered, centerlineCells: clCells.size, tranCells: cells.size,
    wardCoverage: { wardsWithTran, total: wards.length, byWard },
    polygonsOutsideAllWards: outsideWards,
    osmAlignment: {
      centerlines: cls.length, sampledPoints: sampled,
      insideRatio, unmatchedRatio,
      offsetM: { p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), max: offsets.length ? +offsets[offsets.length - 1].toFixed(2) : null },
      note: 'centerline サンプルが tran polygon 内なら 0m。' + MAX_SNAP_M + 'm 超は unmatched。',
    },
    stopThresholds: STOP_THRESHOLDS,
    checks, failedChecks: failed,
    RESULT: failed.length === 0 ? 'READY-FOR-POLYGON-FIRST' : 'STOP',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log('[tran-coverage] feature ' + polys.length + ' / area ' + (areaSum / 1e6).toFixed(2) + 'km²');
  console.log('  bbox ' + JSON.stringify(bbox));
  console.log('  ward: ' + wardsWithTran + '/24, cityCellCoverage ' + cityCellCoverage);
  console.log('  OSM: inside ' + insideRatio + ' / unmatched ' + unmatchedRatio + ' / offset p50 ' + q(0.5) + 'm p90 ' + q(0.9) + 'm');
  console.log('  checks: ' + Object.entries(checks).map(([k, v]) => k + '=' + (v.ok ? 'PASS' : 'FAIL')).join(' '));
  console.log('保存: ' + toProjectRelativePath(OUT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[tran-coverage] 失敗:', e && e.stack || e); process.exit(1); });
