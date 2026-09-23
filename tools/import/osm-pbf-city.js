#!/usr/bin/env node
// tools/import/osm-pbf-city.js
// P1-6B: OSM PBF ローカル extract から大阪市24区の都市レイヤーを抽出し、
//        既存パイプラインがそのまま読める Overpass 互換 JSON を生成する。
//
//   .osm.pbf ──[この tool]──▶ data/raw/osaka-city/<layer>-osm.json
//                              └─▶ tools/build-city-layer-tiles.js ─▶ public/map-data/osaka-city/<layer>/
//
// ネットワーク不要（ローカルの .osm.pbf を読むだけ）。PBF デコードは osm-pbf-parser に委譲
// （tools/lib/osm-pbf-stream.js。依存は遅延読み込み）。
//
// 実行:
//   node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --layer all
//
// 【設計】
//   - 抽出 / 組み立て / 幾何解決 / bbox 判定はすべて純粋関数（osm-pbf-parser 非依存）。
//     テストは合成 primitive ストリームで行い、PBF バイナリもパッケージも要らない。
//   - PBF は3回ストリームする（メモリを実際に使う地物ぶんに有界化）:
//       pass1 relations … 対象 relation と、その member way id・node id を収集
//       pass2 ways      … レイヤー該当 way ＋ relation member way の node 参照を収集
//       pass3 nodes     … 必要 node の座標 ＋ station node（point feature）を収集
//   - 出力は Overpass `out geom` 互換（way は geometry:[{lat,lon}]、relation は members[].geometry）。
//   - projection 原点・znorth-neg-v1 は一切触らない（座標変換は build-city-layer-tiles.js 側）。

import fs from 'node:fs';
import path from 'node:path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

export const ALL_LAYERS = ['roads', 'waterways', 'parks', 'railways'];

// config/areas/osaka-city.json の osmFilter と一致させたタグ判定（Overpass 版とスキーマ互換にするため）。
export const LAYER_TAG_MATCH = {
  roads: {
    // [Mission23] 幹線に加え生活道路・細街路（*_link / living_street / unclassified / service /
    //   pedestrian / road）まで取り込む。私有 driveway・parking_aisle・access=private は
    //   convert / build 側で除外分類する（歩道 footway/path/steps/track は対象外＝ここで弾く）。
    // [Mission26] track（農道・管理道路）も取り込む。convert 側で access=private/no/forestry 等は除外分類。
    //   footway/path/steps/cycleway/corridor は引き続き対象外（歩行者路＝canonical road mesh に混ぜない）。
    way: (t) => typeof t.highway === 'string'
      && /^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified|service|pedestrian|road|track)$/.test(t.highway),
  },
  parks: {
    way: (t) => t.leisure === 'park' || t.landuse === 'grass' || t.landuse === 'recreation_ground',
  },
  railways: {
    way: (t) => typeof t.railway === 'string' && /^(rail|light_rail|subway)$/.test(t.railway),
    node: (t) => t.railway === 'station',
  },
  waterways: {
    // [Mission22] river/canal に加え surface な水路網（stream/drain/ditch）も取り込む。
    //   地下水路（tunnel/covered/layer<0）は convert 側で surface:false として分類し河川描画から外す。
    way: (t) => t.natural === 'water'
      || t.waterway === 'river' || t.waterway === 'canal'
      || t.waterway === 'stream' || t.waterway === 'drain' || t.waterway === 'ditch',
    relation: (t) => t.natural === 'water' || t.waterway === 'riverbank'
      || (t.type === 'multipolygon' && (t.water != null || t.natural === 'water')),
  },
};

// 出力へ残すタグ（ファイルを小さく保つ。convert/*.js が参照するものだけ）。
const KEEP_TAG_KEYS = new Set([
  'highway', 'leisure', 'landuse', 'railway', 'natural', 'waterway', 'water',
  'name', 'name:ja', 'type',
]);
// [Mission22] waterways だけ追加で幅・地下判定用タグも残す（他レイヤーの出力・幅推定は不変）。
const KEEP_TAG_KEYS_WATERWAYS = new Set([...KEEP_TAG_KEYS, 'width', 'tunnel', 'covered', 'layer', 'intermittent']);
// [Mission23] roads だけ幅・車線・access・bridge/tunnel 判定用タグも残す。
const KEEP_TAG_KEYS_ROADS = new Set([...KEEP_TAG_KEYS,
  'width', 'lanes', 'oneway', 'bridge', 'tunnel', 'layer', 'surface',
  'access', 'motor_vehicle', 'vehicle', 'service', 'foot',
  'tracktype']); // [Mission26] track の路面等級（農道の可用性判定）
