#!/usr/bin/env node
// tools/audit/v2-final-overlap.js
// [Mission 32P §5-§10] Corrected V2 + OSM fallback V2（600,764 棟）で、道路・水域との重なりを全市で測り直す。
//
//   建物: data/processed/osaka-city/canonical/buildings-v2-osmv2（32O）
//   DarkRoad: FIX13 = canonical roads（refined classMap の非 carriageway を除く）/ ROAD V2 / ROAD V3 の carriageway 帯
//             （Mission 32I・32N と同じ定義。ROAD V3 の geometry は変更しない）
//   Water: canonical water（hole を抜く）
//   1m ラスタ（scanline）で、建物 1 棟ごとに重なり面積・水域への食い込み深さを数える。
//   過去の値（V1 建物で測った 32I / 32N の値）は historical として別に載せるだけで、流用しない。
//
//   出力:
//     data/processed/osaka-city/v2-final/building-overlaps.json   … 重なりのある建物ごとの計測値（placement 用）
//     data/reports/v2-final-road-overlap.json
//     data/reports/v2-final-water-overlap.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readFileRetry, writeFilesVerified } from '../lib/synced-dir-writer.js';
import { scanFill, fillBits, waterDepth } from '../lib/scanline-raster.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const VF = {
  buildings: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  roads: P('data', 'processed', 'osaka-city', 'canonical', 'roads'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  refined: P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'),
  roadV2: P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles'),
  roadV3: P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v3', 'tiles'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  area: P('config', 'areas', 'osaka-city.json'),
  gsiBuildings: P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json'),
  report32n: P('data', 'reports', 'building-canonical-v2-corrected.json'),
  report32i: P('data', 'reports', 'road-visual-v3.json'),
  workDir: P('data', 'processed', 'osaka-city', 'v2-final'),
  roadReport: P('data', 'reports', 'v2-final-road-overlap.json'),
  waterReport: P('data', 'reports', 'v2-final-water-overlap.json'),
};
const rj = (p) => JSON.parse(readFileRetry(p));
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const GRID = 250;
const WATER_PAD = 30;           // 水域の深さを 30m まで正しく測るための余白
export const SHORELINE_DEPTH_M = 3;
export const GSI_CONFIRM_COVER = 0.5;        // GSI 建物面が footprint の半分以上を覆えば「建物は実在」
export const DEEP_WATER_STRUCTURE_M = 10;    // GSI で実在確認 かつ 水面へ 10m 以上入る → 水上構造
// 実在の水上・水辺構造（Mission 31G-FIX6 の EXEMPT_SEMANTIC と同じ語彙）
export const STRUCTURE_LABEL_RE = /駅|停車場|プラット|ホーム|橋|高架|歩廊|アーケード|回廊|港湾|埠頭|ふ頭|岸壁|物揚|上屋|水門|樋門|閘門|排水機場|ポンプ場|揚水機|ゲート|桟橋|船|渡船|フェリー/;
const OSM_STRUCTURE = (t) => (t.man_made && /^(pier|breakwater|groyne|quay|bridge|dyke|floating_dock|jetty)$/.test(t.man_made))
  || (t.building && /^(boathouse|houseboat|bridge|ship|pontoon)$/.test(t.building))
  || t.bridge === 'yes' && !!t.building || t['building:bridge'] || t.floating === 'yes'
  || t.amenity === 'ferry_terminal' || t.waterway === 'boatyard' || t.waterway === 'dock';

const polysOf = (f) => (f.geometryType === 'Polygon' ? [f.coordinates] : f.geometryType === 'MultiPolygon' ? f.coordinates : []).filter((p) => p && p[0] && p[0].length >= 3);
const bbOfRings = (rings) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const r of rings) for (const [x, z] of r) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; } return { minX: a, maxX: b, minZ: c, maxZ: d }; };

function makeGrid() { return new Map(); }
function gridAdd(grid, bb, item) {
  for (let gx = Math.floor(bb.minX / GRID); gx <= Math.floor(bb.maxX / GRID); gx++)
    for (let gz = Math.floor(bb.minZ / GRID); gz <= Math.floor(bb.maxZ / GRID); gz++) {
      const k = gx + ',' + gz; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(item);
    }
}
function gridQuery(grid, bb) {
  const out = new Set();
  for (let gx = Math.floor(bb.minX / GRID); gx <= Math.floor(bb.maxX / GRID); gx++)
    for (let gz = Math.floor(bb.minZ / GRID); gz <= Math.floor(bb.maxZ / GRID); gz++)
      for (const it of grid.get(gx + ',' + gz) || []) out.add(it);
  return out;
}
const bbHit = (a, b) => a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;

