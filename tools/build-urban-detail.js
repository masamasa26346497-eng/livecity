// tools/build-urban-detail.js
// [Mission 35X §2-§11] 都市ディテールを **OSM の実データから** 抽出して 2000m タイルへ書く。
//
//   §1 の実測（tools/audit/urban-detail-source-audit.js）で、推定に頼らずに済むことが分かった:
//     信号 12,712 / 街路樹 12,590 / 横断歩道ノード 32,036 / バス停 6,188 / 地下鉄入口 1,414 …
//   いずれも大阪市の bbox 内。**このミッションで推定して作ったものは 1 つも無い。**
//
//   出力: public/map-data/osaka-city/urban-detail/tile_{tx}_{tz}.json
//         （座標は znorth-neg-v1。roads / parks と同じ 2000m グリッド）
//
//   実行: node --max-old-space-size=6144 tools/build-urban-detail.js
import fs from 'node:fs';
import path from 'node:path';
import { pbfPrimitiveStream } from './lib/osm-pbf-stream.js';

const PBF = process.env.URBAN_PBF || 'data/raw/osm/osaka-full-coverage.osm.pbf';
const OUT_DIR = 'public/map-data/osaka-city/urban-detail';
const REPORT_DIR = 'data/reports/mission35x-urban-detail-layer';
const TILE = 2000;

// 既存レイヤーと同じ投影（znorth-neg-v1）。ここを変えてはいけない。
const CLAT = 34.604208, CLON = 135.52502, MPD = 111320;
const toLocal = (lat, lon) => ({
  x: (lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD,
  z: -((lat - CLAT) * MPD),
});
const BBOX = { minLat: 34.50, maxLat: 34.82, minLon: 135.36, maxLon: 135.66 };
const inBox = (lat, lon) => lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

// ── 点として置くもの（node） ──────────────────────────────────
//   k は runtime 側のカテゴリコード。短くしてタイル JSON を小さく保つ。
const POINT_KIND = {
  tree: 'T', signal: 'S', crossing: 'X',
  bus: 'b', subway: 'e', post: 'p', police: 'c', fire: 'f', toilet: 't', bicycle: 'y',
};
function pointKind(t) {
  if (t.natural === 'tree') return POINT_KIND.tree;
  if (t.highway === 'traffic_signals') return POINT_KIND.signal;
  if (t.highway === 'crossing') return POINT_KIND.crossing;
  if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) return POINT_KIND.bus;
  if (t.railway === 'subway_entrance') return POINT_KIND.subway;
  if (t.amenity === 'post_office') return POINT_KIND.post;
  if (t.amenity === 'police') return POINT_KIND.police;
  if (t.amenity === 'fire_station') return POINT_KIND.fire;
  if (t.amenity === 'toilets') return POINT_KIND.toilet;
  if (t.amenity === 'bicycle_parking') return POINT_KIND.bicycle;
  return null;
}

// ── 線 / 面として置くもの（way） ─────────────────────────────
const WAY_KIND = { sidewalk: 'w', crossingWay: 'xw', treeRow: 'tr', parking: 'P', plaza: 'Z', median: 'm' };
function wayKind(t) {
  if (t.highway === 'footway' && t.footway === 'crossing') return WAY_KIND.crossingWay;
  if (t.highway === 'footway' && t.footway === 'sidewalk') return WAY_KIND.sidewalk;
  if (t.natural === 'tree_row') return WAY_KIND.treeRow;
  if (t.amenity === 'parking') return WAY_KIND.parking;
  if (t.place === 'square' || t.leisure === 'common') return WAY_KIND.plaza;
  if (t.barrier === 'kerb' || t.barrier === 'guard_rail') return WAY_KIND.median;
  return null;
}
const AREA_KINDS = new Set([WAY_KIND.parking, WAY_KIND.plaza]);

const stats = { pass1: {}, pass2: {}, points: {}, ways: {}, tiles: 0, droppedOutsideBbox: 0 };