// [Mission 35F §6] railways だけ、本線と車両基地・側線を区別するためのタグを残す。
//   OSM では車両基地も `railway=rail` なので、`service=yard|siding|spur|crossover` が無いと
//   本線と見分けられない（canonical の attributes.service が全件 null だった）。
//   **描画は変えない**。canonical に区別を持たせるだけなので、足すのは `service` だけにする。
//   bridge / tunnel / layer は canonical の属性としては用意されているが、これを埋めると
//   「高架なら Y を上げる」描画経路（buildGroup の Y.railBridge）に影響しうるので今回は足さない。
const KEEP_TAG_KEYS_RAILWAYS = new Set([...KEEP_TAG_KEYS, 'service']);
// [Mission 35K §2/§6] 駅 node だけ、事業者を見分けるためのタグを残す。
//   駅は OSM node と 1:1 で canonical station になる（build-canonical-rail.js は node id で作る）ので、
//   way のような「路線名でまとめて配る」経路を通らず、取り違えが起きない。
//   事業者名をコードに直書きせずに分類するには、この operator / network が唯一の材料になる（§1）。
const KEEP_TAG_KEYS_STATION_NODE = new Set([...KEEP_TAG_KEYS,
  'operator', 'operator:en', 'network', 'station', 'public_transport', 'ref', 'wikidata']);

/** 駅 node 用（事業者を見分けるタグを含む）。 */
export function pickStationTags(tags) {
  const out = {};
  for (const k of Object.keys(tags || {})) if (KEEP_TAG_KEYS_STATION_NODE.has(k)) out[k] = tags[k];
  return out;
}
export function pickTags(tags, layer) {
  const keep = layer === 'waterways' ? KEEP_TAG_KEYS_WATERWAYS
    : layer === 'roads' ? KEEP_TAG_KEYS_ROADS
      : layer === 'railways' ? KEEP_TAG_KEYS_RAILWAYS
        : KEEP_TAG_KEYS;
  const out = {};
  for (const k of Object.keys(tags || {})) if (keep.has(k)) out[k] = tags[k];
  return out;
}

/** way tags がどのレイヤーに該当するか（enabledLayers の範囲で）。該当なしは null。 */
export function matchWayLayer(tags, enabledLayers) {
  for (const layer of enabledLayers) {
    const m = LAYER_TAG_MATCH[layer];
    if (m && m.way && m.way(tags)) return layer;
  }
  return null;
}

/** WGS84 bbox をメートル指定ぶん外側へ広げる（局所平面近似）。 */
export function expandBbox(bbox, meters, centerLat) {
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.cos((centerLat * Math.PI) / 180));
  return {
    south: bbox.south - dLat, north: bbox.north + dLat,
    west: bbox.west - dLon, east: bbox.east + dLon,
  };
}

/** node ref 列 → Overpass 互換 geometry（[{lat,lon}]）。未解決 node は落とし、欠落数も返す。 */
export function resolveGeometry(refs, coords) {
  const geometry = [];
  let missing = 0;
  for (const r of refs) {
    const c = coords.get(r);
    if (!c) { missing++; continue; }
    geometry.push({ lat: c[1], lon: c[0] });
  }
  return { geometry, missing };
}

function ptsBbox(pts) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const p of pts) {
    const lat = Array.isArray(p) ? p[1] : p.lat;
    const lon = Array.isArray(p) ? p[0] : p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { south: s, north: n, west: w, east: e };
}

export function geometryIntersectsBbox(pts, bbox) {
  const b = ptsBbox(pts);
  if (!Number.isFinite(b.south)) return false;
  return !(b.north < bbox.south || b.south > bbox.north || b.east < bbox.west || b.west > bbox.east);
}