export function loadSources() {
  const refined = rj(VF.refined);
  const nonPrimary = new Set(Object.keys(refined.classMap || {}).map((k) => (refined.keyPrefix || '') + k));
  const roads = makeGrid(), q2 = makeGrid(), q3 = makeGrid(), water = makeGrid();
  const waterList = [];
  const seen = new Set();
  let nRoads = 0, nQ2 = 0, nQ3 = 0;
  for (const f of fs.readdirSync(VF.roads)) {
    if (!isTile(f)) continue;
    for (const ft of rj(path.join(VF.roads, f)).features) {
      if (seen.has(ft.canonicalId)) continue; seen.add(ft.canonicalId);
      if (nonPrimary.has(ft.canonicalId)) continue;
      for (const poly of polysOf(ft)) { const it = { rings: poly, bb: bbOfRings([poly[0]]) }; gridAdd(roads, it.bb, it); nRoads++; }
    }
  }
  for (const [dir, grid, key] of [[VF.roadV2, q2, 'v2'], [VF.roadV3, q3, 'v3']]) {
    for (const f of fs.readdirSync(dir)) {
      if (!isTile(f)) continue;
      for (const rec of rj(path.join(dir, f)).features || []) {
        if (!Array.isArray(rec.carriageway)) continue;
        for (const q of rec.carriageway) { if (!q || q.length < 3) continue; const it = { rings: [q], bb: bbOfRings([q]) }; gridAdd(grid, it.bb, it); if (key === 'v2') nQ2++; else nQ3++; }
      }
    }
  }
  seen.clear();
  for (const f of fs.readdirSync(VF.water)) {
    if (!isTile(f)) continue;
    for (const ft of rj(path.join(VF.water, f)).features) {
      if (seen.has(ft.canonicalId)) continue; seen.add(ft.canonicalId);
      const a = ft.attributes || {};
      const polys = polysOf(ft);
      if (!polys.length) continue;
      const w = { idx: waterList.length, id: ft.canonicalId, name: a.name || null, waterClass: a.waterClass || null, polys, bb: bbOfRings(polys.map((p) => p[0])) };
      waterList.push(w);
      gridAdd(water, w.bb, w);
    }
  }
  return { roads, q2, q3, water, waterList, counts: { fix13Polygons: nRoads, v2Quads: nQ2, v3Quads: nQ3, waterFeatures: waterList.length } };
}

const BIT = { F13: 1, V2: 2, V3: 4, W: 8, B: 16 };

/** 1 つのラスタ範囲にマスクを作る。 */
function buildMasks(g, src, { withWater = true } = {}) {
  const mask = new Uint8Array(g.nx * g.nz);
  const wIdx = withWater ? new Int32Array(g.nx * g.nz) : null;
  const bb = { minX: g.minX, maxX: g.minX + g.nx, minZ: g.minZ, maxZ: g.minZ + g.nz };
  for (const it of gridQuery(src.roads, bb)) if (bbHit(it.bb, bb)) fillBits(g, mask, it.rings, BIT.F13);
  for (const it of gridQuery(src.q2, bb)) if (bbHit(it.bb, bb)) fillBits(g, mask, it.rings, BIT.V2);
  for (const it of gridQuery(src.q3, bb)) if (bbHit(it.bb, bb)) fillBits(g, mask, it.rings, BIT.V3);
  let anyWater = false;
  if (withWater) {
    for (const w of gridQuery(src.water, bb)) {
      if (!bbHit(w.bb, bb)) continue;
      for (const poly of w.polys) {
        const n = scanFill(g, poly, (i, j) => { const k = j * g.nx + i; mask[k] |= BIT.W; wIdx[k] = w.idx + 1; });
        if (n) anyWater = true;
      }
    }
  }
  return { mask, wIdx, anyWater };
}

