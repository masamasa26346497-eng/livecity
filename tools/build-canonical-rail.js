#!/usr/bin/env node
// tools/build-canonical-rail.js
// [Mission 31F §8] Canonical Rail 正式化。
//   既存 railways tile（Mission13/24 の continuity fix 済み geometry）を canonical 化する。
//   geometry = LineString / MultiLineString（rail は線が正。面ではない）。
//   属性: railway class / name / operator / bridge / tunnel / layer / lodClass(major/urban/local)。
//   ★ geometry と LOD 分類は分離（lodClass は attribute。derived で band 絞り込み）。
//   ★ Mission24 の continuity（同名路線の断片保持）を壊さない。
//
//   projection / znorth-neg-v1 不変。production / protected HTML 不変。
//   出力: data/processed/osaka-city/canonical/rail/{manifest.json, tile_*.json}
//         data/processed/osaka-city/canonical/rail/stations.json（駅は別 payload §17）
//         data/reports/canonical-rail-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import {
  COORDINATE_CONVENTION, CONFIDENCE, SOURCE_PRIORITY, makeProvenance, makeCanonicalFeature,
  validateCanonicalFeature, bboxOf,
} from './lib/canonical-geometry-schema.js';
import { classifyRail, railIncluded } from './lib/rail-lod.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAIL_TILES = P('public', 'map-data', 'osaka-city', 'railways');
const RAW = P('data', 'raw', 'osaka-city', 'railways-osm.json');
const AREA = P('config', 'areas', 'osaka-city.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
const REPORT = P('data', 'reports', 'canonical-rail-build.json');

const TILE_SIZE = 2000;
const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 2500;

function polylineLen(p) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; }

// raw から name→{operator,bridge,tunnel,layer} を引く（tile には無い属性の補完）。
//
// [Mission 35F §6] **これは路線名単位の補完であって、way 単位ではない**。
//   railway tile の feature は `{id,kind,railway,p,name,railClass}` しか持たず、元の OSM way id を
//   残していないので、way ごとのタグをここで正しく結び付けることはできない。
//   実際 `service`（yard / siding / crossover）を raw へ足して試したところ、
//   ある路線に 1 本でも側線があるとその路線の全 way が siding 扱いになり、
//   raw の siding 360 本が canonical で 1,485 本に膨れた。
//   そのため **way 単位のタグ（service）はここで配らない**。
//   本線と車両基地を canonical で区別するには tile に way id の lineage を持たせる必要があり、
//   それは tile パイプラインの変更なので別ミッション。
//   bridge / tunnel / layer も同じ性質の（way 単位の）タグなので、raw に入れるときは要注意。
function loadRawAttrs() {
  const byName = new Map();
  if (!fs.existsSync(RAW)) return byName;
  const j = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  for (const e of (j.elements || [])) {
    const t = e.tags || {};
    if (!t.railway || e.type !== 'way') continue;
    const nm = t['name:ja'] || t.name;
    if (!nm) continue;
    const cur = byName.get(nm) || { operator: null, bridge: false, tunnel: false, layer: 0, usage: null, service: null };
    if (t.operator) cur.operator = t.operator;
    if (t.bridge && t.bridge !== 'no') cur.bridge = true;
    if (t.tunnel && t.tunnel !== 'no') cur.tunnel = true;
    if (t.layer != null && Number.isFinite(+t.layer)) cur.layer = +t.layer;
    if (t.usage) cur.usage = t.usage;
    // service は way 単位。路線名で配ると誤る（上のコメント）。
    byName.set(nm, cur);
  }
  return byName;
}

