#!/usr/bin/env node
// tools/audit/osm-source-coverage.js
// [Mission31 §1/§2] OSM PBF ソースの実カバレッジ bbox を監査し、大阪市 N03 24区 + margin を
//   包含しているかを判定する。road way に属する node だけの bbox・緯度ヒストグラム（cliff 検出）も出す。
//
//   出力: data/reports/osm-source-coverage.json
//   実行: node tools/audit/osm-source-coverage.js [--pbf <path>] [--rescan] [--margin-km 3]
//
//   PBF ストリームは重い（~4分）。同じ PBF（path+mtime+size 一致）なら前回結果を再利用し、
//   --rescan で強制再走査する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { n03Bbox, expandBboxKm, coverageContains, detectLatCliff } from '../lib/osm-source-coverage.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const REPORT = P('data', 'reports', 'osm-source-coverage.json');
const DEFAULT_PBF = P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');

const ROAD_RE = /^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified|service|pedestrian|road|track)$/;

function parseArgs() {
  const a = { pbf: DEFAULT_PBF, rescan: false, marginKm: 3 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--pbf') a.pbf = path.isAbsolute(v[++i]) ? v[i] : resolveProjectPath(v[i]);
    else if (v[i] === '--rescan') a.rescan = true;
    else if (v[i] === '--margin-km') a.marginKm = parseFloat(v[++i]) || 3;
  }
  return a;
}