export function measureAll(src, onTile) {
  const results = [];   // 重なりのある建物
  const totals = { buildings: 0, areaM2: 0, f13: 0, v2: 0, v3: 0, water: 0, touchF13: 0, touchV2: 0, touchV3: 0, touchWater: 0 };
  const files = fs.readdirSync(VF.buildings).filter(isTile);
  let done = 0;
  for (const f of files) {
    const t = rj(path.join(VF.buildings, f));
    const at = rj(path.join(VF.buildings, 'attributes', f)).attributes;
    const feats = t.features;
    let bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const ft of feats) { const b = ft.bbox; bb = { minX: Math.min(bb.minX, b.minX), maxX: Math.max(bb.maxX, b.maxX), minZ: Math.min(bb.minZ, b.minZ), maxZ: Math.max(bb.maxZ, b.maxZ) }; }
    const g = { minX: Math.floor(bb.minX) - WATER_PAD, minZ: Math.floor(bb.minZ) - WATER_PAD };
    g.nx = Math.ceil(bb.maxX) + WATER_PAD - g.minX; g.nz = Math.ceil(bb.maxZ) + WATER_PAD - g.minZ;
    const { mask, wIdx, anyWater } = buildMasks(g, src);
    let depth = null;
    if (anyWater) { const isW = new Uint8Array(mask.length); for (let k = 0; k < mask.length; k++) isW[k] = mask[k] & BIT.W ? 1 : 0; depth = waterDepth(g, isW); }
    for (const ft of feats) {
      const a = at[ft.canonicalId] || {};
      let area = 0, c13 = 0, c2 = 0, c3 = 0, cw = 0, maxD = 0;
      const wHits = new Map();
      scanFill(g, [ft.coordinates[0]], (i, j) => {
        const k = j * g.nx + i, m = mask[k];
        area++;
        if (m & BIT.F13) c13++; if (m & BIT.V2) c2++; if (m & BIT.V3) c3++;
        if (m & BIT.W) { cw++; const d = depth[k]; if (d > maxD) maxD = d; const wi = wIdx[k]; wHits.set(wi, (wHits.get(wi) || 0) + 1); }
      });
      totals.buildings++; totals.areaM2 += area;
      totals.f13 += c13; totals.v2 += c2; totals.v3 += c3; totals.water += cw;
      if (c13) totals.touchF13++; if (c2) totals.touchV2++; if (c3) totals.touchV3++; if (cw) totals.touchWater++;
      if (c13 || c2 || c3 || cw) {
        let topW = null, topN = 0; for (const [wi, n] of wHits) if (n > topN) { topN = n; topW = wi - 1; }
        results.push({
          id: ft.canonicalId, tile: f.slice(5, -5), area, f13: c13, v2: c2, v3: c3, w: cw,
          wDepth: cw ? +Math.min(maxD, WATER_PAD).toFixed(1) : 0, wIdx: topW,
          src: a.source, ward: a.wardId || null, label: a.usageLabel || null, conf: a.confidence ?? null,
          c: ft.centroid, bb: ft.bbox, ring: cw ? ft.coordinates[0] : undefined,
        });
      }
    }
    done++;
    if (onTile && done % 100 === 0) onTile(done, files.length, totals);
  }
  return { results, totals };
}

