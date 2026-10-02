#!/usr/bin/env node
// tools/validate/road-ribbon.js
// [見た目改善 Mission03] 道路 ribbon validator CLI。
//   roads tile の centerline から road-ribbon.js で ribbon を生成し、構造破綻（巨大三角形・
//   miter runaway・NaN・負の幅・centerlineからの異常逸脱）が無いことを検証する。
//   主要道路（阪神高速・御堂筋・国道等）は name / source way id で audit する。
//
// 実行: node tools/validate/road-ribbon.js
//       node tools/validate/road-ribbon.js --roots public/map-data/osaka-city/roads

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { computeRoadWidth, buildRoadRibbon, validateRoadRibbon } from '../lib/road-ribbon.js';
import { classifyRoadLod } from '../lib/road-lod.js';

const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const AUDIT_NAME_PATTERNS = ['阪神高速', '新御堂筋', '御堂筋', '中央大通', '長居公園通', '国道1号', '国道25号', '国道43号'];

function parseArgs(argv) {
  const a = { roads: path.join('public', 'map-data', 'osaka-city', 'roads'), report: path.join('data', 'reports', 'road-ribbon-validation.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--roads') a.roads = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

function loadRoadFeatures(dir) {
  const byId = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind === 'line' && !byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  return [...byId.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveProjectPath(args.roads);
  if (!fs.existsSync(dir)) {
    console.error(`[road-ribbon-validate] roads tile ディレクトリが見つかりません: ${toProjectRelativePath(dir)}`);
    process.exitCode = 1;
    return;
  }
  const feats = loadRoadFeatures(dir);
  console.log(`[road-ribbon-validate] roads=${feats.length}（id重複排除済み）`);

  const errors = [], warns = [];
  const byClass = { major: 0, mid: 0, local: 0 };
  let totalTriangles = 0, maxEdgeSeen = 0, bboxViolations = 0;
  const audit = AUDIT_NAME_PATTERNS.map((p) => ({ pattern: p, features: [] }));

  for (const f of feats) {
    byClass[classifyRoadLod(f.highway || '')]++;
    const wr = computeRoadWidth(f);
    const ribbon = buildRoadRibbon(f.p, wr.width, {});
    const item = { id: f.id, name: f.name || '', highway: f.highway, source: f.source || null, width: wr.width, widthMethod: wr.method, ...ribbon };
    if (!ribbon.ok) { errors.push(`[${f.name || f.id}] ribbon生成失敗: ${ribbon.reason}`); continue; }
    totalTriangles += ribbon.triangleCount;
    if (ribbon.maxTriangleEdge > maxEdgeSeen) maxEdgeSeen = ribbon.maxTriangleEdge;
    const v = validateRoadRibbon(item);
    for (const e of v.errors) errors.push(e);
    for (const w of v.warns) warns.push(w);
    // 市外bbox逸脱（centerlineは既に24区ward-clip済みだがribbon offset後を再確認）
    if (ribbon.bbox) {
      const b = ribbon.bbox, m = 800;
      const over = Math.max(0, OSAKA_CITY_BBOX.minX - m - b.minX, b.maxX - (OSAKA_CITY_BBOX.maxX + m), OSAKA_CITY_BBOX.minZ - m - b.minZ, b.maxZ - (OSAKA_CITY_BBOX.maxZ + m));
      if (over > 0) { bboxViolations++; errors.push(`[${f.name || f.id}] ribbon bboxが大阪市外接矩形+${m}mを${Math.round(over)}mはみ出す`); }
    }
    for (const a of audit) {
      if (f.name && f.name.includes(a.pattern)) {
        a.features.push({ id: f.id, name: f.name, highway: f.highway, sourceId: f.source && `${f.source.type}/${f.source.id}`, width: wr.width, widthMethod: wr.method, segmentCount: (f.p || []).length - 1, triangleCount: ribbon.triangleCount, maxTriangleEdge: Math.round(ribbon.maxTriangleEdge) });
      }
    }
  }

  console.log(`  feature: major=${byClass.major} mid=${byClass.mid} local=${byClass.local}`);
  console.log(`  triangles合計=${totalTriangles} / maxTriangleEdge=${Math.round(maxEdgeSeen)}m / error=${errors.length} warn=${warns.length} bboxViolations=${bboxViolations}`);
  console.log('  -- 主要道路 audit --');
  for (const a of audit) {
    if (!a.features.length) { console.log(`  [--] ${a.pattern}: 該当なし`); continue; }
    const errN = a.features.filter((x) => x.maxTriangleEdge > 2000).length;
    console.log(`  [${errN ? 'FAIL' : 'PASS'}] ${a.pattern}: ${a.features.length}本 / widthMethod=${[...new Set(a.features.map((x) => x.widthMethod))].join(',')} / maxTriangleEdge=${Math.max(...a.features.map((x) => x.maxTriangleEdge))}m`);
  }
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log(`  -- warns (${warns.length}件、先頭10) --`); for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(), roadsDir: toProjectRelativePath(dir),
    roadCount: feats.length, byClass, totalTriangles, maxTriangleEdgeM: Math.round(maxEdgeSeen),
    errorCount: errors.length, warnCount: warns.length, bboxViolations,
    errors, warns: warns.slice(0, 50),
    audit: audit.map((a) => ({ pattern: a.pattern, count: a.features.length, features: a.features })),
  };
  const reportPath = resolveProjectPath(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[road-ribbon-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
