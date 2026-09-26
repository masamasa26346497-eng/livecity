// tools/audit/urban-detail-source-audit.js
// [Mission 35X §1] 都市ディテールに使える **実データ** が OSM に何件あるかを数える。
//   推定で作る前に、まず実在量を測る。ここで 0 だったものだけが「推定 / visual only」の候補。
//   出力: data/reports/mission35x-urban-detail-layer/source-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const PBF = process.env.URBAN_PBF || 'data/raw/osm/osaka-full-coverage.osm.pbf';
const OUT = 'data/reports/mission35x-urban-detail-layer';

// 大阪市 24 区をおおよそ覆う緯度経度。bbox の外は数えない（全国データが混ざるため）。
const BBOX = { minLat: 34.50, maxLat: 34.82, minLon: 135.36, maxLon: 135.66 };
const inBox = (lat, lon) => lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

/** 数えたいもの。node 用と way 用を分ける。 */
const NODE_RULES = {
  traffic_signals: (t) => t.highway === 'traffic_signals',
  crossing_node: (t) => t.highway === 'crossing' || t.crossing != null,
  tree: (t) => t.natural === 'tree',
  bus_stop: (t) => t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes'),
  subway_entrance: (t) => t.railway === 'subway_entrance' || t.entrance === 'yes' && t.railway,
  post_office: (t) => t.amenity === 'post_office',
  police: (t) => t.amenity === 'police',
  fire_station: (t) => t.amenity === 'fire_station',
  toilets: (t) => t.amenity === 'toilets',
  bicycle_parking: (t) => t.amenity === 'bicycle_parking',
  vending_or_bench: (t) => t.amenity === 'bench' || t.amenity === 'vending_machine',
  hospital_poi: (t) => t.amenity === 'hospital' || t.amenity === 'clinic',
  school_poi: (t) => t.amenity === 'school' || t.amenity === 'university' || t.amenity === 'college',
  hotel_poi: (t) => t.tourism === 'hotel',
  shop_poi: (t) => !!t.shop,
};
const WAY_RULES = {
  tree_row: (t) => t.natural === 'tree_row',
  footway_sidewalk: (t) => t.highway === 'footway' && t.footway === 'sidewalk',
  footway_any: (t) => t.highway === 'footway' || t.highway === 'path' || t.highway === 'pedestrian',
  crossing_way: (t) => t.highway === 'footway' && t.footway === 'crossing',
  parking: (t) => t.amenity === 'parking',
  plaza: (t) => t.place === 'square' || t.highway === 'pedestrian' && t.area === 'yes' || t.leisure === 'common',
  median_barrier: (t) => t.barrier === 'kerb' || t.barrier === 'guard_rail',
  riverbank_path: (t) => (t.highway === 'footway' || t.highway === 'cycleway') && t.name != null,
  embankment: (t) => t.man_made === 'embankment' || t.embankment === 'yes',
  bridge_way: (t) => t.bridge != null && t.highway != null,
  grass_greenery: (t) => t.landuse === 'grass' || t.natural === 'scrub' || t.landuse === 'forest',
  park_way: (t) => t.leisure === 'park' || t.leisure === 'garden',
  water_way: (t) => t.natural === 'water' || t.waterway === 'riverbank',
};

const nodeCounts = {}; const wayCounts = {};
for (const k of Object.keys(NODE_RULES)) nodeCounts[k] = { total: 0, inBbox: 0, samples: [] };
for (const k of Object.keys(WAY_RULES)) wayCounts[k] = { total: 0, samples: [] };

let nodes = 0, ways = 0, rels = 0, taggedNodes = 0;
const t0 = Date.now();
for await (const p of pbfPrimitiveStream(PBF)) {
  if (p.type === 'node') {
    nodes++;
    const t = p.tags;
    if (!t || !Object.keys(t).length) continue;
    taggedNodes++;
    const ok = (p.lat != null && p.lon != null && inBox(p.lat, p.lon));
    for (const [k, fn] of Object.entries(NODE_RULES)) {
      let hit = false;
      try { hit = !!fn(t); } catch { hit = false; }
      if (!hit) continue;
      nodeCounts[k].total++;
      if (ok) {
        nodeCounts[k].inBbox++;
        if (nodeCounts[k].samples.length < 3) {
          nodeCounts[k].samples.push({ id: p.id, lat: p.lat, lon: p.lon, name: t.name || null });
        }
      }
    }
  } else if (p.type === 'way') {
    ways++;
    const t = p.tags;
    if (!t || !Object.keys(t).length) continue;
    for (const [k, fn] of Object.entries(WAY_RULES)) {
      let hit = false;
      try { hit = !!fn(t); } catch { hit = false; }
      if (!hit) continue;
      wayCounts[k].total++;
      if (wayCounts[k].samples.length < 3) wayCounts[k].samples.push({ id: p.id, name: t.name || null, refs: p.refs.length });
    }
  } else rels++;
  if ((nodes + ways) % 2_000_000 === 0) {
    process.stdout.write(`\r[35X audit] node ${nodes.toLocaleString()} / way ${ways.toLocaleString()} ` +
      `(${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}
process.stdout.write('\n');

const out = {
  version: 1, mission: '35X', generatedAt: new Date().toISOString(),
  source: PBF, bbox: BBOX,
  totals: { nodes, taggedNodes, ways, relations: rels, elapsedSec: Math.round((Date.now() - t0) / 1000) },
  nodes: nodeCounts, ways: wayCounts,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'source-audit.json'), JSON.stringify(out, null, 2));

console.log('== node tags (bbox 内) ==');
for (const [k, v] of Object.entries(nodeCounts).sort((a, b) => b[1].inBbox - a[1].inBbox)) {
  console.log('  ' + k.padEnd(20), String(v.inBbox).padStart(8), '(全国 ' + v.total.toLocaleString() + ')');
}
console.log('== way tags ==');
for (const [k, v] of Object.entries(wayCounts).sort((a, b) => b[1].total - a[1].total)) {
  console.log('  ' + k.padEnd(20), String(v.total).padStart(8));
}
console.log('out', path.join(OUT, 'source-audit.json'));
