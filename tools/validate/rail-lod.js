#!/usr/bin/env node
// tools/validate/rail-lod.js
// [見た目改善 Mission13] 鉄道 LOD validator CLI。
//   railways tile の line feature を MAJOR/URBAN/LOCAL に分類し、station node を集計する。
//     - finite coordinates / feature count / duplicate id
//     - classification coverage（MAJOR+URBAN+LOCAL+excluded = 全 line feature）
//     - railway tag coverage（未知タグの検出）
//     - bbox containment（大阪市外接矩形 + margin）
//     - absurdly long segment（本線でも 2000m 超の単一線分は無い）
//     - giant geometry（feature bbox 対角 > 上限）
//     - station node: 座標 finite / name encoding（置換文字 U+FFFD なし）
//
// 実行: node tools/validate/rail-lod.js
//       node tools/validate/rail-lod.js --rail public/map-data/osaka-city/railways

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import {
  classifyRail, railIncluded, polylineLengthXZ, maxSegmentLengthXZ, RAIL_MAJOR_MIN_LEN_M,
} from '../lib/rail-lod.js';

const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const LIMITS = { maxBboxDiagM: 15000, maxSegmentM: 2000, bboxMarginM: 800 };
const KNOWN_TAGS = new Set(['rail', 'subway', 'metro', 'light_rail', 'tram', 'monorail', 'narrow_gauge',
  'construction', 'proposed', 'disused', 'abandoned', 'razed', 'dismantled']);
// 実データ上に存在するはずの主要路線（geometry があれば name 欠落でも可）
const EXPECT_AREAS = ['大阪環状線相当の rail 密集', '御堂筋線相当の subway 縦軸'];

function parseArgs(argv) {
  const a = { rail: path.join('public', 'map-data', 'osaka-city', 'railways'), report: path.join('data', 'reports', 'rail-lod-validation.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rail') a.rail = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

function load(dir) {
  const lineById = new Map(), stById = new Map();
  let dupLine = 0, dupStation = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind === 'station' || ft.kind === 'node') {
        if (stById.has(ft.id)) { dupStation++; continue; }
        stById.set(ft.id, ft);
      } else if (ft.kind === 'line') {
        if (lineById.has(ft.id)) { dupLine++; continue; }
        lineById.set(ft.id, ft);
      }
    }
  }
  return { lines: [...lineById.values()], stations: [...stById.values()], dupLine, dupStation };
}