/** サイト（1km 四方）での union 面積（32N と同じ定義）+ 建物単位の touching。 */
export function measureSite(src, site, R = 500) {
  const g = { minX: Math.round(site.x) - R, minZ: Math.round(site.z) - R, nx: 2 * R, nz: 2 * R };
  const { mask } = buildMasks(g, src);
  const bb = { minX: g.minX, maxX: g.minX + g.nx, minZ: g.minZ, maxZ: g.minZ + g.nz };
  let buildings = 0; const touch = { f13: 0, v2: 0, v3: 0, water: 0 };
  for (let tx = Math.floor(bb.minX / 500) - 1; tx <= Math.floor(bb.maxX / 500) + 1; tx++)
    for (let tz = Math.floor(bb.minZ / 500) - 1; tz <= Math.floor(bb.maxZ / 500) + 1; tz++) {
      const p = path.join(VF.buildings, `tile_${tx}_${tz}.json`);
      if (!fs.existsSync(p)) continue;
      for (const ft of rj(p).features) {
        if (!bbHit(ft.bbox, bb)) continue;
        const inside = ft.centroid[0] >= bb.minX && ft.centroid[0] < bb.maxX && ft.centroid[1] >= bb.minZ && ft.centroid[1] < bb.maxZ;
        const hit = { f13: false, v2: false, v3: false, water: false };
        scanFill(g, [ft.coordinates[0]], (i, j) => {
          const k = j * g.nx + i, m = mask[k];
          mask[k] |= BIT.B;
          if (m & BIT.F13) hit.f13 = true; if (m & BIT.V2) hit.v2 = true; if (m & BIT.V3) hit.v3 = true; if (m & BIT.W) hit.water = true;
        });
        if (inside) { buildings++; for (const k in hit) if (hit[k]) touch[k]++; }
      }
    }
  let bArea = 0; const ov = { f13: 0, v2: 0, v3: 0, water: 0 };
  for (const m of mask) {
    if (!(m & BIT.B)) continue;
    bArea++;
    if (m & BIT.F13) ov.f13++; if (m & BIT.V2) ov.v2++; if (m & BIT.V3) ov.v3++; if (m & BIT.W) ov.water++;
  }
  const ratio = (x) => (bArea ? +(x / bArea).toFixed(5) : null);
  return {
    center: [site.x, site.z], halfSizeM: R, buildings, buildingAreaM2: bArea,
    FIX13: { overlapM2: ov.f13, buildingsTouching: touch.f13, overlapRatio: ratio(ov.f13) },
    ROAD_V2: { overlapM2: ov.v2, buildingsTouching: touch.v2, overlapRatio: ratio(ov.v2) },
    ROAD_V3: { overlapM2: ov.v3, buildingsTouching: touch.v3, overlapRatio: ratio(ov.v3) },
    water: { overlapM2: ov.water, buildingsTouching: touch.water, overlapRatio: ratio(ov.water) },
  };
}

// ── 水域の重なりの分類（§9） ──
async function osmEvidence(waterHits) {
  // 重なりのある建物の周囲（200m）だけ OSM を読む
  const keys = new Set();
  const K = 200;
  for (const r of waterHits) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) keys.add((Math.floor(r.c[0] / K) + dx) + ',' + (Math.floor(r.c[1] / K) + dz));
  const proj = rj(VF.area).projection;
  const KX = Math.cos((proj.centerLat * Math.PI) / 180) * proj.metersPerDegree;
  const toXZ = (lat, lon) => [(lon - proj.centerLon) * KX, -(lat - proj.centerLat) * proj.metersPerDegree];
  const ways = new Map();
  for await (const p of pbfPrimitiveStream(VF.pbf)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    const isB = !!t.building, isS = OSM_STRUCTURE(t);
    if (!isB && !isS) continue;
    ways.set(p.id, { refs: p.refs, b: isB, s: isS, tag: isS ? Object.entries(t).filter(([k]) => /man_made|building|bridge|floating|amenity|waterway/.test(k)).map(([k, v]) => k + '=' + v).join(';') : null });
  }
  const need = new Set(); for (const w of ways.values()) for (const r of w.refs) need.add(r);
  const nodes = new Map();
  for await (const p of pbfPrimitiveStream(VF.pbf)) {
    if (p.type !== 'node' || !need.has(p.id)) continue;
    const xz = toXZ(p.lat, p.lon);
    if (!keys.has(Math.floor(xz[0] / K) + ',' + Math.floor(xz[1] / K))) continue;
    nodes.set(p.id, xz);
  }
  const bGrid = makeGrid(), sGrid = makeGrid();
  const nearCount = new Map();
  for (const w of ways.values()) {
    const ring = []; let ok = true;
    for (const r of w.refs) { const c = nodes.get(r); if (!c) { ok = false; break; } ring.push(c); }
    if (!ok || ring.length < 2) continue;
    const it = { ring, bb: bbOfRings([ring]), tag: w.tag, closed: ring.length >= 4 };
    if (w.b && it.closed) {
      gridAdd(bGrid, it.bb, it);
      const ck = Math.floor(it.bb.minX / K) + ',' + Math.floor(it.bb.minZ / K);
      nearCount.set(ck, (nearCount.get(ck) || 0) + 1);
    }
    if (w.s) gridAdd(sGrid, it.bb, it);
  }
  // 国土地理院の建物面（OSM とは独立の出典）
  const gGrid = makeGrid();
  if (fs.existsSync(VF.gsiBuildings)) {
    for (const f of rj(VF.gsiBuildings).features || []) {
      const ring = Array.isArray(f.coordinates[0][0]) ? f.coordinates[0] : f.coordinates;
      if (!ring || ring.length < 3) continue;
      const bb = bbOfRings([ring]);
      if (!keys.has(Math.floor(bb.minX / K) + ',' + Math.floor(bb.minZ / K))) continue;
      gridAdd(gGrid, bb, { ring, bb });
    }
  }
  return { bGrid, sGrid, gGrid, nearCount, K };
}

