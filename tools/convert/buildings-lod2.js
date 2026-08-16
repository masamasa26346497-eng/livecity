#!/usr/bin/env node
// tools/convert/buildings-lod2.js
//
// LOD2建築物の「変換可能性レポート」を生成する骨格スクリプト。
// 今回は本格的なGLB生成は行わない（ご指示6）。実装するのは以下まで:
//   - RoofSurface / WallSurface / GroundSurface の posList 抽出
//   - EPSG:6697(緯度経度+標高) → LiveCityローカル座標(既存 projection と同一式)への変換
//   - buildingId の保持
//   - メッシュ境界(ローカル座標のbbox)の計算
//   - 建物ごとの三角形数の集計
//   - 変換可能性レポート(JSON)の出力
//
// 前提: 先に tools/download/plateau-buildings-lod2.js を実行し、raw/.../gml/ にGMLがあること。
// LOD2が0件のGMLしか無い場合は、疑似データを作らず明確に停止する（ご指示6）。
//
// 使い方:
//   node tools/convert/buildings-lod2.js --year 2024 --mesh 51357422

import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { loadDataset } from '../lib/dataset.js';
import { loadAreaConfig, ensureDir, writeJson } from '../lib/area.js';
import { isMainModule, toProjectRelativePath } from '../lib/paths.js';
import { geoToLocal } from '../lib/projection.js';
import {
  splitBuildings, extractBuildingId, summarizeBuildingGeometry, extractSurfacePosLists,
} from '../lib/citygml.js';
import { lod2RawGmlDir, lod2GeometryReportDir } from '../lib/lod2-paths.js';

const DATASET_ID = 'plateau-osaka-buildings-lod2';

