#!/usr/bin/env node
// tools/audit/waterway-density.js
// [Mission28 §12] 大阪市 水系の completeness 監査。
//   100m グリッドで knownWaterFeature（OSM の surface waterway line）と
//   renderedWaterFeature（rivers-v2/rivers.json の ok セグメント）を比較し、
//   「OSM に存在する surface waterway が理由なく消えている」cell を抽出する。
//   underground（暗渠・トンネル・layer<0）は missing に数えない。
//
// 出力: data/reports/waterway-density.json
// 実行: node tools/audit/waterway-density.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { classifyRiverTier, normalizeRiverName, polylineLengthXZ } from '../lib/river-network.js';

const SRC_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'waterways'));
const RIVERS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json'));
const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'waterway-density.json'));

const RIBBON_CLASSES = new Set(['river', 'canal', 'stream']); // build-river-layer と一致（drain/ditch は waterClass='canal'）
const CELL_M = 100;

function loadWaterwayLines() {
  const byId = new Map();
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind === 'line' && RIBBON_CLASSES.has(ft.waterClass) && !byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  return [...byId.values()];
}

function rasterizeLine(p, set, origin) {
  if (!Array.isArray(p) || p.length < 2) return;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(d / (CELL_M / 2)));
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + (b[0] - a[0]) * s / steps, z = a[1] + (b[1] - a[1]) * s / steps;
      set.add(Math.floor((x - origin.x) / CELL_M) + ',' + Math.floor((z - origin.z) / CELL_M));
    }
  }
}

function pnpoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

