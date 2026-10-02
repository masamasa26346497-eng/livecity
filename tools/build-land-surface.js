#!/usr/bin/env node
// tools/build-land-surface.js
// [見た目改善 Mission21] 大阪市24区の陸域サーフェス（LandSurfaceLayer）配信データを生成する。
// ══════════════════════════════════════════════════════════════════════════════════
// ネットワーク不要。入力: public/map-data/osaka-city/boundaries/ward-classification-polygons.json
//   （N03 2026 大阪市24区 / 39 features / 1 hole）＋ 夢洲 施工済みコア補完（DREAM_ISLAND）。
//
// 方式（tools/lib/land-coverage.js）:
//   N03 陸ポリゴン → 1000m タイルへ Sutherland–Hodgman クリップ → earcut（hole 対応）で分割 →
//   退化スライバ除去・winding を +Y へ正規化 → タイル横断で 1 つの merged geometry。
//   「N03 を無検証で巨大 mesh 化」しない（tile clip + 三角形検証を必ず通す）。
//
// 出力:
//   public/map-data/osaka-city/land-surface/land-surface.json   （HTML が fetch）
//   data/processed/osaka-city/land-surface/land-surface.json     （確認用）
//   data/reports/land-surface-build.json                          （生成レポート）
//
// 実行:  node tools/build-land-surface.js [--tile 1000] [--check]
// ══════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson, writeJsonCompact } from './lib/area.js';
import { GROUND_EXTENT, SEA_MASK } from './lib/water-surface.js';
import { buildLandSurface, validateLandSurface, DREAM_ISLAND, auditLandCoverage, auditKeyPlaces } from './lib/land-coverage.js';

const WATER_JSON = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json'));

const WARDS_JSON = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const OUT_PUBLIC = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'land-surface', 'land-surface.json'));
const OUT_PROCESSED = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'land-surface', 'land-surface.json'));
const OUT_REPORT = resolveProjectPath(path.join('data', 'reports', 'land-surface-build.json'));

export function build({ wards, tileM = 1000, waterPositions = null }) {
  const ls = buildLandSurface({ wards, tileM });
  const v = validateLandSurface(ls.positions, { tileM });
  const emit = v.ok;
  const audit = auditLandCoverage({ wards, cellM: 50, seaMask: SEA_MASK, waterPositions });
  const keyPlaces = auditKeyPlaces(wards, SEA_MASK, DREAM_ISLAND, waterPositions);
  return {
    payload: {
      version: 1,
      coordinateConvention: 'znorth-neg-v1',
      generatedAt: new Date().toISOString(),
      layer: 'land-surface',
      method: 'N03 24区ポリゴン → ' + tileM + 'm tile clip (Sutherland–Hodgman) → earcut(hole対応) → sliver除去/winding正規化 → merged。夢洲コア補完つき。',
      tileM,
      groundExtent: GROUND_EXTENT,
      dreamIsland: { id: DREAM_ISLAND.id, name: DREAM_ISLAND.name, ward: DREAM_ISLAND.ward, reason: DREAM_ISLAND.reason, outer: DREAM_ISLAND.outer },
      emitted: emit,
      rejectedToEmpty: !emit,
      validationErrors: v.errors,
      triangleCount: emit ? ls.triangleCount : 0,
      tiles: ls.tiles,
      areaM2: emit ? Math.round(v.stats.areaM2) : 0,
      bbox: ls.bbox,
      coverage: {
        cellM: audit.cellM, coveragePercent: audit.coveragePercent,
        totalLandSamples: audit.landSamples, coveredLandSamples: audit.coveredLandSamples,
        missingLandSamples: audit.missingLandSamples, waterSamples: audit.waterSamples,
        seaOverlapSamples: audit.seaOverlapSamples, landAreaKm2: audit.landAreaKm2,
        byWard: audit.byWard,
      },
      keyPlaces,
      positions: emit ? ls.positions.map((n) => Math.round(n * 100) / 100) : [],
    },
    report: {
      generatedAt: new Date().toISOString(),
      input: toProjectRelativePath(WARDS_JSON),
      tileM, tiles: ls.tiles, triangleCount: ls.triangleCount,
      areaKm2: +(v.stats.areaM2 / 1e6).toFixed(2),
      validation: v,
      dreamIsland: DREAM_ISLAND.reason,
      RESULT: emit ? 'PASS' : 'REJECTED-TO-EMPTY',
    },
  };
}

async function main() {
  const args = { tile: 1000, check: process.argv.includes('--check') };
  const ti = process.argv.indexOf('--tile'); if (ti >= 0) args.tile = parseInt(process.argv[ti + 1], 10) || 1000;
  if (!fs.existsSync(WARDS_JSON)) { console.error('[stop] 入力なし: ' + toProjectRelativePath(WARDS_JSON)); process.exit(1); }
  const wards = JSON.parse(fs.readFileSync(WARDS_JSON, 'utf-8')).wards || [];
  const waterPositions = fs.existsSync(WATER_JSON) ? (JSON.parse(fs.readFileSync(WATER_JSON, 'utf-8')).positions || null) : null;
  console.log('[land-surface] N03 ' + wards.length + ' 区 / tile=' + args.tile + 'm / water-surface ' + (waterPositions ? 'あり' : 'なし'));
  const { payload, report } = build({ wards, tileM: args.tile, waterPositions });
  console.log('[land-surface] 三角形 ' + payload.triangleCount + ' / タイル ' + payload.tiles + ' / 面積 ' + (payload.areaM2 / 1e6).toFixed(1) + 'km²');
  console.log('[land-surface] coverage ' + payload.coverage.coveragePercent + '% / seaOverlap ' + payload.coverage.seaOverlapSamples);
  console.log('[land-surface] validate: ' + JSON.stringify(report.validation.stats));
  if (report.validation.errors.length) for (const e of report.validation.errors) console.warn('   - ' + e);
  console.log('[land-surface] RESULT: ' + report.RESULT);
  await writeJson(OUT_REPORT, report);
  if (args.check) { console.log('[land-surface] --check: 書き込みなし'); process.exit(payload.emitted ? 0 : 1); }
  await writeJsonCompact(OUT_PUBLIC, payload);
  await writeJson(OUT_PROCESSED, { ...payload, positions: '[' + payload.positions.length + ' numbers — see public/…/land-surface.json]' });
  console.log('[land-surface] 書込: ' + toProjectRelativePath(OUT_PUBLIC));
  if (!payload.emitted) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('生成失敗:', e && e.stack || e); process.exit(1); });
