#!/usr/bin/env node
// tools/ingest/n03-administrative-boundaries.js
// 実行: node tools/ingest/n03-administrative-boundaries.js --input <path-to-n03-geojson>
//   [--area <areaId>] [--output <path>] [--license <license>] [--source-name <name>]
//   [--provider <name>] [--reference-date <YYYY-MM-DD>] [--retrieved-url <url>] [--retrieved-at <ISO日時>]
//
// 国土交通省「国土数値情報 N03 行政区域データ」から、大阪市24区分の行政区域外周ポリゴンを取り込む
// (AUTODEV_REPORT.md 2026-08-26 USER_DECISION参照: canonical sourceとして採用が確定している)。
//
// 【現段階のスコープ】実N03データの取得を待たず、まずschema検証・取り込みロジック自体を
// synthetic fixtureで検証する小さな実装(P1-1 continuation)。--areaを指定しない場合はWGS84の
// 生geometryのまま構造検証のみ行い、Three.js座標へは変換しない(config/areas/osaka-city.jsonが
// まだ存在しない/確定していないため)。--areaを指定した場合のみ、指定エリアのprojectionで
// 座標変換する(検証・実験用途)。本ツールはproduction area(config/areas/osaka-sumiyoshi.json等)
// を書き換えない。
import { readFile } from 'fs/promises';
import path from 'path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { toProjectRelativePath, resolveProjectPath } from '../lib/paths.js';
import { ingestN03FeatureCollection } from '../lib/n03-boundaries.js';

function parseArgs(argv) {
  const args = {
    input: null, area: null, output: null, license: null,
    sourceName: '国土数値情報 N03 行政区域データ', provider: '国土交通省',
    referenceDate: null, retrievedUrl: null, retrievedAt: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    if (argv[i] === '--area') args.area = argv[++i];
    if (argv[i] === '--output') args.output = argv[++i];
    if (argv[i] === '--license') args.license = argv[++i];
    if (argv[i] === '--source-name') args.sourceName = argv[++i];
    if (argv[i] === '--provider') args.provider = argv[++i];
    if (argv[i] === '--reference-date') args.referenceDate = argv[++i];
    if (argv[i] === '--retrieved-url') args.retrievedUrl = argv[++i];
    if (argv[i] === '--retrieved-at') args.retrievedAt = argv[++i];
  }
  return args;
}

async function loadWardRegistry() {
  const registryPath = resolveProjectPath(path.join('config', 'wards', 'registry.json'));
  const raw = await readFile(registryPath, 'utf-8');
  return JSON.parse(raw);
}

async function main(args) {
  if (!args.input) {
    throw new Error('使用法: node tools/ingest/n03-administrative-boundaries.js --input <path-to-n03-geojson> [--area <areaId>] [--output <path>]');
  }

  console.log('=== N03行政区域データ取り込み(大阪市24区) ===');
  console.log(`入力: ${args.input}`);

  const registry = await loadWardRegistry();

  let projection = null;
  if (args.area) {
    const areaConfig = await loadAreaConfig(args.area);
    projection = areaConfig.projection;
    if (!projection) {
      throw new Error(`config/areas/${args.area}.json に projection 設定がありません。`);
    }
    console.log(`座標変換: --area ${args.area} のprojectionを使用(検証用途。production areaのosaka-city.json確定後に正式運用する)`);
  } else {
    console.log('座標変換: なし(WGS84のまま構造検証のみ実施。config/areas/osaka-city.json確定後に有効化予定)');
  }

  const raw = await readFile(resolveProjectPath(args.input), 'utf-8');
  const geojson = JSON.parse(raw);

  const result = ingestN03FeatureCollection(geojson, registry, { projection });

  console.log(`取り込み件数(大阪市24区分): ${result.recordCount}`);
  console.log(`対象外(大阪市24区以外)件数: ${result.outOfScopeCount}`);
  if (result.missingWards.length > 0) {
    console.log(`未取得の区(${result.missingWards.length}区): ${result.missingWards.map((w) => w.name).join('、')}`);
  }

  if (args.output) {
    const outputPath = resolveProjectPath(args.output);
    const payload = {
      records: result.records,
      metadata: {
        source: args.sourceName,
        provider: args.provider,
        license: args.license,
        referenceDate: args.referenceDate,
        retrievedUrl: args.retrievedUrl,
        retrievedAt: args.retrievedAt,
        accuracyNote: '国土数値情報の行政区域データは測量法上の位置精度に関する注記に従うこと。詳細は取得元メタデータを参照。',
        missingWards: result.missingWards,
      },
    };
    await writeJson(outputPath, payload);
    console.log(`保存先: ${toProjectRelativePath(outputPath)}`);
  } else {
    console.log('(--output未指定のため、ファイルへの保存は行っていません)');
  }

  return result;
}

const args = parseArgs(process.argv.slice(2));
main(args).catch((err) => {
  console.error('N03データ取り込みでエラーが発生しました:', err.message);
  process.exit(1);
});
