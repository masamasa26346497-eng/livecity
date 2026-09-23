#!/usr/bin/env node
// tools/validate/osm-source-coverage.js
// [Mission31 §4] OSM PBF ソースが大阪市 N03 24区 + margin を包含しているかの import 前ゲート。
//
// PASS 条件:
//   - road-way-node bbox が required bbox（N03 + margin）を north/south/east/west 4辺すべてで包含
//   - road node 緯度ヒストグラムに required.north を下回る「cliff（急落）」が無い
//     （bbox の端がスピルオーバー node で辛うじて届いていても、cliff があれば実質未カバー）
//
// FAIL の場合は import を進めない（tools/import/osm-pbf-city.js を実行しても北部道路は入らない）。
//
// 実行: node tools/validate/osm-source-coverage.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AUDIT = P('data', 'reports', 'osm-source-coverage.json');
const REPORT = P('data', 'reports', 'osm-source-coverage-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

async function main() {
  const errors = [], warns = [];
  const a = rd(AUDIT);
  if (!a) { console.error('[stop] osm-source-coverage.json なし。先に node tools/audit/osm-source-coverage.js --rescan'); process.exitCode = 1; return; }

  const rc = a.roadCoverageContains;
  const req = a.requiredBbox;
  const cliff = a.latCliff || {};

  if (!rc || !rc.sides) errors.push('roadCoverageContains が無い');
  else {
    for (const side of ['north', 'south', 'east', 'west']) {
      if (!rc.sides[side]) errors.push(side + ' 側が N03 + margin を包含していない（shortfall ' +
        (side === 'north' ? rc.shortfall.northKm + 'km' : side === 'east' ? rc.shortfall.eastKm + 'km' : rc.shortfall[side + 'Deg'] + '°') + '）');
    }
  }
  // cliff が required.north を下回る = 北部道路が実質未カバー
  if (cliff.cliffLat != null && req && cliff.cliffLat < req.north - 0.01) {
    errors.push('road node が lat≈' + cliff.cliffLat + ' で急落（cliff ratio ' + cliff.ratio + '）。required.north ' + req.north + ' を下回る＝北部道路が未収録');
  }

  const RESULT = errors.length === 0 ? 'PASS' : 'FAIL';
  console.log('[osm-source-coverage-validate]');
  console.log('  PBF: ' + (a.pbf ? a.pbf.path : '?'));
  console.log('  N03 bbox: N ' + (a.n03Bbox && a.n03Bbox.north) + ' / required N ' + (req && req.north));
  console.log('  road-way-node bbox: N ' + (a.scan && a.scan.roadWayNodeBbox && a.scan.roadWayNodeBbox.north));
  console.log('  contains: ' + JSON.stringify(rc && rc.sides) + '  cliff: ' + (cliff.cliffLat ? ('lat≈' + cliff.cliffLat) : 'なし'));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  else console.log('  ソースは大阪市域を完全に包含。import 可。');
  if (RESULT === 'FAIL' && a.remediation) {
    console.log('  -- 対応（ユーザー環境で実行）--');
    for (const [k, v] of Object.entries(a.remediation)) console.log('  ' + k + ': ' + v);
  }
  if (warns.length) for (const w of warns) console.log('  [WARN] ' + w);

  const report = {
    generatedAt: new Date().toISOString(),
    pbf: a.pbf ? a.pbf.path : null,
    n03North: a.n03Bbox && a.n03Bbox.north,
    requiredNorth: req && req.north,
    roadWayNodeNorth: a.scan && a.scan.roadWayNodeBbox && a.scan.roadWayNodeBbox.north,
    contains: rc && rc.sides,
    latCliff: cliff,
    errorCount: errors.length, errors, warns,
    RESULT,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[osm-source-coverage-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