async function main() {
  const lines = loadWaterwayLines();
  const surface = lines.filter((f) => f.surface !== false);
  const underground = lines.filter((f) => f.surface === false);

  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  const wardPolys = [];
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const w of wards) for (const pg of (w.polygons || [])) {
    wardPolys.push({ wardId: w.wardId, outer: pg.outer || [], holes: pg.holes || [] });
    for (const pt of (pg.outer || [])) { if (pt[0] < mnx) mnx = pt[0]; if (pt[0] > mxx) mxx = pt[0]; if (pt[1] < mnz) mnz = pt[1]; if (pt[1] > mxz) mxz = pt[1]; }
  }
  const origin = { x: Math.floor(mnx / CELL_M) * CELL_M, z: Math.floor(mnz / CELL_M) * CELL_M };
  const wardAt = (x, z) => {
    for (const p of wardPolys) {
      if (!pnpoly(x, z, p.outer)) continue;
      let hole = false;
      for (const h of p.holes) if (pnpoly(x, z, h)) { hole = true; break; }
      if (!hole) return p.wardId;
    }
    return null;
  };

  const knownSurface = new Set();
  const knownUnderground = new Set();
  for (const f of surface) rasterizeLine(f.p, knownSurface, origin);
  for (const f of underground) rasterizeLine(f.p, knownUnderground, origin);

  // rendered = rivers.json の ok・非 suppressed セグメント
  const rj = JSON.parse(fs.readFileSync(RIVERS, 'utf-8'));
  const rendered = new Set();
  let suppressedSegs = 0;
  for (const r of (rj.rivers || [])) {
    if (!r.ok) continue;
    if (r.suppressed) { suppressedSegs++; }
    const cl = (Array.isArray(r.centerline) && r.centerline.length >= 2) ? r.centerline : r.left;
    if (r.suppressed || !Array.isArray(cl) || cl.length < 2) continue;
    rasterizeLine(cl, rendered, origin);
  }
  // suppress された小水路の centerline（説明済み missing 用）
  const suppressedCells = new Set();
  for (const r of (rj.rivers || [])) {
    if (!r.ok || !r.suppressed) continue;
    const cl = (Array.isArray(r.centerline) && r.centerline.length >= 2) ? r.centerline : r.left;
    if (Array.isArray(cl) && cl.length >= 2) rasterizeLine(cl, suppressedCells, origin);
  }

  // 3x3 窓で「近くに rendered があるか」
  const renderedNear = (key) => {
    const [cx, cz] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (rendered.has((cx + dx) + ',' + (cz + dz))) return true;
    return false;
  };

  let knownSurfaceCells = 0, renderedCells = 0, missingSurfaceWater = 0, missingButSuppressed = 0, missingOutsideWard = 0;
  const missingByWard = {};
  const missingSamples = [];
  for (const key of knownSurface) {
    const [cx, cz] = key.split(',').map(Number);
    const x = origin.x + cx * CELL_M + CELL_M / 2, z = origin.z + cz * CELL_M + CELL_M / 2;
    const wd = wardAt(x, z);
    if (!wd) { missingOutsideWard++; continue; } // 市域外（隣接市へ続く区間）はカウント外
    knownSurfaceCells++;
    if (renderedNear(key)) { renderedCells++; continue; }
    if (suppressedCells.has(key)) { missingButSuppressed++; continue; } // 建物干渉 suppress = 説明済み
    missingSurfaceWater++;
    missingByWard[wd] = (missingByWard[wd] || 0) + 1;
    if (missingSamples.length < 40) missingSamples.push({ ward: wd, x: Math.round(x), z: Math.round(z) });
  }

  // raw waterway tag 内訳
  const rawByTag = {};
  for (const f of lines) {
    const k = f.waterwayTag || f.subtype || f.waterClass || '?';
    const b = rawByTag[k] || (rawByTag[k] = { total: 0, surface: 0, underground: 0, named: 0 });
    b.total++; if (f.surface === false) b.underground++; else b.surface++; if (f.name) b.named++;
  }
  // tier 内訳（surface のみ）
  const tierCount = { major: 0, medium: 0, minor: 0, micro: 0 };
  for (const f of surface) {
    const t = classifyRiverTier({ name: f.name || '', waterwayTag: f.waterwayTag, waterClass: f.waterClass, groupLengthM: polylineLengthXZ(f.p) });
    tierCount[t]++;
  }

  const coverage = knownSurfaceCells ? +(renderedCells / knownSurfaceCells).toFixed(4) : 1;
  const report = {
    generatedAt: new Date().toISOString(),
    method: '100m グリッドで OSM surface waterway line（rendered near 3x3 窓）を照合。underground / 市域外 / 建物干渉 suppress は missing に数えない。',
    cellM: CELL_M,
    rawWaterwayLines: lines.length,
    surfaceLines: surface.length,
    undergroundLines: underground.length,
    rawByTag,
    surfaceTierCount: tierCount,
    grid: {
      knownSurfaceCells,
      renderedCells,
      coverage,
      undergroundSkippedCells: knownUnderground.size,
      missingSurfaceWater,
      missingButSuppressed,
      missingOutsideWard,
    },
    missingByWard,
    missingSamples,
    suppressedSegments: suppressedSegs,
    RESULT: (missingSurfaceWater <= Math.max(20, knownSurfaceCells * 0.02)) ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[waterway-density-audit] raw line ' + lines.length + ' (surface ' + surface.length + ' / underground ' + underground.length + ')');
  console.log('  surface tier: ' + JSON.stringify(tierCount));
  console.log('  grid: known surface ' + knownSurfaceCells + ' cells → rendered ' + renderedCells + ' (' + (coverage * 100).toFixed(1) + '%)  missing ' + missingSurfaceWater
    + ' (suppress済 ' + missingButSuppressed + ' / underground cell ' + knownUnderground.size + ')');
  console.log('  missingByWard: ' + (Object.entries(missingByWard).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, n]) => w + ':' + n).join(' ') || 'なし'));
  console.log('保存:', toProjectRelativePath(REPORT), ' RESULT:', report.RESULT);
}

main().catch((e) => { console.error('[waterway-density-audit] 失敗:', e && e.stack || e); process.exitCode = 1; });