export function classifyWater(r, ev, w) {
  const ratio = r.w / r.area;
  const semantic = !!(r.label && STRUCTURE_LABEL_RE.test(r.label));
  // OSM 構造物（桟橋・橋・船着場など）と重なるか（線 feature は bbox 交差で判定）
  let structure = null;
  for (const it of gridQuery(ev.sGrid, r.bb)) if (bbHit(it.bb, r.bb)) { structure = it.tag; break; }
  // OSM 建物による独立確認（PLATEAU のみ。fallback 自体が OSM なので確認にならない）
  const coverBy = (grid) => {
    if (!grid) return null;
    const g = { minX: Math.floor(r.bb.minX), minZ: Math.floor(r.bb.minZ) };
    g.nx = Math.max(1, Math.ceil(r.bb.maxX) - g.minX); g.nz = Math.max(1, Math.ceil(r.bb.maxZ) - g.minZ);
    const m = new Uint8Array(g.nx * g.nz);
    for (const it of gridQuery(grid, r.bb)) if (bbHit(it.bb, r.bb)) fillBits(g, m, [it.ring], 1);
    let n = 0, c = 0;
    scanFill(g, [r.ring], (i, j) => { n++; if (m[j * g.nx + i]) c++; });
    return n ? c / n : 0;
  };
  // OSM 建物による独立確認は PLATEAU のみ（fallback 自体が OSM なので確認にならない）。GSI は両方に使える。
  const osmCover = r.src === 'plateau-building' ? coverBy(ev.bGrid) : null;
  const gsiCover = coverBy(ev.gGrid);
  const gsiConfirmed = gsiCover != null && gsiCover >= GSI_CONFIRM_COVER;
  let osmNearby = 0;
  const cx = Math.floor(r.c[0] / ev.K), cz = Math.floor(r.c[1] / ev.K);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) osmNearby += ev.nearCount.get((cx + dx) + ',' + (cz + dz)) || 0;
  let cls;
  let evidence = semantic ? 'usage-label' : structure ? 'osm-structure' : null;
  if (semantic || structure) cls = 'REAL_WATER_STRUCTURE';
  else if (r.wDepth <= SHORELINE_DEPTH_M) cls = 'SHORELINE_CONFLICT';
  else if (gsiConfirmed && r.wDepth >= DEEP_WATER_STRUCTURE_M) { cls = 'REAL_WATER_STRUCTURE'; evidence = 'gsi-building-deep-in-water'; }
  else if ((osmCover != null && osmCover >= 0.3) || gsiConfirmed) { cls = 'WATER_GEOMETRY_TOO_WIDE'; evidence = gsiConfirmed ? 'gsi-building' : 'osm-building'; }
  else if (r.src === 'plateau-building' && osmNearby >= 3 && ratio >= 0.5) { cls = 'BUILDING_SOURCE_CONFLICT'; evidence = 'no-osm-no-gsi'; }
  else cls = 'AMBIGUOUS';
  return {
    cls, evidence, ratio: +ratio.toFixed(4), semantic, structure, osmCover: osmCover == null ? null : +osmCover.toFixed(3),
    gsiCover: gsiCover == null ? null : +gsiCover.toFixed(3), osmNearby,
    waterName: w ? w.name : null, waterClass: w ? w.waterClass : null, waterId: w ? w.id : null,
  };
}