function parseArgs(argv) {
  const args = { year: null, mesh: null, area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--year') args.year = Number(argv[++i]);
    else if (argv[i] === '--mesh') args.mesh = argv[++i];
    else if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

function fail(msg, code = 1) {
  console.error(`\n[停止] ${msg}`);
  process.exit(code);
}

/**
 * 1建物のLOD2幾何をローカル座標へ変換し、頂点範囲・三角形数を返す。
 * 座標系が想定外(緯度経度の範囲を大きく外れる)場合は throw。
 */
function convertBuildingGeometry(bldgXml, projection) {
  const id = extractBuildingId(bldgXml);
  const kinds = ['Roof', 'Wall', 'Ground'];
  const surfacesByKind = {};
  let triangles = 0, surfaceCount = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let hasCoords = false;

  for (const k of kinds) {
    const surfaces = extractSurfacePosLists(bldgXml, k);
    surfacesByKind[k] = surfaces.length;
    for (const poly of surfaces) {
      surfaceCount++;
      const ring = (poly.length > 1 &&
        poly[0][0] === poly[poly.length - 1][0] &&
        poly[0][1] === poly[poly.length - 1][1]) ? poly.slice(0, -1) : poly;
      triangles += Math.max(0, ring.length - 2);
      for (const [lat, lon] of ring) {
        // 座標系検証: PLATEAUは EPSG:6697(緯度経度)。大阪市域の妥当範囲を大きく外れたら異常。
        if (lat < 30 || lat > 40 || lon < 130 || lon > 140) {
          throw new Error(`座標系が想定外です(lat=${lat}, lon=${lon})。EPSG:6697(緯度経度)を想定しています。`);
        }
        const { x, z } = geoToLocal(lat, lon, projection);
        hasCoords = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
  }
  return {
    id,
    surfaceCount,
    surfacesByKind,
    triangleCountApprox: triangles,
    localBounds: hasCoords ? { minX, maxX, minZ, maxZ } : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = await loadDataset(DATASET_ID);
  const area = args.area || dataset.targetArea;
  const year = args.year || dataset.defaultYear;
  const meshes = (args.mesh ? args.mesh.split(',') : dataset.targetMeshes).map((s) => s.trim()).filter(Boolean);

  const areaConfig = await loadAreaConfig(area);
  const gmlDir = lod2RawGmlDir(area, year);
  if (!existsSync(gmlDir)) {
    fail(`GMLディレクトリがありません: ${toProjectRelativePath(gmlDir)}\n` +
      `先に tools/download/plateau-buildings-lod2.js を実行してください。`);
  }

  await ensureDir(lod2GeometryReportDir(area, year));

  const allGml = (await readdir(gmlDir)).filter((f) => f.toLowerCase().endsWith('.gml'));
  let grandLod2 = 0;

  for (const mesh of meshes) {
    const meshGml = allGml.filter((f) => f.startsWith(mesh));
    if (meshGml.length === 0) {
      console.log(`[SKIP] メッシュ ${mesh}: GMLがありません。`);
      continue;
    }
    let combined = '';
    for (const f of meshGml) combined += await readFile(path.join(gmlDir, f), 'utf-8');

    const buildings = splitBuildings(combined);
    const report = {
      areaId: area, year, mesh,
      sourceFiles: meshGml,
      projection: areaConfig.projection,
      buildingCount: buildings.length,
      lod2ConvertibleCount: 0,
      totalTrianglesApprox: 0,
      conversionErrors: [],
      meshLocalBounds: null,
      perBuildingSample: [],
      generatedAt: new Date().toISOString(),
    };

    let mMinX = Infinity, mMaxX = -Infinity, mMinZ = Infinity, mMaxZ = -Infinity;

    for (const b of buildings) {
      // LOD2幾何(Roof/Wall/Ground)を持つ建物だけ変換対象
      const geoSummary = summarizeBuildingGeometry(b);
      if (geoSummary.surfaceCount === 0) continue;
      try {
        const conv = convertBuildingGeometry(b, areaConfig.projection);
        if (conv.surfaceCount === 0) continue;
        report.lod2ConvertibleCount++;
        report.totalTrianglesApprox += conv.triangleCountApprox;
        if (conv.localBounds) {
          mMinX = Math.min(mMinX, conv.localBounds.minX);
          mMaxX = Math.max(mMaxX, conv.localBounds.maxX);
          mMinZ = Math.min(mMinZ, conv.localBounds.minZ);
          mMaxZ = Math.max(mMaxZ, conv.localBounds.maxZ);
        }
        if (report.perBuildingSample.length < 20) {
          report.perBuildingSample.push({
            id: conv.id,
            surfaceCount: conv.surfaceCount,
            surfacesByKind: conv.surfacesByKind,
            triangleCountApprox: conv.triangleCountApprox,
          });
        }
      } catch (e) {
        report.conversionErrors.push({ id: geoSummary.id, error: e.message });
      }
    }

    if (report.lod2ConvertibleCount === 0) {
      // 疑似データは作らない。明確に停止。
      fail(`メッシュ ${mesh}: 変換可能なLOD2幾何が0件でした。疑似データは生成しません。\n` +
        `監査結果(processed/.../audit/)を確認し、LOD2整備の有無を再確認してください。`);
    }

    report.meshLocalBounds = Number.isFinite(mMinX)
      ? { minX: mMinX, maxX: mMaxX, minZ: mMinZ, maxZ: mMaxZ }
      : null;

    grandLod2 += report.lod2ConvertibleCount;
    const out = path.join(lod2GeometryReportDir(area, year), `geometry-report-${year}-${mesh}.json`);
    await writeJson(out, report);
    console.log(`  メッシュ ${mesh}: 変換可能${report.lod2ConvertibleCount}棟 / 三角形≈${report.totalTrianglesApprox} ` +
      `/ 変換エラー${report.conversionErrors.length}件 → ${toProjectRelativePath(out)}`);
  }

  console.log(`\n✅ 変換可能性レポートを生成しました（合計 変換可能 ${grandLod2} 棟）。`);
  console.log(`   ※ 本格GLB生成は次段階。今回は座標変換・三角形集計・境界計算までの骨格です。`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}

export { convertBuildingGeometry, main };
