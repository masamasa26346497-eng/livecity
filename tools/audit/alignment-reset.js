#!/usr/bin/env node
// tools/audit/alignment-reset.js
// [Mission 31G-ALIGNMENT-RESET §19/§20/§34] Building footprint と GSI Road Edge の関係を実測する。
//   §20 遵守: GSI edge の「どちらが道路側か」は推定しない（強制解釈でclipしない）。
//   代わりに (a) footprint 頂点から最寄り edge line までの距離、(b) footprint の辺が edge line の
//   辺と実際に交差(straddle)しているか、という2つの「解釈を要さない幾何事実」だけを計測する。
//   交差は「どちらの側にせよ、建物の輪郭が道路縁ラインを跨いでいる」ことの明確な証拠になる。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const CANON_BLDG_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'canonical', 'buildings'));
const GSI_EDGE_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'alignment-reset.json'));
const TILE_SIZE = 500;

const REFERENCE_SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'nakanoshima', name: '中之島', x: -2695.66, z: -9962.25 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
];
const SITE_RADIUS_M = 600;
const CITY_SAMPLE_CAP = 40000;      // §6相当: 「少なくとも数万棟」を満たすシティワイドsample
const CITY_SAMPLE_PER_TILE = 60;    // 996 tile * 60 ≈ 上限で自然に caps される

function pointToSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}
function minDistToLines(px, pz, lines) {
  let best = Infinity;
  for (const c of lines) {
    for (let i = 0; i < c.length - 1; i++) {
      const d = pointToSegDist(px, pz, c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
      if (d < best) best = d;
    }
  }
  return best;
}
// 標準的な向き(orientation)ベースの線分交差判定（端点での接触=交差とはみなさない厳密版）。
function orient(ax, az, bx, bz, cx, cz) { return (bx - ax) * (cz - az) - (bz - az) * (cx - ax); }
function segsCross(a1x, a1z, a2x, a2z, b1x, b1z, b2x, b2z) {
  const o1 = orient(a1x, a1z, a2x, a2z, b1x, b1z), o2 = orient(a1x, a1z, a2x, a2z, b2x, b2z);
  const o3 = orient(b1x, b1z, b2x, b2z, a1x, a1z), o4 = orient(b1x, b1z, b2x, b2z, a2x, a2z);
  return (o1 * o2 < 0) && (o3 * o4 < 0);
}
function footprintCrossesLines(ring, lines) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (const c of lines) {
      for (let j = 0; j < c.length - 1; j++) {
        if (segsCross(a[0], a[1], b[0], b[1], c[j][0], c[j][1], c[j + 1][0], c[j + 1][1])) return true;
      }
    }
  }
  return false;
}

function tileKey(tx, tz) { return tx + '_' + tz; }
function loadGsiEdgeTile(tx, tz) {
  const p = path.join(GSI_EDGE_DIR, 'tile_' + tx + '_' + tz + '.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return (data.features || []).map((f) => f.coordinates);
}
function loadBuildingTile(tx, tz) {
  const p = path.join(CANON_BLDG_DIR, 'tile_' + tx + '_' + tz + '.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return data.features || [];
}
function percentile(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p)); return sorted[i]; }
function summarize(arr) {
  if (!arr.length) return { n: 0, median: null, p90: null, p95: null, max: null, mean: null };
  const s = arr.slice().sort((a, b) => a - b);
  let sum = 0; for (const v of arr) sum += v;
  return { n: arr.length, median: percentile(s, 0.5), p90: percentile(s, 0.9), p95: percentile(s, 0.95), max: s[s.length - 1], mean: +(sum / arr.length).toFixed(4) };
}

