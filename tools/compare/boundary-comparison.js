#!/usr/bin/env node
// tools/compare/boundary-comparison.js
// 実行: node tools/compare/boundary-comparison.js --area osaka-sumiyoshi
//
// 正式境界データ(data/processed/{areaId}/boundaries/administrative-boundaries.json)と
// 暫定境界データ(TOWN_POLYGONS由来、data/raw/{areaId}/administrative-boundaries.json)を比較し、
// 差異をレポートする。現在のTOWN_POLYGONSを削除する判断材料とするためのもので、
// 本ツール自体はどちらのデータも削除しない。
import path from 'path';
import { readJsonIfExists, writeJson } from '../lib/area.js';
import { officialBoundariesPath, legacyBoundariesPath } from '../lib/boundary-master.js';
import { normalizeChochoName } from '../lib/chocho-normalize.js';
import { toProjectRelativePath } from '../lib/paths.js';

function parseArgs(argv) {
  const args = { area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

/**
 * リング配列(座標の配列の配列)から、シューレース公式でポリゴン面積(㎡相当、Three.js座標系の
 * 平面上での面積)を計算する。MultiPolygon由来の複数リングを持つ場合は合算する。
 * 穴(内側リング)の判定はせず、単純に全リングの面積を加算する近似値とする
 * （厳密なGISライブラリを使わない、軽量な比較用途のため）。
 */
function calculatePolygonArea(rings) {
  if (!rings || rings.length === 0) return 0;
  let total = 0;
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % ring.length];
      area += x1 * z2 - x2 * z1;
    }
    total += Math.abs(area) / 2;
  }
  return total;
}

async function main(args) {
  if (!args.area) throw new Error('--area が指定されていません。');

  console.log(`=== 境界データ比較: ${args.area} ===`);

  const official = (await readJsonIfExists(officialBoundariesPath(args.area))) || [];
  const legacy = (await readJsonIfExists(legacyBoundariesPath(args.area))) || [];

  if (official.length === 0) {
    console.warn('[WARN] 正式境界データが見つかりません。比較できません。');
    console.warn(`       配置先: ${toProjectRelativePath(officialBoundariesPath(args.area))}`);
    return { officialCount: 0, legacyCount: legacy.length, comparable: false };
  }

  const officialByNormalizedName = new Map(official.map((o) => [normalizeChochoName(o.originalFullName || o.boundaryId), o]));
  const legacyByNormalizedName = new Map(legacy.map((l) => [normalizeChochoName(l.originalFullName || l.boundaryId), l]));

  const officialOnly = [];
  const legacyOnly = [];
  const nameMismatches = []; // 正規化後は一致するが、正式名称の表記が異なるもの
  const areaDifferences = []; // 面積差が大きいもの(暫定データはgeometryを持たないため、計算可能な場合のみ)
  const polygonCountDifferences = []; // ポリゴン数(飛び地数)の差

  for (const [key, o] of officialByNormalizedName) {
    const l = legacyByNormalizedName.get(key);
    if (!l) {
      officialOnly.push({ boundaryId: o.boundaryId, chochoName: o.chochoName, ward: o.ward });
      continue;
    }
    if (o.originalFullName && l.originalFullName && o.originalFullName !== l.originalFullName) {
      nameMismatches.push({ official: o.originalFullName, legacy: l.originalFullName });
    }
    if (o.geometry && l.geometry) {
      const officialPolygonCount = o.geometry.length;
      const legacyPolygonCount = l.geometry.length;
      if (officialPolygonCount !== legacyPolygonCount) {
        polygonCountDifferences.push({
          boundaryId: o.boundaryId, officialPolygonCount, legacyPolygonCount,
        });
      }
      const officialArea = calculatePolygonArea(o.geometry);
      const legacyArea = calculatePolygonArea(l.geometry);
      if (legacyArea > 0) {
        const diffRatio = Math.abs(officialArea - legacyArea) / legacyArea;
        if (diffRatio > 0.1) { // 10%以上の面積差を「大きい」とみなす
          areaDifferences.push({
            boundaryId: o.boundaryId, officialArea: Math.round(officialArea), legacyArea: Math.round(legacyArea),
            diffRatioPercent: Math.round(diffRatio * 1000) / 10,
          });
        }
      }
    }
  }

  for (const [key, l] of legacyByNormalizedName) {
    if (!officialByNormalizedName.has(key)) {
      legacyOnly.push({ boundaryId: l.boundaryId, chochoName: l.chochoName, ward: l.ward });
    }
  }

  const report = {
    areaId: args.area,
    generatedAt: new Date().toISOString(),
    officialCount: official.length,
    legacyCount: legacy.length,
    officialOnlyCount: officialOnly.length,
    legacyOnlyCount: legacyOnly.length,
    officialOnly,
    legacyOnly,
    nameMismatches,
    polygonCountDifferences,
    areaDifferences,
  };

  const outputPath = path.resolve(process.cwd(), 'data', 'processed', args.area, 'boundaries', 'town-polygons-comparison-report.json');
  await writeJson(outputPath, report);

  console.log(`正式境界件数: ${report.officialCount}`);
  console.log(`暫定境界(TOWN_POLYGONS)件数: ${report.legacyCount}`);
  console.log(`正式境界にのみ存在: ${report.officialOnlyCount}件`);
  console.log(`TOWN_POLYGONSにのみ存在: ${report.legacyOnlyCount}件`);
  console.log(`名称表記の差異: ${nameMismatches.length}件`);
  console.log(`ポリゴン数の差: ${polygonCountDifferences.length}件`);
  console.log(`面積差10%以上: ${areaDifferences.length}件`);
  console.log(`レポート保存先: ${toProjectRelativePath(outputPath)}`);

  return { ...report, comparable: true };
}

const args = parseArgs(process.argv.slice(2));
main(args).catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
