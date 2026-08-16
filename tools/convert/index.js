#!/usr/bin/env node
// tools/convert/index.js
// 実行: node tools/convert/index.js --area osaka-sumiyoshi
//
// data/raw の生データを読み込み、座標系・属性・IDを統一し、重複を除去した上で
// data/processed と public/map-data の両方へ出力する。最後に検証とマニフェスト生成を行う。
// このスクリプト自体はネットワークアクセスを行わないため、Claude Code環境でも実行・検証できる
// （data/rawに何らかのデータが既に存在していれば、fixtureとして使ってテストできる）。

import path from 'path';
import { statSync } from 'fs';
import crypto from 'crypto';
import { isMainModule } from '../lib/paths.js';
import {
  loadAreaConfig, rawDir, processedDir, publicMapDataDir, manifestPath,
  readJsonIfExists, writeJson, writeJsonCompact, ensureDir,
} from '../lib/area.js';
import { convertRoads } from './roads.js';
import { convertParks } from './parks.js';
import { convertFacilities } from './facilities.js';
import { convertRailways } from './railways.js';
import { convertWaterways } from './waterways.js';
import { validateLayer } from '../lib/validate.js';

function parseArgs(argv) {
  const args = { area: null, layers: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--layers') args.layers = argv[++i].split(',').map((s) => s.trim());
  }
  return args;
}

// 座標配列からIDを決定的に生成する（同じ形状なら常に同じIDになる。乱数は使わない）。
function assignId(prefix, item) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(item.p || item)).digest('hex').slice(0, 12);
  return `${prefix}_${hash}`;
}

const CONVERTERS = {
  roads: (raw, projection) => convertRoads(raw.elements || [], projection).map((r) => ({ ...r, id: assignId('road', r) })),
  parks: (raw, projection) => convertParks(raw.elements || [], projection).map((p) => ({ ...p, id: assignId('park', p) })),
  facilities: (raw, projection) => convertFacilities(raw.elements || [], projection).map((f) => ({ ...f, id: assignId('facility', f) })),
  railways: (raw, projection) => {
    const { lines, stations } = convertRailways(raw.elements || [], projection);
    return {
      lines: lines.map((l) => ({ ...l, id: assignId('rail', l) })),
      stations: stations.map((s) => ({ ...s, id: assignId('station', s) })),
    };
  },
  waterways: (raw, projection) => convertWaterways(raw.elements || [], projection).map((w) => ({ ...w, id: assignId('water', w) })),
};

async function processLayer(areaId, areaConfig, layerName, layerConfig) {
  const rawPath = path.join(rawDir(areaId), layerConfig.outputFile);
  const raw = await readJsonIfExists(rawPath);

  if (layerConfig.source === 'manual-upload') {
    const manualPath = path.join(rawDir(areaId), layerConfig.outputFile);
    const manualData = await readJsonIfExists(manualPath);
    if (!manualData) {
      console.log(`[SKIP] ${layerName}: 手動アップロードデータが見つかりません (${manualPath})`);
      console.log(`       ${layerConfig.note || ''}`);
      return { layerName, status: 'missing-manual-data' };
    }
    // 手動データは既にLiveCity互換形式であることを前提とする（別途フォーマット変換は行わない）
    const outProcessed = path.join(processedDir(areaId), layerConfig.outputFile);
    const outPublic = path.join(publicMapDataDir(areaId), layerConfig.outputFile);
    await writeJson(outProcessed, manualData);
    await writeJsonCompact(outPublic, manualData);
    return { layerName, status: 'processed-manual', data: manualData, outPublic };
  }

  if (!raw) {
    console.log(`[SKIP] ${layerName}: 生データが見つかりません (${rawPath})。先に data:download を実行してください。`);
    return { layerName, status: 'missing-raw-data' };
  }

  const converter = CONVERTERS[layerName];
  if (!converter) {
    console.warn(`[WARN] ${layerName}: 変換ロジックが未実装です。`);
    return { layerName, status: 'no-converter' };
  }

  const converted = converter(raw, areaConfig.projection);
  const outProcessed = path.join(processedDir(areaId), layerConfig.outputFile);
  const outPublic = path.join(publicMapDataDir(areaId), layerConfig.outputFile);
  await writeJson(outProcessed, converted); // 人間が読める整形済み（data/processed = 中間データ確認用）
  await writeJsonCompact(outPublic, converted); // 配信用は圧縮形式（public/map-data = 実際にLiveCityが読み込む）

  console.log(`[OK] ${layerName}: 変換完了 -> ${outPublic}`);
  return { layerName, status: 'processed', data: converted, outPublic };
}

async function main(args) {
  const areaConfig = await loadAreaConfig(args.area);
  console.log(`=== データ変換開始: ${areaConfig.name} (${args.area}) ===`);

  const layerNames = args.layers || Object.keys(areaConfig.layers).filter((k) => areaConfig.layers[k].enabled);
  const results = [];
  for (const layerName of layerNames) {
    const layerConfig = areaConfig.layers[layerName];
    if (!layerConfig) {
      console.warn(`[WARN] 未知のレイヤー指定: ${layerName}`);
      continue;
    }
    const result = await processLayer(args.area, areaConfig, layerName, layerConfig);
    results.push(result);
  }

  // 検証フェーズ
  console.log('\n=== 検証 ===');
  const manifestLayers = {};
  for (const r of results) {
    if (r.status !== 'processed' && r.status !== 'processed-manual') {
      manifestLayers[r.layerName] = { status: r.status };
      continue;
    }
    const fileSize = statSync(r.outPublic).size;
    const validation = validateLayer(r.layerName, r.data, areaConfig, fileSize);
    console.log(`  ${r.layerName}: ${validation.pass ? 'PASS' : 'FAIL'} (${validation.recordCount}件, ${fileSize} bytes)`);
    for (const check of validation.checks) {
      if (!check.pass) console.log(`    ✗ ${check.name}: ${check.detail}`);
    }
    manifestLayers[r.layerName] = {
      status: r.status,
      recordCount: validation.recordCount,
      fileSizeBytes: fileSize,
      outputPath: path.relative(process.cwd(), r.outPublic),
      validation: validation.pass ? 'pass' : 'fail',
      checks: validation.checks,
    };
  }

  // マニフェスト生成
  const manifest = {
    areaId: args.area,
    areaName: areaConfig.name,
    generatedAt: new Date().toISOString(),
    bbox: areaConfig.bbox,
    projection: areaConfig.projection,
    layers: manifestLayers,
  };
  await writeJson(manifestPath(args.area), manifest);
  console.log(`\nマニフェストを生成しました: data/manifests/${args.area}.json`);

  const anyFail = Object.values(manifestLayers).some((l) => l.validation === 'fail');
  if (anyFail) {
    console.error('\n一部のレイヤーで検証に失敗しました。マニフェストを確認してください。');
    process.exitCode = 1;
  }
  return manifest;
}

export async function run(args) {
  if (!args.area) {
    throw new Error('area引数が指定されていません。');
  }
  return main(args);
}

if (isMainModule(import.meta.url)) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (!cliArgs.area) {
    console.error('使用法: node tools/convert/index.js --area <areaId> [--layers a,b]');
    process.exit(1);
  }
  main(cliArgs).catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}