const SITES = [
  { id: 'umeda', x: -2668.18, z: -10941.87 }, { id: 'honmachi', x: -2072.6, z: -8693.2 },
  { id: 'namba', x: -2173.39, z: -6511.33 }, { id: 'tennoji', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', x: -2952.22, z: -811.75 }, { id: 'higashiyodogawa', x: 574, z: -15576 },
  { id: 'nakanoshima', x: -2695.66, z: -9962.25 },
];
export const FOCUS_RIVERS = ['大川', '淀川', '道頓堀川', '木津川', '安治川'];

async function main() {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();
  console.log('[v2-final] sources…');
  const src = loadSources();
  console.log('[v2-final]', JSON.stringify(src.counts));
  const { results, totals } = measureAll(src, (d, n, tt) => console.log(`[v2-final] tiles ${d}/${n} buildings ${tt.buildings}`));
  console.log('[v2-final] measured', JSON.stringify(totals));
  const sites = {};
  for (const s of SITES) { sites[s.id] = measureSite(src, s); console.log('[v2-final] site', s.id, JSON.stringify(sites[s.id])); }

  // ── 水域の分類 ──
  const waterHits = results.filter((r) => r.w > 0);
  console.log('[v2-final] OSM evidence for', waterHits.length, 'water-overlap buildings…');
  const ev = await osmEvidence(waterHits);
  const byClass = {}, byRiver = {}, byWaterClass = {};
  for (const r of waterHits) {
    const w = r.wIdx != null ? src.waterList[r.wIdx] : null;
    const k = classifyWater(r, ev, w);
    r.water = k;
    byClass[k.cls] = byClass[k.cls] || { buildings: 0, overlapM2: 0 };
    byClass[k.cls].buildings++; byClass[k.cls].overlapM2 += r.w;
    const rn = k.waterName || '(名称なし)';
    const rv = (byRiver[rn] ||= { buildings: 0, overlapM2: 0, byClass: {} });
    rv.buildings++; rv.overlapM2 += r.w; rv.byClass[k.cls] = (rv.byClass[k.cls] || 0) + r.w;
    const wc = k.waterClass || 'unknown';
    byWaterClass[wc] = byWaterClass[wc] || { buildings: 0, overlapM2: 0 };
    byWaterClass[wc].buildings++; byWaterClass[wc].overlapM2 += r.w;
  }
  const focus = {};
  for (const name of FOCUS_RIVERS) {
    const list = waterHits.filter((r) => r.water.waterName === name).sort((a, b) => b.w - a.w);
    focus[name] = {
      buildings: list.length, overlapM2: list.reduce((a, r) => a + r.w, 0),
      byClass: list.reduce((a, r) => ((a[r.water.cls] = (a[r.water.cls] || 0) + r.w), a), {}),
      top: list.slice(0, 25).map((r) => ({ id: r.id, overlapM2: r.w, ratio: r.water.ratio, depthM: r.wDepth, cls: r.water.cls, evidence: r.water.evidence, src: r.src, label: r.label, osmCover: r.water.osmCover, gsiCover: r.water.gsiCover, structure: r.water.structure, center: r.c, ward: r.ward })),
    };
  }

  // 過去値（historical）
  const h32n = fs.existsSync(VF.report32n) ? rj(VF.report32n) : null;
  const h32i = fs.existsSync(VF.report32i) ? rj(VF.report32i) : null;

  const roadReport = {
    version: 1, generatedAt, missionId: '32P',
    buildingSet: { source: 'data/processed/osaka-city/canonical/buildings-v2-osmv2', total: totals.buildings },
    definition: {
      FIX13: 'canonical roads のうち refined-road-surface classMap（sidewalk/pedestrian/median/bridge/faint）以外の polygon',
      ROAD_V2: 'road-visual-v2 tiles の carriageway 帯', ROAD_V3: 'road-visual-v3 tiles の carriageway 帯（geometry は Mission 32I のまま・無変更）',
      raster: '1m セル中心判定（scanline）', citywide: '建物ごとの重なり面積の合計（建物同士の重なりは二重計上しうる）', sites: '1km 四方の union 面積（32N と同じ定義）',
    },
    citywide: {
      buildingAreaM2: totals.areaM2,
      FIX13: { overlapM2: totals.f13, buildingsTouching: totals.touchF13, overlapRatio: +(totals.f13 / totals.areaM2).toFixed(5) },
      ROAD_V2: { overlapM2: totals.v2, buildingsTouching: totals.touchV2, overlapRatio: +(totals.v2 / totals.areaM2).toFixed(5) },
      ROAD_V3: { overlapM2: totals.v3, buildingsTouching: totals.touchV3, overlapRatio: +(totals.v3 / totals.areaM2).toFixed(5) },
    },
    sites: Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, { center: v.center, halfSizeM: v.halfSizeM, buildings: v.buildings, buildingAreaM2: v.buildingAreaM2, FIX13: v.FIX13, ROAD_V2: v.ROAD_V2, ROAD_V3: v.ROAD_V3 }])),
    v3DistributionOfTouchingBuildings: (() => {
      const b = { '<0.05': 0, '0.05-0.1': 0, '0.1-0.3': 0, '0.3-0.5': 0, '0.5-0.8': 0, '>=0.8': 0 };
      for (const r of results) { if (!r.v3) continue; const x = r.v3 / r.area; b[x < 0.05 ? '<0.05' : x < 0.1 ? '0.05-0.1' : x < 0.3 ? '0.1-0.3' : x < 0.5 ? '0.3-0.5' : x < 0.8 ? '0.5-0.8' : '>=0.8']++; }
      return b;
    })(),
    historical: {
      status: 'historical-invalidated-by-v2',
      note: '以下は V1 建物（0.93° 回転）または V2 + 旧 OSM で測った値。比較のためだけに載せる。',
      mission32I_v1Buildings: h32i ? { overlapM2: h32i.overlap, sites: h32i.sites ? Object.keys(h32i.sites) : null } : null,
      mission32N_sevenSites: h32n ? h32n.roadOverlap : null,
    },
    elapsedMs: Date.now() - t0,
  };
  const waterReport = {
    version: 1, generatedAt, missionId: '32P',
    buildingSet: roadReport.buildingSet,
    definition: { water: 'canonical water（hole を抜く）', depth: '建物∩水域セルから最も近い陸セルまでの距離の最大値（1m ラスタ・chamfer・30m で打ち切り）', shoreline: `深さ <= ${SHORELINE_DEPTH_M}m` },
    classificationRules: [
      'REAL_WATER_STRUCTURE: 用途ラベルが橋・桟橋・水門・駅など、または OSM の桟橋・橋・船着場（man_made=pier/bridge/quay…, building=boathouse/bridge…）と重なる、または GSI 建物面が 50% 以上あり水面へ 10m 以上入る',
      `SHORELINE_CONFLICT: 水域への食い込みが ${SHORELINE_DEPTH_M}m 以下（岸線の位置差）`,
      'WATER_GEOMETRY_TOO_WIDE: PLATEAU 建物を OSM 建物（30% 以上）または GSI 建物面（50% 以上）が独立に裏付ける（建物は実在 → 水域 polygon が陸側まで広い）',
      'BUILDING_SOURCE_CONFLICT: PLATEAU 建物の半分以上が水面上・周囲に OSM 建物があるのに、OSM にも GSI にもこの建物が無い',
      'AMBIGUOUS: 上記以外（OSM fallback は水域も OSM なので独立確認ができない、OSM 空白地帯 など）',
    ],
    citywide: { buildingsTouching: totals.touchWater, overlapM2: totals.water, overlapRatio: +(totals.water / totals.areaM2).toFixed(6), byClass, byWaterClass },
    focusRivers: focus,
    byRiver: Object.fromEntries(Object.entries(byRiver).sort((a, b) => b[1].overlapM2 - a[1].overlapM2)),
    sites: Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, v.water])),
    historical: {
      status: 'historical-invalidated-by-v2',
      mission32N: h32n ? h32n.waterOverlap : null,
    },
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(VF.roadReport, JSON.stringify(roadReport, null, 2));
  fs.writeFileSync(VF.waterReport, JSON.stringify(waterReport, null, 2));
  const slim = results.map((r) => { const { ring, bb, ...rest } = r; return rest; });
  writeFilesVerified(VF.workDir, new Map([['building-overlaps.json', JSON.stringify({ version: 1, generatedAt, totals, count: slim.length, buildings: slim })]]), { label: 'v2-final overlaps', settleMs: 5000, removeStray: false });
  return { roadReport, waterReport };
}

if (isMainModule(import.meta.url)) {
  main().then(({ roadReport, waterReport }) => {
    console.log('[v2-final] road citywide', JSON.stringify(roadReport.citywide));
    console.log('[v2-final] v3 dist', JSON.stringify(roadReport.v3DistributionOfTouchingBuildings));
    console.log('[v2-final] water', JSON.stringify(waterReport.citywide));
    for (const [k, v] of Object.entries(waterReport.focusRivers)) console.log('[v2-final] river', k, JSON.stringify({ ...v, top: v.top.slice(0, 5) }));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
