#!/usr/bin/env node
// tools/audit/umeda-roof-evidence.js
// [Mission 35A §2/§3/§4/§5/§6] 梅田エリアで「屋根形状を推定する根拠になるデータが実際にあるか」を数える。
//   **geometry は作らない。証拠の在庫調査だけ。**
//
//   §4 の優先順位に沿って、repo 内で実際に使えるものを調べる:
//     1. 航空写真 / orthophoto        … repo 内を全走査して存在を確認
//     2. 既存 PLATEAU attributes      … measuredHeight / storeysAboveGround / usage
//     3. footprint geometry           … canonical LOD0
//     4. GSI 基盤地図情報 建築物外周線 … 航空写真からトレースされた屋根外縁
//     5. OSM の屋根タグ               … roof:shape / roof:orientation / roof:levels / roof:height
//   ※ 高さ・階数だけから屋根形状を決めてはいけない（§4）。ここではあくまで「証拠の有無」を測る。
//
//   実行: node --max-old-space-size=12288 tools/audit/umeda-roof-evidence.js
//   出力: data/reports/umeda-roof-evidence.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const EV = {
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  highDir: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high'),
  gsiOutline: P('data', 'processed', 'osaka-city', 'gsi-building-outline', 'building-outline-lines.json'),
  gsiArea: P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json'),
  landmarkModels: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmark-models.json'),
  scanRoot: P('data'),
  out: P('data', 'reports', 'umeda-roof-evidence.json'),
  cache: P('data', 'processed', 'osaka-city', 'umeda-roof', 'osm-roof-tags.json'),
};
// §2 梅田エリア（34D の主要エリア定義と同じ中心・半径）
export const UMEDA = { id: 'umeda', name: '梅田', x: -2668, z: -10942, radiusM: 700 };
// §5 航空写真として使える拡張子（repo 内に 1 つも無いことを示すため広めに取る）
export const IMAGERY_EXT = /\.(tif|tiff|jp2|ecw|sid|img|png|jpg|jpeg|webp|geotiff)$/i;
// QA スクリーンショットは航空写真ではない
export const NOT_IMAGERY_DIR = /(^|[\\/])(reports|node_modules|\.git)([\\/]|$)/i;
// §5 OSM の屋根タグ（これは実際に人が航空写真等を見て入れた観測値）
export const ROOF_TAGS = ['roof:shape', 'roof:orientation', 'roof:levels', 'roof:height', 'roof:material', 'roof:colour', 'building:roof:shape'];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const inUmeda = (x, z) => Math.hypot(x - UMEDA.x, z - UMEDA.z) <= UMEDA.radiusM;

export function ringCentroid(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (NOT_IMAGERY_DIR.test(p)) continue; yield* walk(p); }
    else yield p;
  }
}

/** §3 梅田の対象建物: canonical PLATEAU で、実 LOD2/LOD3 を持たないもの。 */
export function loadUmedaTargets() {
  const highIds = new Set();
  for (const f of fs.readdirSync(EV.highDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of ((rj(path.join(EV.highDir, f)) || {}).buildings || [])) highIds.add(b.canonicalId);
  }
  const landmarkSuppressed = new Set();
  for (const l of ((rj(EV.landmarkModels) || {}).landmarks || [])) {
    for (const id of (l.suppressBuildingIds || [])) landmarkSuppressed.add(id);
  }
  const targets = [], realHigh = [], osmFallback = [], landmark = [];
  const TILE = 500;
  const t0x = Math.floor((UMEDA.x - UMEDA.radiusM) / TILE), t1x = Math.floor((UMEDA.x + UMEDA.radiusM) / TILE);
  const t0z = Math.floor((UMEDA.z - UMEDA.radiusM) / TILE), t1z = Math.floor((UMEDA.z + UMEDA.radiusM) / TILE);
  const attrCache = new Map();
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const doc = rj(path.join(EV.canonDir, `tile_${tx}_${tz}.json`));
    if (!doc) continue;
    let attrs = attrCache.get(`${tx}_${tz}`);
    if (!attrs) { attrs = (rj(path.join(EV.canonDir, 'attributes', `tile_${tx}_${tz}.json`)) || {}).attributes || {}; attrCache.set(`${tx}_${tz}`, attrs); }
    for (const ft of (doc.features || [])) {
      const ring = ft.coordinates && ft.coordinates[0];
      if (!ring || ring.length < 3) continue;
      const c = ft.centroid || ringCentroid(ring);
      if (!inUmeda(c[0], c[1])) continue;
      const a = attrs[ft.canonicalId] || {};
      const rec = { canonicalId: ft.canonicalId, ring, centroid: c, areaM2: ft.areaM2,
        heightM: a.heightM ?? null, heightSource: a.heightSource ?? null, heightUnknown: !!a.heightUnknown,
        usageCategory: a.usageCategory ?? null, usage: a.usage ?? null,
        source: (ft.source && ft.source.geometrySource) || null };
      if (rec.source !== 'plateau-building') { osmFallback.push(rec); continue; }
      if (landmarkSuppressed.has(ft.canonicalId)) { landmark.push(rec); continue; }
      if (highIds.has(ft.canonicalId)) { realHigh.push(rec); continue; }
      targets.push(rec);
    }
  }
  return { targets, realHigh, osmFallback, landmark };
}

