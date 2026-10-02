#!/usr/bin/env node
// tools/build-water-surface.js
// [見た目改善 Mission06] 大阪湾・港湾水面（WaterSurfaceLayer）の配信データを生成する。
// ══════════════════════════════════════════════════════════════════════════════════
// ネットワーク不要。入力は既存の検証済み 24 区ポリゴンだけ:
//   public/map-data/osaka-city/boundaries/ward-classification-polygons.json（陸マスク）
//
// 出力:
//   public/map-data/osaka-city/water-surface/water-surface.json   （HTML が fetch）
//   data/processed/osaka-city/water-surface/water-surface.json     （確認用・同内容）
//   data/reports/water-surface-build.json                          （生成レポート）
//
// 方式（tools/lib/water-surface.js 参照）:
//   海セル = SEA_MASK 内側 ∧ 24 区の陸に入らない ∧ 地表矩形内側 を 50m グリッドでラスタライズ
//   → 行ランへ結合 → 軸並行矩形 → 上向き三角形。coastline のリング組み立ては一切しない。
//   生成後に validateWaterSurface() の多重ゲートを通し、fail したら空で出荷（reject-to-empty）。
//
// 実行:  node tools/build-water-surface.js [--cell 50] [--check]
// ══════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson, writeJsonCompact } from './lib/area.js';
import {
  GROUND_EXTENT, SEA_MASK, DEFAULT_CELL_M, INLAND_TEST_POINTS,
  flattenWardPolygons, rasterizeSea, mergeRowRuns, runsToTriangles, validateWaterSurface,
  filterRunsAgainstLand,
} from './lib/water-surface.js';

const WARDS_JSON = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const OUT_PUBLIC = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json'));
const OUT_PROCESSED = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'water-surface', 'water-surface.json'));
const OUT_REPORT = resolveProjectPath(path.join('data', 'reports', 'water-surface-build.json'));

function parseArgs(argv) {
  const a = { cell: DEFAULT_CELL_M, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cell') a.cell = parseInt(argv[++i], 10) || DEFAULT_CELL_M;
    else if (argv[i] === '--check') a.check = true;
  }
  return a;
}

export function buildWaterSurface({ wards, cellM = DEFAULT_CELL_M }) {
  const wardPolygons = flattenWardPolygons(wards);
  const raster = rasterizeSea({ wardPolygons, cellM });
  const runsRaw = mergeRowRuns(raster);
  // [Mission21] 陸（ward ポリゴン）と少しでも重なる矩形を除外 → land∩water overlap を 0 に
  const runs = filterRunsAgainstLand(runsRaw, wardPolygons);
  const runsDroppedByLand = runsRaw.length - runs.length;
  const { positions, triangleCount } = runsToTriangles(runs);
  const validation = validateWaterSurface({ positions, cellM });

  // reject-to-empty: 検証に失敗したら三角形を出さない
  const emit = validation.ok;
  const outPositions = emit ? positions : [];
  const outRuns = emit ? runs : [];

  let bbox = null;
  if (outPositions.length) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < outPositions.length; i += 2) {
      const x = outPositions[i], z = outPositions[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    bbox = { minX, maxX, minZ, maxZ };
  }

  return {
    payload: {
      version: 1,
      coordinateConvention: 'znorth-neg-v1',
      generatedAt: new Date().toISOString(),
      method: 'raster(SEA_MASK ∧ ¬ward-land ∧ ground-extent) → row-run rectangles → up-facing triangles（coastlineリング組み立てなし）',
      layer: 'water-surface',
      cellM,
      seaMask: SEA_MASK,
      groundExtent: GROUND_EXTENT,
      emitted: emit,
      rejectedToEmpty: !emit,
      validationErrors: validation.errors,
      rectangleCount: outRuns.length,
      triangleCount: emit ? triangleCount : 0,
      areaM2: emit ? Math.round(validation.stats.areaM2) : 0,
      bbox,
      // 三角形頂点（znorth-neg-v1 の [x, z] を平坦化。Y は描画側で付与）
      positions: outPositions,
    },
    report: {
      generatedAt: new Date().toISOString(),
      input: toProjectRelativePath(WARDS_JSON),
      cellM,
      raster: { cols: raster.cols, rows: raster.rows, origin: raster.origin, seaCellCount: raster.seaCellCount, rasterAreaKm2: +(raster.areaM2 / 1e6).toFixed(2) },
      rectangleCount: runs.length,
      runsDroppedByLand,
      triangleCount,
      sampleRectangles: outRuns.slice(0, 8),
      validation,
      inlandTestPointCount: INLAND_TEST_POINTS.length,
      emitted: emit,
      RESULT: emit ? 'PASS' : 'REJECTED-TO-EMPTY',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(WARDS_JSON)) {
    console.error(`[stop] 入力が見つかりません: ${toProjectRelativePath(WARDS_JSON)}`);
    process.exit(1);
  }
  const wardsDoc = JSON.parse(fs.readFileSync(WARDS_JSON, 'utf-8'));
  const wards = wardsDoc.wards || [];
  console.log(`[water-surface] 入力: ${wards.length} 区ポリゴン / cell=${args.cell}m`);

  const t0 = Date.now();
  const { payload, report } = buildWaterSurface({ wards, cellM: args.cell });
  console.log(`[water-surface] ラスタ ${report.raster.cols}×${report.raster.rows} / 海セル ${report.raster.seaCellCount} (${report.raster.rasterAreaKm2}km²) / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[water-surface] 矩形 ${payload.rectangleCount} / 三角形 ${payload.triangleCount} / 面積 ${(payload.areaM2 / 1e6).toFixed(1)}km²`);
  if (report.validation.errors.length) {
    console.warn('[water-surface] 検証エラー（→ 空で出荷）:');
    for (const e of report.validation.errors) console.warn('   - ' + e);
  }
  console.log(`[water-surface] stats: ${JSON.stringify(report.validation.stats)}`);
  console.log(`[water-surface] RESULT: ${report.RESULT}`);

  await writeJson(OUT_REPORT, report);
  if (args.check) {
    console.log('[water-surface] --check: ファイルは書き込みません');
    process.exit(report.emitted ? 0 : 1);
  }
  await writeJsonCompact(OUT_PUBLIC, payload);
  await writeJson(OUT_PROCESSED, { ...payload, positions: `[${payload.positions.length} numbers — see public/…/water-surface.json]` });
  console.log(`[water-surface] 書込: ${toProjectRelativePath(OUT_PUBLIC)}`);
  console.log(`[water-surface]       ${toProjectRelativePath(OUT_PROCESSED)}`);
  console.log(`[water-surface]       ${toProjectRelativePath(OUT_REPORT)}`);
  if (!report.emitted) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('生成に失敗:', e && e.stack || e); process.exit(1); });
}