// ══ pass 1: 点を確定し、欲しい way の ref を覚える ══════════════
console.log('[35X] pass 1: nodes + way refs');
const points = [];                    // { x, z, k }
const wantWays = [];                  // { k, refs }
const needNodes = new Set();
let n1 = 0, w1 = 0;
const t0 = Date.now();
for await (const p of pbfPrimitiveStream(PBF)) {
  if (p.type === 'node') {
    n1++;
    const t = p.tags;
    if (!t || p.lat == null || p.lon == null) continue;
    const k = pointKind(t);
    if (!k) continue;
    if (!inBox(p.lat, p.lon)) { stats.droppedOutsideBbox++; continue; }
    const { x, z } = toLocal(p.lat, p.lon);
    points.push({ x: +x.toFixed(2), z: +z.toFixed(2), k });
    stats.points[k] = (stats.points[k] || 0) + 1;
  } else if (p.type === 'way') {
    w1++;
    const t = p.tags;
    if (!t) continue;
    const k = wayKind(t);
    if (!k || !p.refs || p.refs.length < 2) continue;
    wantWays.push({ k, refs: p.refs });
    for (const r of p.refs) needNodes.add(r);
  }
  if ((n1 + w1) % 4_000_000 === 0) {
    process.stdout.write(`\r  node ${n1.toLocaleString()} way ${w1.toLocaleString()} ` +
      `pts ${points.length.toLocaleString()} ways ${wantWays.length.toLocaleString()} ` +
      `needNodes ${needNodes.size.toLocaleString()} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}
process.stdout.write('\n');
stats.pass1 = { nodes: n1, ways: w1, points: points.length, wantWays: wantWays.length, needNodes: needNodes.size };
console.log('  点', points.length.toLocaleString(), '/ way候補', wantWays.length.toLocaleString(),
  '/ 解決が要る node', needNodes.size.toLocaleString());

// ══ pass 2: way の node 座標を解決（bbox 内だけ持つ） ═══════════
console.log('[35X] pass 2: resolve way node coords');
const coord = new Map();              // nodeId -> [x, z]
let n2 = 0, kept = 0;
const t1 = Date.now();
for await (const p of pbfPrimitiveStream(PBF)) {
  if (p.type !== 'node') break;       // PBF は node → way → relation の順
  n2++;
  if (p.lat == null || p.lon == null) continue;
  if (!needNodes.has(p.id)) continue;
  if (!inBox(p.lat, p.lon)) continue;
  const { x, z } = toLocal(p.lat, p.lon);
  coord.set(p.id, [+x.toFixed(2), +z.toFixed(2)]);
  kept++;
  if (n2 % 8_000_000 === 0) {
    process.stdout.write(`\r  node ${n2.toLocaleString()} resolved ${kept.toLocaleString()} ` +
      `(${Math.round((Date.now() - t1) / 1000)}s)`);
  }
}
process.stdout.write('\n');
stats.pass2 = { scanned: n2, resolved: kept };
needNodes.clear();
console.log('  解決できた node', kept.toLocaleString());

// ══ 組み立て ═══════════════════════════════════════════════════
console.log('[35X] assemble');
const tiles = new Map();              // 'tx_tz' -> tile
const tileOf = (x, z) => Math.floor(x / TILE) + '_' + Math.floor(z / TILE);
function tile(x, z) {
  const key = tileOf(x, z);
  let t = tiles.get(key);
  if (!t) {
    const [tx, tz] = key.split('_').map(Number);
    t = { tx, tz, tileSize: TILE, points: [], lines: [], areas: [] };
    tiles.set(key, t);
  }
  return t;
}

for (const pt of points) tile(pt.x, pt.z).points.push([pt.x, pt.z, pt.k]);

for (const w of wantWays) {
  const pts = [];
  for (const r of w.refs) {
    const c = coord.get(r);
    if (c) pts.push(c);
  }
  if (pts.length < 2) continue;       // bbox の外 / 解決できなかった
  // 重複点をつぶす
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    if (Math.abs(pts[i][0] - a[0]) > 0.25 || Math.abs(pts[i][1] - a[1]) > 0.25) out.push(pts[i]);
  }
  if (out.length < 2) continue;
  const cx = out[0][0], cz = out[0][1];
  const t = tile(cx, cz);
  if (AREA_KINDS.has(w.k)) {
    if (out.length < 3) continue;
    t.areas.push({ k: w.k, p: out });
  } else {
    t.lines.push({ k: w.k, p: out });
  }
  stats.ways[w.k] = (stats.ways[w.k] || 0) + 1;
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
let bytes = 0;
const tileIndex = [];
for (const [key, t] of tiles) {
  if (!t.points.length && !t.lines.length && !t.areas.length) continue;
  const f = path.join(OUT_DIR, 'tile_' + key + '.json');
  const json = JSON.stringify(t);
  fs.writeFileSync(f, json);
  bytes += json.length;
  tileIndex.push(key);
}
stats.tiles = tileIndex.length;

const manifest = {
  version: 1, mission: '35X', generatedAt: new Date().toISOString(),
  coordinateConvention: 'znorth-neg-v1', tileSize: TILE,
  source: PBF,
  note: 'すべて OSM の実データ。このデータセットに推定で作った要素は無い。',
  pointKinds: POINT_KIND, wayKinds: WAY_KIND,
  counts: { points: stats.points, ways: stats.ways, tiles: tileIndex.length, bytes },
  tiles: tileIndex,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'build-urban-detail.json'), JSON.stringify({ ...stats, manifest }, null, 2));

console.log('== 点 ==');
for (const [k, v] of Object.entries(stats.points).sort((a, b) => b[1] - a[1])) console.log('  ' + k, v.toLocaleString());
console.log('== 線 / 面 ==');
for (const [k, v] of Object.entries(stats.ways).sort((a, b) => b[1] - a[1])) console.log('  ' + k, v.toLocaleString());
console.log('tiles', tileIndex.length, '/', (bytes / 1e6).toFixed(1), 'MB');
console.log('out', OUT_DIR);