async function scanPbf(pbf) {
  // pass1: road way node refs
  const roadNodeIds = new Set();
  let ways = 0, relations = 0;
  for await (const p of pbfPrimitiveStream(pbf)) {
    if (p.type === 'way') { ways++; const hw = p.tags && p.tags.highway; if (typeof hw === 'string' && ROAD_RE.test(hw)) for (const r of p.refs) roadNodeIds.add(r); }
    else if (p.type === 'relation') relations++;
  }
  // pass2: node coords → all-node bbox + road-way-node bbox + lat histogram
  let nodes = 0;
  let aS = 99, aN = -99, aW = 999, aE = -999;
  let rS = 99, rN = -99, rW = 999, rE = -999;
  const latHist = {};
  for await (const p of pbfPrimitiveStream(pbf)) {
    if (p.type !== 'node' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    nodes++;
    if (p.lat < aS) aS = p.lat; if (p.lat > aN) aN = p.lat; if (p.lon < aW) aW = p.lon; if (p.lon > aE) aE = p.lon;
    if (roadNodeIds.has(p.id)) {
      if (p.lat < rS) rS = p.lat; if (p.lat > rN) rN = p.lat; if (p.lon < rW) rW = p.lon; if (p.lon > rE) rE = p.lon;
      const b = (Math.round(p.lat * 100) / 100).toFixed(2);
      latHist[b] = (latHist[b] || 0) + 1;
    }
  }
  return {
    ways, relations, nodes, roadWayNodes: roadNodeIds.size,
    allNodeBbox: { south: +aS.toFixed(6), north: +aN.toFixed(6), west: +aW.toFixed(6), east: +aE.toFixed(6) },
    roadWayNodeBbox: { south: +rS.toFixed(6), north: +rN.toFixed(6), west: +rW.toFixed(6), east: +rE.toFixed(6) },
    latHistogram: latHist,
  };
}

async function main() {
  const args = parseArgs();
  if (!fs.existsSync(args.pbf)) { console.error('[stop] PBF が無い: ' + toProjectRelativePath(args.pbf)); process.exitCode = 1; return; }
  const st = fs.statSync(args.pbf);
  const sig = { path: toProjectRelativePath(args.pbf), mtimeMs: Math.round(st.mtimeMs), sizeBytes: st.size };

  const prev = (() => { try { return JSON.parse(fs.readFileSync(REPORT, 'utf-8')); } catch (e) { return null; } })();
  let scan;
  if (!args.rescan && prev && prev.pbf && prev.pbf.path === sig.path && prev.pbf.mtimeMs === sig.mtimeMs && prev.pbf.sizeBytes === sig.sizeBytes && prev.scan) {
    console.log('[osm-source-coverage] PBF 未変更 → 前回スキャン結果を再利用（--rescan で強制再走査）');
    scan = prev.scan;
  } else {
    console.log('[osm-source-coverage] PBF ストリーム開始（road way node bbox 算出。数分かかります）…');
    const t0 = Date.now();
    scan = await scanPbf(args.pbf);
    console.log('[osm-source-coverage] スキャン完了 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's / ' + scan.nodes + ' node');
  }

  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  const n03 = n03Bbox(wards);
  const required = expandBboxKm(n03, args.marginKm);
  const roadContain = coverageContains(scan.roadWayNodeBbox, required);
  const allContain = coverageContains(scan.allNodeBbox, required);
  const cliff = detectLatCliff(scan.latHistogram);

  const RESULT = roadContain.ok ? 'PASS' : 'FAIL';
  const report = {
    generatedAt: new Date().toISOString(),
    pbf: sig,
    marginKm: args.marginKm,
    n03Bbox: n03,
    requiredBbox: required,
    scan,
    roadCoverageContains: roadContain,
    allNodeContains: allContain,
    latCliff: cliff,
    // road way node bbox が N03 の実測値（cliff や shortfall）で切れているか
    verdict: roadContain.ok
      ? '道路ソースは大阪市 N03 + margin を包含している'
      : `道路ソースが不足: ${['north', 'south', 'east', 'west'].filter((s) => !roadContain.sides[s]).join('/')} 側。`
        + (cliff.cliffLat ? ` road node は lat≈${cliff.cliffLat} で急落（cliff ratio ${cliff.ratio}）。` : ''),
    remediation: roadContain.ok ? null : {
      step1: `より広域の PBF を取得（大阪府全域 or 大阪市 N03 bbox [S ${required.south} / N ${required.north} / W ${required.west} / E ${required.east}] を完全包含するもの）。既存 osaka-latest.osm.pbf は破壊せず data/raw/osm/osaka-full-coverage.osm.pbf として保存。`,
      step2: 'node tools/audit/osm-source-coverage.js --pbf data/raw/osm/osaka-full-coverage.osm.pbf --rescan → PASS を確認。',
      step3: 'node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-full-coverage.osm.pbf --area osaka-city --layer roads',
      step4: 'node tools/build-city-layer-tiles.js --layer roads --area osaka-city --public --force',
      step5: 'node tools/audit/road-network.js && node tools/audit/map-completeness.js && node tools/audit/map-detail-audit.js',
    },
    RESULT,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[osm-source-coverage] N03 大阪市 bbox: S ' + n03.south + ' / N ' + n03.north + ' / W ' + n03.west + ' / E ' + n03.east);
  console.log('  required (+ ' + args.marginKm + 'km): S ' + required.south + ' / N ' + required.north + ' / W ' + required.west + ' / E ' + required.east);
  console.log('  PBF road-way-node bbox: S ' + scan.roadWayNodeBbox.south + ' / N ' + scan.roadWayNodeBbox.north + ' / W ' + scan.roadWayNodeBbox.west + ' / E ' + scan.roadWayNodeBbox.east);
  console.log('  contains: ' + JSON.stringify(roadContain.sides) + '  shortfall north ' + roadContain.shortfall.northKm + 'km / east ' + roadContain.shortfall.eastKm + 'km');
  console.log('  lat cliff: ' + (cliff.cliffLat ? ('lat≈' + cliff.cliffLat + ' (ratio ' + cliff.ratio + ')') : 'なし'));
  console.log('  verdict: ' + report.verdict);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + RESULT);
}

main().catch((e) => { console.error('[osm-source-coverage] 失敗:', e && e.stack || e); process.exitCode = 1; });
