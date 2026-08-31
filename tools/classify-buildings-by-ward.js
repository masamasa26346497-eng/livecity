#!/usr/bin/env node
// tools/classify-buildings-by-ward.js
// P1-3: 建物（znorth-neg-v1 JSONL）を N03 Ward polygon へ point-in-polygon 分類し、
// building.ward 属性との一致状況をレポートする（属性は診断専用。分類には使わない）。
//
// 実行:
//   node tools/classify-buildings-by-ward.js --buildings temp/ward-poc-all-buildings.jsonl
//   node tools/classify-buildings-by-ward.js --buildings <jsonl> --ward-polygons <json> --report <path> [--limit N]
//
// 次工程（P1-4）は本ツールの分類結果（buildingId → wardId）を入力に区別dataset/tileを生成する。
// 本ツールは building dataset を書き出さない。

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { writeJson } from './lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from './lib/paths.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';
import { representativePoint } from './lib/building-representative-point.js';

function parseArgs(argv) {
  const args = { buildings: null, wardPolygons: null, report: null, limit: 0, jsonlOut: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--buildings') args.buildings = argv[++i];
    else if (argv[i] === '--ward-polygons') args.wardPolygons = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--jsonl-out') args.jsonlOut = argv[++i];
  }
  return args;
}

async function loadRegistry() {
  const p = resolveProjectPath(path.join('config', 'wards', 'registry.json'));
  return JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.buildings) {
    console.error('使用法: node tools/classify-buildings-by-ward.js --buildings <jsonl> [--ward-polygons <json>] [--report <path>] [--limit N]');
    process.exit(1);
  }
  const buildingsPath = resolveProjectPath(args.buildings);
  const wpPath = resolveProjectPath(args.wardPolygons ||
    path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));

  const wp = JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, ''));
  const wards = wp.wards;
  const registry = await loadRegistry();
  const nameToId = new Map(registry.wards.map((w) => [w.name, w.id]));

  const counts = {};
  for (const w of wards) counts[w.wardId] = 0;
  let total = 0, outsideCity = 0, ambiguous = 0, boundaryResolved = 0, invalid = 0;
  const methodCounts = { centroid: 0, 'interior-scanline': 0, 'bbox-center': 0, 'vertex-mean': 0 };
  let hasWardAttr = 0, attrMatch = 0, attrMismatch = 0, attrOutsideCity = 0;
  const mismatchSamples = [];
  // 既存3区: 属性が示す区ごとに、N03分類の内訳
  const KNOWN = { sumiyoshi: '住吉区', higashisumiyoshi: '東住吉区', hirano: '平野区' };
  const knownBreakdown = {};
  for (const id of Object.keys(KNOWN)) knownBreakdown[id] = { attrCount: 0, n03Same: 0, n03Other: {}, n03OutsideCity: 0, n03Ambiguous: 0 };

  const jsonlOut = args.jsonlOut ? fs.createWriteStream(resolveProjectPath(args.jsonlOut)) : null;

  const rl = readline.createInterface({ input: fs.createReadStream(buildingsPath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    total++;
    if (args.limit && total > args.limit) { total--; break; }

    let b;
    try { b = JSON.parse(s); } catch { invalid++; continue; }
    if (!b || !Array.isArray(b.fp) || b.fp.length < 3) { invalid++; outsideCity++; continue; }

    const rp = representativePoint(b.fp);
    methodCounts[rp.method] = (methodCounts[rp.method] || 0) + 1;
    if (!rp.valid) { invalid++; outsideCity++; continue; }

    const res = classifyPointToWard(rp.x, rp.z, wards);
    let n03Id = res.wardId;
    if (res.status === 'boundary-resolved') boundaryResolved++;
    if (n03Id) counts[n03Id]++;
    else if (res.status === 'ambiguous') ambiguous++;
    else outsideCity++;

    if (jsonlOut) jsonlOut.write(JSON.stringify({ id: b.id, wardId: n03Id, status: res.status, x: rp.x, z: rp.z, method: rp.method }) + '\n');

    // ── 診断: building.ward 属性との一致（分類には無関係） ──
    if (Object.prototype.hasOwnProperty.call(b, 'ward') && b.ward) {
      hasWardAttr++;
      const attrId = nameToId.get(b.ward) || null;
      if (attrId && attrId === n03Id) attrMatch++;
      else if (!n03Id) attrOutsideCity++;
      else {
        attrMismatch++;
        if (mismatchSamples.length < 40) {
          mismatchSamples.push({ id: b.id, attrWard: b.ward, n03Ward: n03Id ? wardName(wards, n03Id) : res.status, x: rp.x, z: rp.z });
        }
      }
      if (KNOWN[attrId]) {
        const kb = knownBreakdown[attrId];
        kb.attrCount++;
        if (n03Id === attrId) kb.n03Same++;
        else if (!n03Id && res.status === 'ambiguous') kb.n03Ambiguous++;
        else if (!n03Id) kb.n03OutsideCity++;
        else kb.n03Other[n03Id] = (kb.n03Other[n03Id] || 0) + 1;
      }
    }
  }
  if (jsonlOut) jsonlOut.end();

  const classifiedSum = Object.values(counts).reduce((a, b) => a + b, 0);
  const invariant = classifiedSum + outsideCity + ambiguous === total;

  console.log('=== 建物 → N03 Ward 分類 ===');
  console.log(`建物: ${toProjectRelativePath(buildingsPath)}`);
  console.log(`Ward polygon: ${toProjectRelativePath(wpPath)}`);
  console.log(`総数: ${total}`);
  console.log('');
  for (const w of wards) {
    if (counts[w.wardId] > 0) console.log(`  ${w.wardName.padEnd(6)}: ${counts[w.wardId]}`);
  }
  console.log('');
  console.log(`  区外(outsideCity): ${outsideCity}`);
  console.log(`  ambiguous: ${ambiguous}`);
  console.log(`  境界揺らしで解決(boundary-resolved): ${boundaryResolved}`);
  console.log(`  不正データ: ${invalid}`);
  console.log(`  恒等式 (Σ区 + 区外 + ambiguous === 総数): ${invariant}`);
  console.log('');
  console.log('  代表点method:', JSON.stringify(methodCounts));
  console.log('');
  console.log('=== building.ward 属性との一致（診断専用・分類には未使用） ===');
  console.log(`  属性あり: ${hasWardAttr} / 一致: ${attrMatch} / 不一致: ${attrMismatch} / 属性は区名だがN03は区外: ${attrOutsideCity}`);
  console.log('');
  console.log('=== 既存3区: building.ward 属性が示す区 → N03分類の内訳 ===');
  for (const [id, name] of Object.entries(KNOWN)) {
    const kb = knownBreakdown[id];
    const agree = kb.attrCount ? ((kb.n03Same / kb.attrCount) * 100).toFixed(1) : 'n/a';
    console.log(`  ${name}: 属性${kb.attrCount}棟 → N03一致 ${kb.n03Same}(${agree}%) / 他区 ${JSON.stringify(kb.n03Other)} / 区外 ${kb.n03OutsideCity} / ambiguous ${kb.n03Ambiguous}`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, {
      generatedAt: new Date().toISOString(),
      buildings: toProjectRelativePath(buildingsPath),
      wardPolygons: toProjectRelativePath(wpPath),
      total, counts, outsideCity, ambiguous, boundaryResolved, invalid, invariant,
      methodCounts,
      attr: { hasWardAttr, attrMatch, attrMismatch, attrOutsideCity, mismatchSamples },
      knownWardBreakdown: knownBreakdown,
    });
    console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
  }
  process.exit(invariant ? 0 : 1);
}

function wardName(wards, id) {
  const w = wards.find((x) => x.wardId === id);
  return w ? w.wardName : id;
}

main().catch((err) => {
  console.error('建物分類でエラー:', err.message);
  process.exit(1);
});