/** §5 OSM の屋根タグを PBF から拾う（way の tags と、ring を組むための node 座標）。 */
async function scanOsmRoofTags() {
  const cached = rj(EV.cache);
  if (cached) return cached;
  const ways = new Map();
  let buildingWays = 0, withRoofTag = 0;
  for await (const p of pbfPrimitiveStream(EV.pbf)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    if (!t.building && !t['building:part']) continue;
    buildingWays++;
    const roof = {};
    for (const k of ROOF_TAGS) if (t[k] != null) roof[k] = String(t[k]);
    if (!Object.keys(roof).length) continue;
    withRoofTag++;
    ways.set(p.id, { refs: p.refs, roof, building: t.building || t['building:part'], name: t.name || null,
      height: t.height || null, levels: t['building:levels'] || null });
  }
  const need = new Set();
  for (const v of ways.values()) for (const r of v.refs) need.add(r);
  const coord = new Map();
  for await (const p of pbfPrimitiveStream(EV.pbf)) {
    if (p.type !== 'node' || !need.has(p.id)) continue;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) coord.set(p.id, [p.lat, p.lon]);
  }
  const out = { buildingWays, withRoofTag, buildings: [] };
  for (const [wid, v] of ways) {
    const ring = [];
    for (const r of v.refs) { const ll = coord.get(r); if (ll) { const w = latLonToLiveCityWorld(ll[0], ll[1]); ring.push([+w.x.toFixed(2), +w.z.toFixed(2)]); } }
    if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) continue;
    const c = ringCentroid(ring);
    out.buildings.push({ wayId: wid, roof: v.roof, building: v.building, name: v.name,
      height: v.height, levels: v.levels, centroid: [+c[0].toFixed(2), +c[1].toFixed(2)], ring });
  }
  fs.mkdirSync(path.dirname(EV.cache), { recursive: true });
  fs.writeFileSync(EV.cache, JSON.stringify(out));
  return out;
}