function ringBbox(pts) {
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const p of pts) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mnz) mnz = p[1]; if (p[1] > mxz) mxz = p[1]; }
  return { minX: mnx, maxX: mxx, minZ: mnz, maxZ: mxz, diag: Math.hypot(mxx - mnx, mxz - mnz) };
}
const finitePts = (p) => Array.isArray(p) && p.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveProjectPath(args.rail);
  if (!fs.existsSync(dir)) { console.error(`[rail-lod-validate] railways tile ディレクトリが見つかりません: ${toProjectRelativePath(dir)}`); process.exitCode = 1; return; }
  const { lines, stations, dupLine, dupStation } = load(dir);
  console.log(`[rail-lod-validate] line=${lines.length} station=${stations.length}（重複 line ${dupLine} / station ${dupStation} スキップ）`);

  const errors = [], warns = [];
  const byClass = { major: 0, urban: 0, local: 0, excluded: 0 };
  const byTag = {};
  let nonFiniteCoord = 0, giantGeom = 0, longSeg = 0, bboxViolations = 0;
  let totalLenM = 0, maxSegSeen = 0;

  for (const f of lines) {
    const tag = String(f.railway || '(none)').toLowerCase();
    byTag[tag] = (byTag[tag] || 0) + 1;
    if (!KNOWN_TAGS.has(tag) && tag !== '(none)') warns.push(`未知の railway tag: ${tag} (${f.id})`);
    if (!finitePts(f.p) || f.p.length < 2) { nonFiniteCoord++; errors.push(`[${f.id}] 座標が非有限 or 頂点<2`); byClass.local++; continue; }
    if (!railIncluded(f.railway)) { byClass.excluded++; continue; }
    const len = polylineLengthXZ(f.p);
    totalLenM += len;
    byClass[classifyRail(f.railway, len)]++;
    const seg = maxSegmentLengthXZ(f.p);
    if (seg > maxSegSeen) maxSegSeen = seg;
    if (seg > LIMITS.maxSegmentM) { longSeg++; warns.push(`[${f.id}] 単一線分 ${Math.round(seg)}m > ${LIMITS.maxSegmentM}m（ノード疎の疑い）`); }
    const bb = ringBbox(f.p);
    if (bb.diag > LIMITS.maxBboxDiagM) { giantGeom++; errors.push(`[${f.id}] bbox対角 ${Math.round(bb.diag)}m > ${LIMITS.maxBboxDiagM}m`); }
    const overX = Math.max(0, OSAKA_CITY_BBOX.minX - LIMITS.bboxMarginM - bb.minX, bb.maxX - (OSAKA_CITY_BBOX.maxX + LIMITS.bboxMarginM));
    const overZ = Math.max(0, OSAKA_CITY_BBOX.minZ - LIMITS.bboxMarginM - bb.minZ, bb.maxZ - (OSAKA_CITY_BBOX.maxZ + LIMITS.bboxMarginM));
    if (overX > 0 || overZ > 0) { bboxViolations++; errors.push(`[${f.id}] bboxが大阪市外接矩形+${LIMITS.bboxMarginM}mを外れる`); }
  }

  const classifiedTotal = byClass.major + byClass.urban + byClass.local + byClass.excluded;
  if (classifiedTotal !== lines.length) errors.push(`classification coverage: 分類合計 ${classifiedTotal} != line feature ${lines.length}`);

  // stations
  let stNonFinite = 0, stBadEncoding = 0, stNamed = 0;
  let smnx = Infinity, smxx = -Infinity, smnz = Infinity, smxz = -Infinity;
  const opCounts = {};
  for (const s of stations) {
    const p = (s.p && s.p[0]) || null;
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { stNonFinite++; errors.push(`[${s.id}] station 座標が非有限`); continue; }
    if (p[0] < smnx) smnx = p[0]; if (p[0] > smxx) smxx = p[0]; if (p[1] < smnz) smnz = p[1]; if (p[1] > smxz) smxz = p[1];
    if (s.name) { stNamed++; if (/�/.test(s.name)) { stBadEncoding++; errors.push(`[${s.id}] station name に置換文字: ${s.name}`); } }
    const op = s.operator || '(none)';
    opCounts[op] = (opCounts[op] || 0) + 1;
  }

  console.log(`  分類: MAJOR=${byClass.major} URBAN=${byClass.urban} LOCAL=${byClass.local} excluded=${byClass.excluded}（rail majorMinLen=${RAIL_MAJOR_MIN_LEN_M}m）`);
  console.log(`  railway tag: ${JSON.stringify(byTag)}`);
  console.log(`  総延長=${(totalLenM / 1000).toFixed(1)}km / maxSegment=${Math.round(maxSegSeen)}m / longSeg=${longSeg} giantGeom=${giantGeom} bboxViolations=${bboxViolations} nonFiniteCoord=${nonFiniteCoord}`);
  console.log(`  station: ${stations.length}件 / name付き ${stNamed} / 非有限座標 ${stNonFinite} / encoding不正 ${stBadEncoding}`);
  console.log(`  station bbox: ${isFinite(smnx) ? `X[${Math.round(smnx)},${Math.round(smxx)}] Z[${Math.round(smnz)},${Math.round(smxz)}]` : 'なし'}`);
  console.log(`  実データ期待: ${EXPECT_AREAS.join(' / ')} → rail=${byTag.rail || 0} subway=${byTag.subway || 0} light_rail=${byTag.light_rail || 0}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log(`  -- warns (${warns.length}件、先頭10) --`); for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(), railDir: toProjectRelativePath(dir),
    lineCount: lines.length, stationCount: stations.length, dupLine, dupStation,
    byClass, byTag, totalLengthKm: +(totalLenM / 1000).toFixed(2), maxSegmentM: Math.round(maxSegSeen),
    longSeg, giantGeom, bboxViolations, nonFiniteCoord,
    station: { count: stations.length, named: stNamed, nonFinite: stNonFinite, badEncoding: stBadEncoding, operatorCounts: opCounts, bbox: isFinite(smnx) ? { minX: Math.round(smnx), maxX: Math.round(smxx), minZ: Math.round(smnz), maxZ: Math.round(smxz) } : null },
    thresholds: { majorMinLenM: RAIL_MAJOR_MIN_LEN_M },
    errorCount: errors.length, warnCount: warns.length, errors, warns: warns.slice(0, 50),
  };
  const reportPath = resolveProjectPath(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[rail-lod-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