function siteReport(site) {
  const txMin = Math.floor((site.x - SITE_RADIUS_M) / TILE_SIZE), txMax = Math.floor((site.x + SITE_RADIUS_M) / TILE_SIZE);
  const tzMin = Math.floor((site.z - SITE_RADIUS_M) / TILE_SIZE), tzMax = Math.floor((site.z + SITE_RADIUS_M) / TILE_SIZE);
  const lines = [];
  const buildings = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      lines.push(...loadGsiEdgeTile(tx, tz));
      buildings.push(...loadBuildingTile(tx, tz));
    }
  }
  const distances = [];
  let crossingCount = 0, checkedCount = 0;
  const crossingSamples = [];
  for (const f of buildings) {
    const cx = f.centroid ? f.centroid[0] : null, cz = f.centroid ? f.centroid[1] : null;
    if (cx == null) continue;
    if (Math.hypot(cx - site.x, cz - site.z) > SITE_RADIUS_M) continue;
    const ring = (f.coordinates && f.coordinates[0]) || null;
    if (!ring || ring.length < 3) continue;
    checkedCount++;
    let minD = Infinity;
    for (const [vx, vz] of ring) { const d = minDistToLines(vx, vz, lines); if (d < minD) minD = d; }
    if (isFinite(minD)) distances.push(minD);
    if (minD < 20 && footprintCrossesLines(ring, lines.filter((c) => {
      // 粗い bbox 事前フィルタ（性能: 遠い line との交差判定を省く）
      for (const [lx, lz] of c) if (Math.hypot(lx - cx, lz - cz) < 40) return true;
      return false;
    }))) {
      crossingCount++;
      if (crossingSamples.length < 20) crossingSamples.push({ canonicalId: f.canonicalId, centroid: f.centroid });
    }
  }
  return {
    site: site.name, siteId: site.id, center: [site.x, site.z], radiusM: SITE_RADIUS_M,
    gsiEdgeLineCount: lines.length,
    buildingsChecked: checkedCount,
    nearestEdgeDistance: summarize(distances),
    crossingBuildingCount: crossingCount,
    crossingBuildingSample: crossingSamples,
    note: crossingCount === 0
      ? '交差=0（このサイト半径600m内でfootprintの辺がGSI道路縁ラインを跨ぐ例は検出されなかった）'
      : crossingCount + '棟でfootprintの辺がGSI道路縁ラインと交差（§20: どちらが道路側かは判定していない。単なる幾何学的straddleの検出）',
  };
}

function cityWideSample() {
  const files = fs.readdirSync(CANON_BLDG_DIR).filter((f) => f.startsWith('tile_') && f.endsWith('.json'));
  const distances = [];
  let checked = 0, crossing = 0;
  for (const file of files) {
    if (checked >= CITY_SAMPLE_CAP) break;
    const m = file.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
    if (!m) continue;
    const tx = +m[1], tz = +m[2];
    const lines = loadGsiEdgeTile(tx, tz);
    if (!lines.length) continue; // GSI coverage が無いtileはスキップ（サンプルの質を担保）
    const feats = loadBuildingTile(tx, tz).slice(0, CITY_SAMPLE_PER_TILE);
    for (const f of feats) {
      if (checked >= CITY_SAMPLE_CAP) break;
      const ring = (f.coordinates && f.coordinates[0]) || null;
      if (!ring || ring.length < 3) continue;
      checked++;
      let minD = Infinity;
      for (const [vx, vz] of ring) { const d = minDistToLines(vx, vz, lines); if (d < minD) minD = d; }
      if (isFinite(minD)) distances.push(minD);
    }
  }
  return { sampleCount: checked, tilesWithGsiCoverage: files.length, nearestEdgeDistance: summarize(distances) };
}

async function main() {
  const t0 = Date.now();
  console.log('[alignment-reset] city-wide sample 計測中…');
  const cityWide = cityWideSample();
  console.log('[alignment-reset] city-wide sampleCount=' + cityWide.sampleCount + ' (' + (Date.now() - t0) + 'ms)');

  const sites = [];
  for (const s of REFERENCE_SITES) {
    const t1 = Date.now();
    const r = siteReport(s);
    console.log('[alignment-reset] site=' + s.name + ' checked=' + r.buildingsChecked + ' crossing=' + r.crossingBuildingCount + ' (' + (Date.now() - t1) + 'ms)');
    sites.push(r);
  }

  const gsiManifest = JSON.parse(fs.readFileSync(path.join(GSI_EDGE_DIR, 'manifest.json'), 'utf-8'));
  const report = {
    generatedAt: new Date().toISOString(),
    buildingSource: 'plateau-building (canonical, 615617 features, unaltered)',
    roadEdgeSource: 'GSI-kiban-road-edge (RdEdg, ' + gsiManifest.distinctFeatureCount + ' features, znorth-neg-v1, unaltered)',
    sceneRoots: { canonical: 'canonicalRoot', legacy: 'legacyRoot', debug: 'debugRoot', ui: 'uiRoot' },
    referenceSites: REFERENCE_SITES.map((s) => ({ id: s.id, name: s.name, center: [s.x, s.z] })),
    cityWideSample: cityWide,
    buildingVsGsiRoadEdge: sites,
    roadSurfaceSources: {
      fill: 'refined-road-surface.json (FIX13, unchanged, unaltered)',
      boundary: 'GSI Road Edge tiles (derived/gsi-road-edge/, new, tile-based, authoritative outline)',
    },
    methodologyNote: '§20遵守: GSI edgeの道路側/街区側を推定していない。footprint頂点→最寄りedge line距離と、' +
      'footprint辺とedge line辺の幾何学的交差(straddle)のみを計測する解釈非依存の指標。',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存: ' + toProjectRelativePath(REPORT) + ' (総計 ' + (Date.now() - t0) + 'ms)');
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[alignment-reset] 失敗:', e && e.stack || e); process.exit(1); });