export async function run() {
  const t0 = Date.now();

  // ── §5 航空写真は repo にあるか ────────────────────────────────────────
  const imagery = [];
  for (const p of walk(EV.scanRoot)) {
    if (!IMAGERY_EXT.test(p)) continue;
    const rel = path.relative(resolveProjectPath('.'), p).replace(/\\/g, '/');
    let bytes = 0; try { bytes = fs.statSync(p).size; } catch { /* noop */ }
    imagery.push({ path: rel, bytes });
  }
  console.log('[evidence] repo 内の画像（QA screenshot を除く）', imagery.length);

  // ── §3 梅田の対象 ─────────────────────────────────────────────────────
  const { targets, realHigh, osmFallback, landmark } = loadUmedaTargets();
  console.log('[evidence] 梅田', { targets: targets.length, realHigh: realHigh.length, osmFallback: osmFallback.length, landmark: landmark.length });

  // ── §4-2/§4-3 PLATEAU attributes と footprint ─────────────────────────
  const withHeight = targets.filter((t) => typeof t.heightM === 'number' && !t.heightUnknown).length;
  const heightSources = targets.reduce((a, t) => { const k = t.heightSource || '(none)'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const usage = targets.reduce((a, t) => { const k = t.usageCategory || '(none)'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const areaBuckets = { '<50': 0, '50-200': 0, '200-1000': 0, '1000-5000': 0, '>=5000': 0 };
  for (const t of targets) {
    const a = t.areaM2 || 0;
    if (a < 50) areaBuckets['<50']++; else if (a < 200) areaBuckets['50-200']++;
    else if (a < 1000) areaBuckets['200-1000']++; else if (a < 5000) areaBuckets['1000-5000']++;
    else areaBuckets['>=5000']++;
  }

  // ── §4-4 GSI 建築物外周線（航空写真からトレースされた屋根外縁）──────────
  const gsiL = rj(EV.gsiOutline), gsiA = rj(EV.gsiArea);
  let gsiInUmeda = 0, gsiTotal = 0, gsiClosedInUmeda = 0;
  const gsiDates = {};
  if (gsiL) {
    // 形は { features: [{ geometry: { type:'LineString', coordinates:[[x,z],…] }, closed, sourceDate }] }
    const lines = gsiL.features || gsiL.lines || [];
    gsiTotal = lines.length;
    for (const ln of lines) {
      const pts = (ln.geometry && ln.geometry.coordinates) || ln.coordinates;
      if (!Array.isArray(pts) || !pts.length) continue;
      const c = ringCentroid(pts);
      if (!inUmeda(c[0], c[1])) continue;
      gsiInUmeda++;
      if (ln.closed) gsiClosedInUmeda++;
      const d = ln.sourceDate || '(none)';
      gsiDates[d] = (gsiDates[d] || 0) + 1;
    }
  }

  // ── §5 OSM の屋根タグ ─────────────────────────────────────────────────
  console.log('[evidence] OSM 屋根タグを走査…');
  const osm = await scanOsmRoofTags();
  const osmUmeda = osm.buildings.filter((b) => inUmeda(b.centroid[0], b.centroid[1]));
  const roofShapeCounts = {};
  for (const b of osm.buildings) { const s = b.roof['roof:shape']; if (s) roofShapeCounts[s] = (roofShapeCounts[s] || 0) + 1; }
  const roofShapeUmeda = {};
  for (const b of osmUmeda) { const s = b.roof['roof:shape']; if (s) roofShapeUmeda[s] = (roofShapeUmeda[s] || 0) + 1; }
  const tagCounts = {};
  for (const b of osm.buildings) for (const k of Object.keys(b.roof)) tagCounts[k] = (tagCounts[k] || 0) + 1;

  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35A',
    area: UMEDA,
    // §5/§6 航空写真は使えるか
    aerialImagery: {
      filesFound: imagery.length,
      note: imagery.length ? '内容を確認すること' : 'repo 内に航空写真 / orthophoto は 1 件も無い（QA screenshot は除外して走査）',
      sample: imagery.slice(0, 10),
      networkFetch: 'このサンドボックスからは取得できない（過去ミッションと同じ制約）',
    },
    // §3 対象
    umeda: {
      canonicalPlateauTotal: targets.length + realHigh.length + landmark.length,
      realHighLod: realHigh.length,
      landmarkHd: landmark.length,
      osmFallback: osmFallback.length,
      lod1OnlyTargets: targets.length,
    },
    // §4 使える属性
    plateauAttributes: { withTrustedHeight: withHeight, heightSources, usageCategories: usage, areaBuckets },
    // §4-4 GSI
    gsiBuildingOutline: { totalLines: gsiTotal, inUmeda: gsiInUmeda, closedInUmeda: gsiClosedInUmeda,
      sourceDatesInUmeda: gsiDates,
      areaPolygons: gsiA ? (gsiA.polygons || gsiA.features || []).length : 0,
      note: 'GSI 基盤地図情報の建築物外周線は航空写真からトレースされた「屋根の外縁」。ただし ridge 方向・塔屋・段差は含まない。' },
    // §5 OSM 屋根タグ
    osmRoofTags: {
      buildingWaysScanned: osm.buildingWays, withAnyRoofTag: osm.withRoofTag,
      tagCounts, roofShapeCounts,
      inUmeda: osmUmeda.length, roofShapeInUmeda: roofShapeUmeda,
      note: 'OSM の roof:shape は人が航空写真等を見て入れた観測値。高さ・階数からの推定ではない。',
    },
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(EV.out), { recursive: true });
  fs.writeFileSync(EV.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[evidence] 航空写真', o.aerialImagery.filesFound, '件');
    console.log('[evidence] 梅田', JSON.stringify(o.umeda));
    console.log('[evidence] GSI 外周線 梅田内', o.gsiBuildingOutline.inUmeda, '/ 全', o.gsiBuildingOutline.totalLines);
    console.log('[evidence] OSM 屋根タグ 全市', o.osmRoofTags.withAnyRoofTag, '/ 梅田', o.osmRoofTags.inUmeda);
    console.log('[evidence] roof:shape 全市', JSON.stringify(o.osmRoofTags.roofShapeCounts));
    console.log('[evidence] roof:shape 梅田', JSON.stringify(o.osmRoofTags.roofShapeInUmeda));
    console.log('[evidence] out', EV.out);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