async function main() {
  if (!fs.existsSync(RAIL_TILES)) { console.error('[canonical-rail] railways tile が無い'); process.exit(1); }
  const generatedAt = new Date().toISOString();
  const rawAttrs = loadRawAttrs();

  const seen = new Set();
  const lineFeats = [];
  const stations = [];
  const stats = {
    inputLines: 0, inputStations: 0,
    byLodClass: { major: 0, urban: 0, local: 0 }, byRailway: {},
    withName: 0, withOperator: 0, bridge: 0, tunnel: 0,
    rejected: { 'excluded-tag': 0, 'few-points': 0, 'bbox-violation': 0, 'zero-length': 0 },
    schemaErrors: 0,
  };

  for (const tf of fs.readdirSync(RAIL_TILES)) {
    if (!/^tile_.*\.json$/.test(tf)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(RAIL_TILES, tf), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (seen.has(ft.id)) continue;
      seen.add(ft.id);
      if (ft.kind === 'station') {
        stats.inputStations++;
        const p = Array.isArray(ft.p) && ft.p.length === 2 && typeof ft.p[0] === 'number' ? ft.p : (Array.isArray(ft.p) && ft.p[0] ? ft.p[0] : null);
        if (!p) continue;
        stations.push({ stationId: 'st_' + ft.id, name: ft.name || null, point: [+p[0].toFixed(2), +p[1].toFixed(2)], railwayRef: ft.railway || null });
        continue;
      }
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || ft.p.length < 2) { stats.rejected['few-points']++; continue; }
      stats.inputLines++;
      const railway = ft.railway || 'rail';
      if (!railIncluded(railway)) { stats.rejected['excluded-tag']++; continue; }
      const len = polylineLen(ft.p);
      if (len < 1) { stats.rejected['zero-length']++; continue; }
      const bb = bboxOf([ft.p]);
      if (bb.maxX < GROUND_EXTENT.minX - MARGIN || bb.minX > GROUND_EXTENT.maxX + MARGIN
        || bb.maxZ < GROUND_EXTENT.minZ - MARGIN || bb.minZ > GROUND_EXTENT.maxZ + MARGIN) { stats.rejected['bbox-violation']++; continue; }

      const lodClass = classifyRail(railway, len);
      const name = ft.name || null;
      const ra = name ? (rawAttrs.get(name) || {}) : {};
      const prov = makeProvenance({
        geometrySource: 'osm-rail',
        attributeSources: ['osm-rail', name ? 'osm-name' : null].filter(Boolean),
        confidence: CONFIDENCE.OSM_RAIL_CENTERLINE, // 0.75
        sourceIds: [ft.id],
        generatedAt,
        notes: `OSM railway=${railway}。Mission13/24 continuity 済み geometry。lodClass=${lodClass}（len ${Math.round(len)}m）。`,
      });
      const f = makeCanonicalFeature({
        canonicalId: 'cg_rail_' + ft.id.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60),
        layer: 'rail', geometryType: 'LineString', coordinates: ft.p.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
        provenance: prov,
        attributes: {
          name, railway,
          railClass: ft.railClass || null,   // 既存 tile の分類（Mission24）を保持
          lodClass,                          // §8: geometry と分離した LOD 分類（major/urban/local）
          operator: ra.operator || null,
          bridge: !!ra.bridge || null, tunnel: !!ra.tunnel || null,
          layer: ra.layer || null,
          usage: ra.usage || null, service: ra.service || null,
          lengthM: Math.round(len),
        },
        qaFlags: [
          ra.bridge ? 'bridge' : null, ra.tunnel ? 'tunnel' : null,
          railway === 'subway' ? 'underground' : null,
        ].filter(Boolean),
        centerlineRef: null, widthProfile: null,
      });
      const v = validateCanonicalFeature(f);
      if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
      lineFeats.push(f);
      stats.byLodClass[lodClass]++;
      stats.byRailway[railway] = (stats.byRailway[railway] || 0) + 1;
      if (name) stats.withName++;
      if (ra.operator) stats.withOperator++;
      if (ra.bridge) stats.bridge++;
      if (ra.tunnel) stats.tunnel++;
    }
  }

  // ── tile 化 ──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tileMap = new Map();
  for (const f of lineFeats) {
    for (let tx = Math.floor(f.bbox.minX / TILE_SIZE); tx <= Math.floor(f.bbox.maxX / TILE_SIZE); tx++)
      for (let tz = Math.floor(f.bbox.minZ / TILE_SIZE); tz <= Math.floor(f.bbox.maxZ / TILE_SIZE); tz++) {
        const k = tx + '_' + tz;
        if (!tileMap.has(k)) tileMap.set(k, []);
        tileMap.get(k).push(f);
      }
  }
  const tiles = [];
  for (const [k, feats] of [...tileMap.entries()].sort()) {
    const [tx, tz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(OUT_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: COORDINATE_CONVENTION, count: feats.length, features: feats }));
    tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
  }
  // stations は別 payload（§17: station label は別 layer）
  fs.writeFileSync(path.join(OUT_DIR, 'stations.json'), JSON.stringify({
    version: 1, layer: 'rail-stations', coordinateConvention: COORDINATE_CONVENTION, generatedAt,
    count: stations.length, stations,
  }));

  const bbox = bboxOf(lineFeats.map((f) => f.coordinates));
  // named route の一体性（Mission24 continuity）チェック用: 主要路線ごとの feature 数
  const byRoute = {};
  for (const f of lineFeats) if (f.attributes.name) byRoute[f.attributes.name] = (byRoute[f.attributes.name] || 0) + 1;
  const majorRoutes = Object.entries(byRoute).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 25);

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    version: 1, layer: 'rail', kind: 'canonical-geometry', coordinateConvention: COORDINATE_CONVENTION,
    generatedAt, tileSize: TILE_SIZE, featureCount: lineFeats.length, stationCount: stations.length, bbox,
    sourcePriority: SOURCE_PRIORITY.rail,
    byLodClass: stats.byLodClass, byRailway: stats.byRailway,
    namedRouteCount: Object.keys(byRoute).length,
    lodNote: 'lodClass(major/urban/local) は attribute。geometry は削らない。derived/ で band 絞り込み（§8/§17）。',
    simplification: 'none。LOD simplify は derived/ で。',
    tiles,
  }, null, 2));

  const report = {
    generatedAt, tileDir: toProjectRelativePath(OUT_DIR),
    inputLines: stats.inputLines, inputStations: stats.inputStations,
    featureCount: lineFeats.length, stationCount: stations.length,
    byLodClass: stats.byLodClass, byRailway: stats.byRailway,
    withName: stats.withName, withOperator: stats.withOperator, bridge: stats.bridge, tunnel: stats.tunnel,
    namedRoutes: Object.keys(byRoute).length,
    majorRoutesSample: majorRoutes.map(([name, n]) => ({ name, featureCount: n })),
    rejected: stats.rejected, schemaErrors: stats.schemaErrors,
    tiles: tiles.length, bbox,
    RESULT: (lineFeats.length > 1000 && stats.schemaErrors === 0) ? 'PASS' : (stats.schemaErrors > 0 ? 'SCHEMA-FAIL' : 'EMPTY'),
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-rail] lines=' + lineFeats.length + ' stations=' + stations.length + '  byLodClass=' + JSON.stringify(stats.byLodClass));
  console.log('  byRailway: ' + JSON.stringify(stats.byRailway) + '  named routes: ' + Object.keys(byRoute).length);
  console.log('  rejected: ' + JSON.stringify(stats.rejected) + '  schemaErrors=' + stats.schemaErrors + '  tiles=' + tiles.length);
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[canonical-rail] 失敗:', e && e.stack || e); process.exit(1); });
