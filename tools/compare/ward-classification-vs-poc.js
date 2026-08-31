#!/usr/bin/env node
// tools/compare/ward-classification-vs-poc.js
// P1-3 タスク5: 既存3区（住吉区・東住吉区・平野区）の ward-poc dataset の建物を、
// 新しい N03 point-in-polygon 方式で再判定し、大規模な不一致が無いかレポートする。
//
// 既存 ward-poc dataset は tools/build-ward-poc-data.cjs が TOWN_POLYGONS（legacy-unverified、
// ただし znorth-neg-v1 の座標系リファレンス）で分類したもの。ここでは
//   pocWardId（TOWN_POLYGONS由来）  vs  n03WardId（N03公式境界由来）
// を建物ごとに突き合わせる。building.ward 属性は一切使わない。
//
// 実行:
//   node tools/compare/ward-classification-vs-poc.js
//   node tools/compare/ward-classification-vs-poc.js --poc-dir public/__test__/ward-poc/buildings \
//     --ward-polygons data/processed/osaka-city/boundaries/ward-classification-polygons.json --report <path>

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { representativePoint } from '../lib/building-representative-point.js';

const POC_DATASETS = {
  'osaka-sumiyoshi': 'sumiyoshi',
  'osaka-higashisumiyoshi': 'higashisumiyoshi',
  'osaka-hirano': 'hirano',
};

function parseArgs(argv) {
  const a = { pocDir: null, wardPolygons: null, report: null, sampleLimit: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--poc-dir') a.pocDir = argv[++i];
    else if (argv[i] === '--ward-polygons') a.wardPolygons = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
    else if (argv[i] === '--sample-limit') a.sampleLimit = parseInt(argv[++i], 10) || 40;
  }
  return a;
}

function* iterateTiles(datasetDir) {
  for (const f of fs.readdirSync(datasetDir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const tile = JSON.parse(fs.readFileSync(path.join(datasetDir, f), 'utf-8'));
    for (const b of (tile.buildings || [])) yield b;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pocDir = resolveProjectPath(args.pocDir || path.join('public', '__test__', 'ward-poc', 'buildings'));
  const wpPath = resolveProjectPath(args.wardPolygons ||
    path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));

  const wp = JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, ''));
  const wards = wp.wards;

  const perWard = {};
  const samples = [];
  let total = 0;

  for (const [datasetId, pocWardId] of Object.entries(POC_DATASETS)) {
    const dir = path.join(pocDir, datasetId);
    if (!fs.existsSync(dir)) { console.warn(`[skip] ${datasetId}: ${dir} が無い`); continue; }
    const stat = perWard[pocWardId] = { pocWardId, count: 0, agree: 0, toOtherWard: {}, toOutside: 0, toAmbiguous: 0, boundaryResolved: 0 };
    for (const b of iterateTiles(dir)) {
      if (!b || !Array.isArray(b.fp) || b.fp.length < 3) continue;
      total++;
      stat.count++;
      const rp = representativePoint(b.fp);
      const res = classifyPointToWard(rp.x, rp.z, wards);
      if (res.status === 'boundary-resolved') stat.boundaryResolved++;
      if (res.wardId === pocWardId) stat.agree++;
      else if (!res.wardId && res.status === 'ambiguous') stat.toAmbiguous++;
      else if (!res.wardId) stat.toOutside++;
      else {
        stat.toOtherWard[res.wardId] = (stat.toOtherWard[res.wardId] || 0) + 1;
        if (samples.length < args.sampleLimit) {
          samples.push({ id: b.id, pocWard: pocWardId, n03Ward: res.wardId, x: rp.x, z: rp.z, method: rp.method });
        }
      }
    }
  }

  console.log('=== 既存3区 ward-poc(TOWN_POLYGONS) vs N03 point-in-polygon ===');
  console.log(`ward-poc: ${toProjectRelativePath(pocDir)}`);
  console.log(`N03 polygons: ${toProjectRelativePath(wpPath)}`);
  console.log(`対象建物: ${total}`);
  console.log('');
  let worstRate = 0;
  for (const s of Object.values(perWard)) {
    const rate = s.count ? (s.agree / s.count) * 100 : 0;
    worstRate = Math.max(worstRate, 100 - rate);
    console.log(`  ${s.pocWardId}: ${s.count}棟 / N03一致 ${s.agree} (${rate.toFixed(2)}%)`);
    console.log(`     → 他区 ${JSON.stringify(s.toOtherWard)} / 区外 ${s.toOutside} / ambiguous ${s.toAmbiguous} / 境界解決 ${s.boundaryResolved}`);
  }
  console.log('');
  const disagreeTotal = Object.values(perWard).reduce((a, s) => a + (s.count - s.agree), 0);
  const disagreeRate = total ? (disagreeTotal / total) * 100 : 0;
  console.log(`不一致: ${disagreeTotal} / ${total} (${disagreeRate.toFixed(2)}%)`);
  // 隣接区への染み出しは境界の帯状にしか起きないはず。10%超なら座標系/境界データの問題を疑う。
  const verdict = disagreeRate < 3 ? 'OK（境界帯の軽微な差のみ）'
    : disagreeRate < 10 ? 'CHECK（想定よりやや多い。境界付近の分布を確認）'
    : 'LARGE_MISMATCH（座標系・境界データ・代表点のいずれかを要調査）';
  console.log(`判定: ${verdict}`);
  if (samples.length) {
    console.log('\n不一致サンプル:');
    for (const s of samples.slice(0, 20)) console.log(`  ${s.id} poc=${s.pocWard} n03=${s.n03Ward} (${s.x},${s.z}) ${s.method}`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, {
      generatedAt: new Date().toISOString(),
      pocDir: toProjectRelativePath(pocDir), wardPolygons: toProjectRelativePath(wpPath),
      total, disagreeTotal, disagreeRate, verdict, perWard, samples,
    });
    console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
  }
  process.exit(disagreeRate < 10 ? 0 : 1);
}

main().catch((err) => { console.error('比較でエラー:', err.message); process.exit(1); });
