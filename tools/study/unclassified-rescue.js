#!/usr/bin/env node
// tools/study/unclassified-rescue.js
// P1-5 #5: 代表点がどの区にも入らなかった unclassified 建物について、
// 「footprint と Ward polygon の面積重複」でどれだけ救済できるか調査する。
//
// これは調査スクリプト。dataset は書き換えない。結果は data/reports/unclassified-rescue-study.json へ。
//
// 実行:
//   node tools/study/unclassified-rescue.js
//   node tools/study/unclassified-rescue.js --datasets public/map-data/osaka-city/buildings \
//     --ward-polygons public/map-data/osaka-city/boundaries/ward-classification-polygons.json --min-coverage 0.5

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { rescueByFootprintOverlap } from '../lib/footprint-ward-overlap.js';

function parseArgs(argv) {
  const a = { datasets: null, wardPolygons: null, minCoverage: 0.5, grid: 12 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--datasets') a.datasets = argv[++i];
    else if (argv[i] === '--ward-polygons') a.wardPolygons = argv[++i];
    else if (argv[i] === '--min-coverage') a.minCoverage = parseFloat(argv[++i]);
    else if (argv[i] === '--grid') a.grid = parseInt(argv[++i], 10) || 12;
  }
  return a;
}

function* iterUnclassifiedBuildings(datasetRoot) {
  const dir = path.join(datasetRoot, 'unclassified');
  for (const sub of [path.join(dir, 'tiles'), dir]) {
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf-8'));
      for (const b of (t.buildings || [])) yield b;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = resolveProjectPath(args.datasets || path.join('public', 'map-data', 'osaka-city', 'buildings'));
  const wpPath = resolveProjectPath(args.wardPolygons || path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  const wards = JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, '')).wards;

  let total = 0, rescuable = 0, stillUnclassified = 0;
  const rescuedByWard = {};
  const coverageBuckets = { '0.5-0.7': 0, '0.7-0.9': 0, '0.9-1.0': 0 };
  const noOverlap = [];
  const rescuedVsReason = {};
  const samples = [];

  for (const b of iterUnclassifiedBuildings(datasetRoot)) {
    if (b.unclassifiedReason === 'ambiguous') continue; // ambiguous は別問題（複数区に入る）
    total++;
    const r = rescueByFootprintOverlap(b.fp, wards, { grid: args.grid, minCoverage: args.minCoverage });
    if (r.wardId) {
      rescuable++;
      rescuedByWard[r.wardId] = (rescuedByWard[r.wardId] || 0) + 1;
      const c = r.coverage;
      if (c >= 0.9) coverageBuckets['0.9-1.0']++;
      else if (c >= 0.7) coverageBuckets['0.7-0.9']++;
      else coverageBuckets['0.5-0.7']++;
      const rk = b.unclassifiedReason || 'unknown';
      rescuedVsReason[rk] = (rescuedVsReason[rk] || 0) + 1;
      if (samples.length < 30) samples.push({ id: b.id, rescueWard: r.wardId, coverage: r.coverage, nearestWardId: b.nearestWardId, nearestWardDistance: b.nearestWardDistance });
    } else {
      stillUnclassified++;
      if (r.coverage === 0 && noOverlap.length < 30) noOverlap.push({ id: b.id, nearestWardId: b.nearestWardId, nearestWardDistance: b.nearestWardDistance });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    datasetRoot: toProjectRelativePath(datasetRoot),
    wardPolygons: toProjectRelativePath(wpPath),
    params: { minCoverage: args.minCoverage, grid: args.grid },
    method: 'footprint bbox grid-sampling で footprint と Ward polygon の面積重複率を近似。'
      + `重なり率 >= ${args.minCoverage} の区へ救済分類できるとみなす（実データセットは書き換えていない）。`,
    unclassifiedOutside: total,
    rescuable,
    rescuablePct: total ? Math.round((rescuable / total) * 10000) / 100 : 0,
    stillUnclassifiedAfterRescue: stillUnclassified,
    rescuedByWard,
    coverageBuckets,
    rescuedVsReason,
    rescueSamples: samples,
    noOverlapSamples: noOverlap,
    recommendation: rescuable / Math.max(1, total) > 0.5
      ? 'P1-5 表示では代表点分類のみを正本とし、この救済分類はP1-6以降で dataset 生成側へ組み込む余地がある（footprint-overlap を分類パイプラインの step2 に追加）。'
      : '救済率が低い。unclassified は別レイヤー表示 or 非表示のままとし、P1-6 で PLATEAU 側の境界超過の実態を確認する。',
  };
  const reportPath = resolveProjectPath(path.join('data', 'reports', 'unclassified-rescue-study.json'));
  await writeJson(reportPath, report);

  console.log('=== unclassified 救済分類 調査（footprint × Ward polygon 面積重複）===');
  console.log(`対象（区外 unclassified、ambiguous除く）: ${total}`);
  console.log(`救済可能（重なり率 >= ${args.minCoverage}）: ${rescuable} (${report.rescuablePct}%)`);
  console.log(`救済後も unclassified: ${stillUnclassified}`);
  console.log(`重なり率内訳: ${JSON.stringify(coverageBuckets)}`);
  console.log(`救済先区（上位）: ${JSON.stringify(Object.fromEntries(Object.entries(rescuedByWard).sort((a, b) => b[1] - a[1]).slice(0, 8)))}`);
  console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
}

main().catch((err) => { console.error('調査でエラー:', err.message, err.stack); process.exit(1); });
