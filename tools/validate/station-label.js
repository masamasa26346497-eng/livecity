#!/usr/bin/env node
// tools/validate/station-label.js
// [見た目改善 Mission14] 駅ラベル validator CLI。
//   railways tile の station node をクラスタリング・importance 分類し、以下を検証する:
//     - station finite / name non-empty
//     - cluster coverage（全 station member が 1 cluster に属する）
//     - classification coverage（MAJOR+MEDIUM+LOCAL = cluster 数）
//     - duplicate canonical label（同名クラスタ = WARN。既知の別駅同名は許容）
//     - visible FAR upper bound（MAJOR cluster <= STATION_LABEL_FAR_MAX）
//     - label priority（分類の単調性）
//     - encoding（置換文字なし）
//     - bbox containment（大阪市外接矩形 + margin）
//
// 実行: node tools/validate/station-label.js

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import {
  clusterStations, classifyStationImportance, normalizeStationName, STATION_LABEL_FAR_MAX,
} from '../lib/station-cluster.js';

const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const BBOX_MARGIN_M = 1200;
// 実データ上に存在する「別駅だが同名」（統合してはいけない）
const KNOWN_DISTINCT_SAMENAME = new Set(['中津', '野田', '平野', '今里', '九条']);

function parseArgs(argv) {
  const a = { rail: path.join('public', 'map-data', 'osaka-city', 'railways'), report: path.join('data', 'reports', 'station-label-validation.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rail') a.rail = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

function load(dir) {
  const stById = new Map(), lnById = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind === 'station' && ft.p && ft.p[0]) { if (!stById.has(ft.id)) stById.set(ft.id, { id: ft.id, name: ft.name || '', x: ft.p[0][0], z: ft.p[0][1] }); }
      else if (ft.kind === 'line' && ft.p) { if (!lnById.has(ft.id)) lnById.set(ft.id, { id: ft.id, railway: ft.railway, p: ft.p }); }
    }
  }
  return { stations: [...stById.values()], lines: [...lnById.values()] };
}

function nearbyOf(lines) {
  return (c) => {
    const R = 250, rail = new Set(), sub = new Set(), lr = new Set();
    for (const l of lines) {
      let hit = false;
      for (const p of l.p) { if (Math.hypot(p[0] - c.x, p[1] - c.z) < R) { hit = true; break; } }
      if (hit) { if (l.railway === 'subway') sub.add(l.id); else if (l.railway === 'light_rail') lr.add(l.id); else rail.add(l.id); }
    }
    return { railWays: rail.size, subwayWays: sub.size, lightRailWays: lr.size };
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveProjectPath(args.rail);
  if (!fs.existsSync(dir)) { console.error(`[station-label-validate] railways tile が見つかりません: ${toProjectRelativePath(dir)}`); process.exitCode = 1; return; }
  const { stations, lines } = load(dir);
  console.log(`[station-label-validate] raw station=${stations.length} / rail line=${lines.length}`);

  const errors = [], warns = [];
  // station 健全性
  let nonFinite = 0, emptyName = 0, badEncoding = 0;
  for (const s of stations) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) { nonFinite++; errors.push(`[${s.id}] 座標が非有限`); }
    if (!s.name || !normalizeStationName(s.name)) { emptyName++; errors.push(`[${s.id}] name が空`); }
    if (/�/.test(s.name)) { badEncoding++; errors.push(`[${s.id}] name に置換文字: ${s.name}`); }
  }

  const clusters = clusterStations(stations, {});
  const near = nearbyOf(lines);

  // cluster coverage
  const memberSet = new Set();
  for (const c of clusters) for (const id of c.memberIds) memberSet.add(id);
  const covered = stations.filter((s) => memberSet.has(s.id)).length;
  if (covered !== stations.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.z)).length) {
    errors.push(`cluster coverage: ${covered}/${stations.length} station しかクラスタに属していない`);
  }

  // classification coverage + priority
  const byClass = { major: 0, medium: 0, local: 0 };
  for (const c of clusters) { c.importance = classifyStationImportance(c, near(c)); byClass[c.importance]++; }
  if (byClass.major + byClass.medium + byClass.local !== clusters.length) errors.push('classification coverage 不一致');
  // MAJOR は group 由来のみ（override）— priority が意図どおり
  for (const c of clusters) if (c.importance === 'major' && !c.group) errors.push(`[${c.label}] group 無しで major に分類`);

  // FAR upper bound
  if (byClass.major > STATION_LABEL_FAR_MAX) errors.push(`MAJOR cluster ${byClass.major} > FAR 上限 ${STATION_LABEL_FAR_MAX}`);
  if (byClass.major < 6) warns.push(`MAJOR cluster が少ない (${byClass.major})`);

  // duplicate canonical label
  const labelCount = {};
  for (const c of clusters) labelCount[c.label] = (labelCount[c.label] || 0) + 1;
  const dups = Object.entries(labelCount).filter(([, n]) => n > 1);
  for (const [label, n] of dups) {
    if (KNOWN_DISTINCT_SAMENAME.has(label)) warns.push(`同名クラスタ ${label}×${n}（既知の別駅、統合しない）`);
    else errors.push(`重複 canonical label: ${label}×${n}（clustering 失敗の疑い）`);
  }

  // bbox containment
  let bboxViolations = 0;
  for (const c of clusters) {
    const overX = Math.max(0, OSAKA_CITY_BBOX.minX - BBOX_MARGIN_M - c.x, c.x - (OSAKA_CITY_BBOX.maxX + BBOX_MARGIN_M));
    const overZ = Math.max(0, OSAKA_CITY_BBOX.minZ - BBOX_MARGIN_M - c.z, c.z - (OSAKA_CITY_BBOX.maxZ + BBOX_MARGIN_M));
    if (overX > 0 || overZ > 0) { bboxViolations++; errors.push(`[${c.label}] cluster 中心が大阪市外接矩形+${BBOX_MARGIN_M}m 外`); }
  }

  console.log(`  cluster=${clusters.length}（raw ${stations.length} → 統合）`);
  console.log(`  分類: MAJOR=${byClass.major} MEDIUM=${byClass.medium} LOCAL=${byClass.local}`);
  console.log(`  MAJOR: ${clusters.filter((c) => c.importance === 'major').map((c) => c.label).join(' / ')}`);
  console.log(`  station: 非有限 ${nonFinite} / 空name ${emptyName} / encoding不正 ${badEncoding}`);
  console.log(`  重複 canonical label: ${dups.length}（うち既知別駅 ${dups.filter(([l]) => KNOWN_DISTINCT_SAMENAME.has(l)).length}）/ bboxViolations ${bboxViolations}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log(`  -- warns (${warns.length}) --`); for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(), railDir: toProjectRelativePath(dir),
    rawStationCount: stations.length, clusterCount: clusters.length, byClass,
    majorLabels: clusters.filter((c) => c.importance === 'major').map((c) => c.label),
    station: { nonFinite, emptyName, badEncoding },
    dupLabels: dups.map(([l, n]) => ({ label: l, count: n, knownDistinct: KNOWN_DISTINCT_SAMENAME.has(l) })),
    bboxViolations, farMax: STATION_LABEL_FAR_MAX,
    errorCount: errors.length, warnCount: warns.length, errors, warns: warns.slice(0, 50),
  };
  const reportPath = resolveProjectPath(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[station-label-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