export function pointInBbox(pt, bbox) {
  const lat = Array.isArray(pt) ? pt[1] : pt.lat;
  const lon = Array.isArray(pt) ? pt[0] : pt.lon;
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

/**
 * PBF primitive ストリームから大阪市24区の都市レイヤーを抽出する（純粋・osm-pbf-parser 非依存）。
 * @param {object} p
 * @param {() => AsyncIterable<object>} p.openPrimitiveStream  呼ぶたびに新しい primitive iterable を返す
 * @param {object} p.area                                       loadAreaConfig の結果
 * @param {string[]} [p.layers]                                 既定 ALL_LAYERS
 * @param {number} [p.bufferMeters=1000]
 * @returns {Promise<{layers:Record<string,object[]>, stats:object}>}
 */
export async function importOsmPbfCity({ openPrimitiveStream, area, layers, bufferMeters = 1000 }) {
  const enabledLayers = (layers && layers.length ? layers : ALL_LAYERS).filter((l) => ALL_LAYERS.includes(l));
  const wantRelations = enabledLayers.includes('waterways');
  const wantStations = enabledLayers.includes('railways');
  const bbox = expandBbox(area.bbox, bufferMeters, area.projection.centerLat);

  // ── pass 1: relations ──
  const targetRelations = [];
  const neededWayIds = new Set();
  const neededNodeIds = new Set();
  let t0 = Date.now();
  if (wantRelations) {
    for await (const prim of openPrimitiveStream()) {
      if (prim.type !== 'relation') continue;
      if (!LAYER_TAG_MATCH.waterways.relation(prim.tags)) continue;
      targetRelations.push({ id: prim.id, tags: prim.tags, members: prim.members });
      for (const m of prim.members) {
        if (m.type === 'way') neededWayIds.add(m.ref);
        else if (m.type === 'node') neededNodeIds.add(m.ref);
      }
    }
  }
  const pass1Ms = Date.now() - t0;

  // ── pass 2: ways ──
  const matchedWays = []; // {id, layer, tags, refs}
  const memberWayRefs = new Map(); // relation member way の id -> refs
  t0 = Date.now();
  for await (const prim of openPrimitiveStream()) {
    if (prim.type !== 'way') continue;
    const layer = matchWayLayer(prim.tags, enabledLayers);
    if (layer) {
      matchedWays.push({ id: prim.id, layer, tags: prim.tags, refs: prim.refs });
      for (const r of prim.refs) neededNodeIds.add(r);
    }
    if (neededWayIds.has(prim.id)) {
      memberWayRefs.set(prim.id, prim.refs);
      for (const r of prim.refs) neededNodeIds.add(r);
    }
  }
  const pass2Ms = Date.now() - t0;

  // ── pass 3: nodes ──
  const coords = new Map(); // nodeId -> [lon, lat]
  const stationNodes = []; // {id, tags, lat, lon}
  t0 = Date.now();
  for await (const prim of openPrimitiveStream()) {
    if (prim.type !== 'node') continue;
    if (neededNodeIds.has(prim.id) && Number.isFinite(prim.lat) && Number.isFinite(prim.lon)) {
      coords.set(prim.id, [prim.lon, prim.lat]);
    }
    if (wantStations && LAYER_TAG_MATCH.railways.node(prim.tags) && Number.isFinite(prim.lat) && Number.isFinite(prim.lon)) {
      stationNodes.push({ id: prim.id, tags: prim.tags, lat: prim.lat, lon: prim.lon });
    }
  }
  const pass3Ms = Date.now() - t0;

  // ── assemble（Overpass out geom 互換） ──
  const out = {};
  for (const l of enabledLayers) out[l] = [];

  let wayDroppedNoGeom = 0, wayDroppedOutside = 0, wayPartialGeom = 0;
  for (const w of matchedWays) {
    const { geometry, missing } = resolveGeometry(w.refs, coords);
    if (geometry.length < 2) { wayDroppedNoGeom++; continue; }
    if (!geometryIntersectsBbox(geometry, bbox)) { wayDroppedOutside++; continue; }
    if (missing > 0) wayPartialGeom++;
    out[w.layer].push({ type: 'way', id: w.id, tags: pickTags(w.tags, w.layer), geometry });
  }

  let relDroppedNoMembers = 0, relDroppedOutside = 0;
  for (const rel of targetRelations) {
    const members = [];
    for (const m of rel.members) {
      if (m.type !== 'way' || !memberWayRefs.has(m.ref)) continue;
      const { geometry } = resolveGeometry(memberWayRefs.get(m.ref), coords);
      if (geometry.length < 2) continue;
      members.push({ type: 'way', ref: m.ref, role: m.role, geometry });
    }
    if (!members.length) { relDroppedNoMembers++; continue; }
    if (!geometryIntersectsBbox(members.flatMap((m) => m.geometry), bbox)) { relDroppedOutside++; continue; }
    out.waterways.push({ type: 'relation', id: rel.id, tags: pickTags(rel.tags, 'waterways'), members });
  }

  let stationDroppedOutside = 0, stationKept = 0;
  for (const s of stationNodes) {
    if (!pointInBbox([s.lon, s.lat], bbox)) { stationDroppedOutside++; continue; }
    stationKept++;
    out.railways.push({ type: 'node', id: s.id, lat: s.lat, lon: s.lon, tags: pickStationTags(s.tags) });
  }

  const layerCounts = {};
  for (const l of enabledLayers) {
    const els = out[l];
    layerCounts[l] = {
      total: els.length,
      ways: els.filter((e) => e.type === 'way').length,
      relations: els.filter((e) => e.type === 'relation').length,
      nodes: els.filter((e) => e.type === 'node').length,
    };
  }

  return {
    layers: out,
    stats: {
      enabledLayers,
      bufferMeters,
      timing: { pass1Ms, pass2Ms, pass3Ms, totalMs: pass1Ms + pass2Ms + pass3Ms },
      relations: { target: targetRelations.length, memberWays: neededWayIds.size },
      ways: { matched: matchedWays.length, droppedNoGeom: wayDroppedNoGeom, droppedOutside: wayDroppedOutside, partialGeom: wayPartialGeom },
      nodes: { needed: neededNodeIds.size, resolved: coords.size },
      stations: { found: stationNodes.length, kept: stationKept, droppedOutside: stationDroppedOutside },
      relDropped: { noMembers: relDroppedNoMembers, outside: relDroppedOutside },
      layerCounts,
    },
  };
}

// ───────────────────────── CLI ─────────────────────────

const HELP = `tools/import/osm-pbf-city.js — OSM PBF から大阪市24区 都市レイヤーを抽出

使い方:
  node tools/import/osm-pbf-city.js --input <path.osm.pbf> [オプション]

オプション:
  --input <path>     入力 .osm.pbf（必須）
  --area <id>        エリア（既定: osaka-city）
  --layer <name>     roads | waterways | parks | railways | all（既定: all）
  --out <dir>        出力ディレクトリ（既定: data/raw/osaka-city）
  --buffer <m>       大阪市 bbox の外側マージン m（既定: 1000）
  --report <path>    レポート出力先（既定: data/reports/osm-pbf-import.json）
  --smoke            抽出せず PBF を1回だけ流し、node/way/relation が読めるか確認して終了
  --smoke-limit <n>  --smoke で読む primitive 数の上限（既定 0=全件。ソート済 PBF は少数だと node のみ）
  --help, -h         この使い方を表示して終了（ネットワーク・依存パッケージ不要）

前提:
  osm-pbf-parser が必要（package.json に追加済み。未インストールなら npm install）。
  入力は大阪周辺の extract を推奨（府全域〜関西でも動くが pass ごとに全ブロックを解凍する）。
  取得先例: BBBike extract (https://extract.bbbike.org/ で大阪を矩形選択) /
            Geofabrik "Kansai" (https://download.geofabrik.de/asia/japan/kansai.html) を
            osmium extract で大阪市 bbox に切ってから渡すとより速い。

出力後:
  node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force
  node tools/validate/city-layer-tiles.js --area osaka-city
`;

function parseArgs(argv) {
  const a = { input: null, area: 'osaka-city', layer: 'all', out: null, buffer: 1000, report: null, help: false, smoke: false, smokeLimit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--input') a.input = argv[++i];
    else if (k === '--area') a.area = argv[++i];
    else if (k === '--layer') a.layer = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--buffer') a.buffer = parseInt(argv[++i], 10) || 1000;
    else if (k === '--report') a.report = argv[++i];
    else if (k === '--smoke') a.smoke = true;
    else if (k === '--smoke-limit') a.smokeLimit = parseInt(argv[++i], 10) || 0;
  }
  return a;
}

/** PBF を1回だけ流し、node/way/relation が読めるか確認する（抽出しない）。 */
async function runSmoke(inputPath, limit) {
  const counts = { node: 0, way: 0, relation: 0, other: 0 };
  const samples = {};
  const t0 = Date.now();
  let total = 0;
  for await (const p of pbfPrimitiveStream(inputPath)) {
    const t = counts[p.type] != null ? p.type : 'other';
    counts[t]++;
    if (!samples[p.type]) {
      samples[p.type] = p.type === 'node'
        ? { id: p.id, lat: p.lat, lon: p.lon, tagKeys: Object.keys(p.tags) }
        : p.type === 'way'
          ? { id: p.id, refs: p.refs.length, tagKeys: Object.keys(p.tags) }
          : { id: p.id, members: (p.members || []).length, tagKeys: Object.keys(p.tags) };
    }
    total++;
    if (limit && total >= limit) break;
  }
  const ms = Date.now() - t0;
  console.log('=== OSM PBF smoke ===');
  console.log(`  読んだ primitive: ${total}  (${ms} ms)`);
  console.log(`  node ${counts.node} / way ${counts.way} / relation ${counts.relation} / other ${counts.other}`);
  for (const t of ['node', 'way', 'relation']) {
    console.log(`  first ${t}: ${samples[t] ? JSON.stringify(samples[t]) : '(なし)'}`);
  }
  const ok = counts.node > 0 && counts.way > 0 && counts.relation > 0;
  if (!ok && !limit) console.error('  ✗ node/way/relation のいずれかが読めていません（parser 接続を確認）');
  else if (!ok) console.log('  (--smoke-limit 指定のため way/relation まで到達していない可能性。--smoke-limit 0 で全件確認)');
  else console.log('  ✓ node/way/relation いずれも読めています');
  process.exit(ok || limit ? 0 : 1);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (!args.input) { console.error('--input <path.osm.pbf> が必要です。--help を参照。'); process.exit(2); }

  const inputPath = resolveProjectPath(args.input);
  if (!fs.existsSync(inputPath)) { console.error(`入力が見つかりません: ${inputPath}`); process.exit(2); }
  const inputSize = fs.statSync(inputPath).size;

  if (args.smoke) { await runSmoke(inputPath, args.smokeLimit); return; }

  const area = await loadAreaConfig(args.area);
  const layers = args.layer === 'all' ? ALL_LAYERS : [args.layer];
  const outDir = resolveProjectPath(args.out || path.join('data', 'raw', 'osaka-city'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log('=== OSM PBF import（大阪市24区 都市レイヤー）===');
  console.log(`input : ${toProjectRelativePath(inputPath)} (${fmtBytes(inputSize)})`);
  console.log(`area  : ${area.id}  layers: ${layers.join(', ')}  buffer: ${args.buffer}m`);
  console.log('PBF を3回ストリームします（relations → ways → nodes）。少し時間がかかります...');

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
  if (typeof sampler.unref === 'function') sampler.unref();

  const startedAt = Date.now();
  let result;
  try {
    result = await importOsmPbfCity({
      openPrimitiveStream: () => pbfPrimitiveStream(inputPath),
      area, layers, bufferMeters: args.buffer,
    });
  } finally {
    clearInterval(sampler);
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const wallMs = Date.now() - startedAt;

  const written = [];
  for (const layer of layers) {
    const elements = result.layers[layer] || [];
    const outPath = path.join(outDir, `${layer}-osm.json`);
    const payload = {
      elements,
      _meta: {
        source: 'osm-pbf', parser: 'osm-pbf-parser',
        input: toProjectRelativePath(inputPath), layer, area: area.id,
        bufferMeters: args.buffer, generatedAt: new Date().toISOString(),
        counts: result.stats.layerCounts[layer],
      },
    };
    fs.writeFileSync(outPath, JSON.stringify(payload));
    const size = fs.statSync(outPath).size;
    written.push({ layer, path: toProjectRelativePath(outPath), bytes: size, count: elements.length });
  }

  const perf = {
    pbfBytes: inputSize,
    parseMs: result.stats.timing,
    wallMs,
    peakRssBytes: peakRss,
    peakRssMB: Math.round(peakRss / 1024 / 1024),
  };

  const reportPath = resolveProjectPath(args.report || path.join('data', 'reports', 'osm-pbf-import.json'));
  await writeJson(reportPath, {
    generatedAt: new Date().toISOString(),
    input: toProjectRelativePath(inputPath),
    area: area.id, layers, buffer: args.buffer,
    perf, stats: result.stats, written,
  });

  console.log('\n--- 抽出結果 ---');
  for (const w of written) {
    const c = result.stats.layerCounts[w.layer];
    console.log(`  ${w.layer.padEnd(10)} elements ${String(w.count).padStart(7)}  (way ${c.ways} / relation ${c.relations} / node ${c.nodes})  ${fmtBytes(w.bytes)}  → ${w.path}`);
  }
  console.log('\n--- 性能 ---');
  console.log(`  PBF size      : ${fmtBytes(inputSize)}`);
  console.log(`  parse (pass1/2/3): ${result.stats.timing.pass1Ms} / ${result.stats.timing.pass2Ms} / ${result.stats.timing.pass3Ms} ms`);
  console.log(`  wall clock    : ${wallMs} ms`);
  console.log(`  peak RSS      : ${perf.peakRssMB} MB`);
  console.log(`  needed nodes  : ${result.stats.nodes.needed}  / resolved ${result.stats.nodes.resolved}`);
  console.log(`  ways partial geom (bbox端で node 欠落): ${result.stats.ways.partialGeom}`);
  console.log(`\nレポート: ${toProjectRelativePath(reportPath)}`);
  console.log('\n次:');
  console.log('  node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force');
  console.log('  node tools/validate/city-layer-tiles.js --area osaka-city');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('import でエラー:', e && e.message, e && e.stack); process.exit(1); });
}
