#!/usr/bin/env node
// tools/validate/water-geometry.js
// 河川・水域データ（OSM_WATER 形式）の幾何異常検証。
//
// 実行:
//   node tools/validate/water-geometry.js --input <osm-water.json>
//   node tools/validate/water-geometry.js --html public/osaka_3d_buildings.html
//   node tools/validate/water-geometry.js --html public/osaka_3d_buildings.html --report data/reports/water-geometry-validation.json
//
// 「川面を横断する巨大三角形」の原因になる巨大セグメント・自己交差・退化リング・非有限座標を、
// 三角形分割前に検出する。error 重大度の失敗があれば exit code 1。

import { readFile } from 'fs/promises';
import path from 'path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateWaterGeometry } from '../lib/water-geometry-validator.js';

function parseArgs(argv) {
  const args = { input: null, html: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--html') args.html = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
  }
  return args;
}

// HTML から `const OSM_WATER = [...]` のリテラル配列を括弧の対応で抜き出す。
function extractOsmWaterFromHtml(html) {
  const marker = 'const OSM_WATER = ';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('HTML内に const OSM_WATER = が見つかりません。');
  const open = html.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return JSON.parse(html.slice(open, i + 1)); }
  }
  throw new Error('OSM_WATER の配列リテラルが閉じていません。');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let items;
  let sourceLabel;
  if (args.input) {
    items = JSON.parse(await readFile(resolveProjectPath(args.input), 'utf-8'));
    sourceLabel = args.input;
  } else if (args.html) {
    const html = await readFile(resolveProjectPath(args.html), 'utf-8');
    items = extractOsmWaterFromHtml(html);
    sourceLabel = args.html;
  } else {
    console.error('使用法: node tools/validate/water-geometry.js (--input <json> | --html <path>) [--report <path>]');
    process.exit(1);
  }

  const result = validateWaterGeometry(items);

  console.log('=== 河川・水域 幾何検証 ===');
  console.log(`入力: ${sourceLabel}`);
  console.log(`要素: ${result.summary.total}（面 ${result.summary.areas} / 線 ${result.summary.lines}）`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }
  if (result.offenders.length) {
    console.log('\n異常のある要素:');
    for (const o of result.offenders.slice(0, 40)) {
      console.log(`  ${o.label} [${o.subtype || o.kind}] pts=${o.points} oversizedSeg=${o.oversizedSegments} selfInt=${o.selfIntersections} nonFinite=${o.nonFiniteCoords}${o.degenerate ? ' DEGENERATE' : ''}`);
    }
    if (result.offenders.length > 40) console.log(`  ... 他 ${result.offenders.length - 40}件`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, { generatedAt: new Date().toISOString(), source: sourceLabel, ...result });
    console.log(`\n検証結果を保存: ${toProjectRelativePath(reportPath)}`);
  }
  console.log(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('河川・水域検証でエラーが発生しました:', err.message);
  process.exit(1);
});
