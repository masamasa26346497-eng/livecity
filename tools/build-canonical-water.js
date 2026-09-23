#!/usr/bin/env node
// tools/build-canonical-water.js
// [Mission 31B] Canonical Water 正式化。
//   polygon-first 原則: 実際の水域 polygon（OSM riverbank / water=river / natural=water / multipolygon relation）
//   を canonical geometry として採用し、centerline は centerlineRef / widthProfile として保持するだけにする。
//   polygon source が無い水路のみ RiverLayerV2 ribbon を fallback として採用する。
//
//   ※ RiverLayerV2 / rivers.json / water-surface は読み取りのみ。置換しない。projection / znorth-neg-v1 不変。
//   ※ 出力は data/processed/osaka-city/canonical/ 配下のみ。production / protected HTML は触らない。
//
// source priority（canonical-geometry-schema SOURCE_PRIORITY.water）:
//   1 公的水域polygon（未取得）/ 2 OSM riverbank・water=river polygon / 3 OSM natural=water polygon
//   / 4 OSM centerline + measured width / 5 OSM centerline + default width
//
// 出力:
//   data/processed/osaka-city/canonical/water.json                     （canonical 本体・全 feature・full geometry）
//   data/processed/osaka-city/canonical/water/manifest.json + tile_*.json （derived tile prototype）
//   data/reports/canonical-water-build.json
//   data/reports/canonical-water-source-inventory.json
//   data/reports/canonical-water-major-rivers.json
//   data/reports/canonical-water-preview.geojson
//
// 実行: node tools/build-canonical-water.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { normalizeRiverName } from './lib/river-network.js';
import { assembleMultipolygon } from './lib/osm-multipolygon.js';
import { classifyWater } from './lib/water-classify.js';
import { loadCorrections, applyCorrections } from './lib/canonical-corrections.js';
import {
  COORDINATE_CONVENTION, CONFIDENCE, SOURCE_PRIORITY, makeProvenance, makeCanonicalFeature,
  validateCanonicalFeature, polygonAreaM2, ringAreaM2, bboxOf,
} from './lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const RAW_WATERWAYS = P('data', 'raw', 'osaka-city', 'waterways-osm.json');
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const WATER_SURFACE = P('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json');
const OUT_BODY = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const OUT_TILE_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const REPORT = P('data', 'reports', 'canonical-water-build.json');
const INVENTORY = P('data', 'reports', 'canonical-water-source-inventory.json');
const MAJOR_REPORT = P('data', 'reports', 'canonical-water-major-rivers.json');
const PREVIEW = P('data', 'reports', 'canonical-water-preview.geojson');

// OSAKA_CITY_GROUND_EXTENT（znorth-neg-v1）。これを大きく外れる polygon は city bbox violation。
const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CITY_MARGIN = 1500; // buffer（raw は bufferMeters:1000 で取得済み）
const TILE_SIZE = 2000;
const MIN_AREA_M2 = 4;
const GIANT_AREA_M2 = 8_000_000;   // これ超は海スケール。canonical water（河川）には採用しない
const GIANT_EDGE_M = 1200;         // 1 辺がこれ超 = 未連結 relation の横断辺
const MAJOR_RIVERS = ['淀川', '大和川', '神崎川', '大川', '堂島川', '土佐堀川', '安治川', '木津川', '寝屋川', '道頓堀川'];

// ── projection（znorth-neg-v1）──
function makeProjector(area) {
  const { centerLat, centerLon, metersPerDegree } = area.projection;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  return {
    toXZ: (lat, lon) => [
      +(((lon - centerLon) * cosf * metersPerDegree)).toFixed(2),
      +(-((lat - centerLat) * metersPerDegree)).toFixed(2),
    ],
    toLatLon: (x, z) => [centerLat - z / metersPerDegree, centerLon + x / (cosf * metersPerDegree)],
  };
}

// ── ジオメトリ helpers ──
function ringBbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
function bboxHit(a, b) { return !(a.maxX < b.minX || a.minX > b.maxX || a.maxZ < b.minZ || a.minZ > b.maxZ); }
function bboxIoU(a, b) {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ox * oz;
  const ua = (a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - inter;
  return ua > 0 ? inter / ua : 0;
}
function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  // n が大きいと O(n^2) が重いので上限を設ける（大 relation は既に stitch 済みで交差しにくい）
  if (n > 900) return false;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersect(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
function maxEdge(ring) {
  let m = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const e = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (e > m) m = e;
  }
  return m;
}
function pointInRing(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
function pointInPolygon(x, z, poly) { // poly = [outer, ...holes]
  if (!pointInRing(x, z, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(x, z, poly[i])) return false;
  return true;
}
function pointInMulti(x, z, coords, gt) {
  if (gt === 'Polygon') return pointInPolygon(x, z, coords);
  for (const poly of coords) if (pointInPolygon(x, z, poly)) return true;
  return false;
}
function distToRing(px, pz, ring) {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
    if (d < m) m = d;
  }
  return m;
}

function ringXZ(geom, toXZ) {
  // geom = [{lat,lon}...] または [[lon,lat]...]
  const out = [];
  for (const p of geom) {
    const lat = Array.isArray(p) ? p[1] : p.lat;
    const lon = Array.isArray(p) ? p[0] : p.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push(toXZ(lat, lon));
  }
  // 末尾の閉じ点を除去（canonical は明示リング。validator が Polygon を許容）
  if (out.length > 3) { const a = out[0], b = out[out.length - 1]; if (a[0] === b[0] && a[1] === b[1]) out.pop(); }
  return out;
}

// polygon 品質検査。invalid は canonical へ採用しない（§7）。
function checkPolygonQuality(coords, gt) {
  const polys = gt === 'Polygon' ? [coords] : coords;
  const flags = [];
  let area = 0;
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || outer.length < 3) return { ok: false, reason: 'degenerate-ring' };
    for (const p of outer) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { ok: false, reason: 'non-finite' };
    const oa = ringAreaM2(outer);
    if (oa < MIN_AREA_M2) return { ok: false, reason: 'zero-area' };
    if (oa > GIANT_AREA_M2) return { ok: false, reason: 'giant-polygon' };
    if (maxEdge(outer) > GIANT_EDGE_M) return { ok: false, reason: 'giant-edge(未連結relation)' };
    if (ringSelfIntersects(outer)) return { ok: false, reason: 'self-intersection' };
    let holeArea = 0;
    for (let i = 1; i < poly.length; i++) {
      const h = poly[i];
      if (!h || h.length < 3) { flags.push('degenerate-hole'); continue; }
      const ha = ringAreaM2(h);
      if (ha >= oa) return { ok: false, reason: 'hole-larger-than-outer' };
      // hole が outer 内にあるか（代表点）
      if (!pointInRing(h[0][0], h[0][1], outer)) flags.push('hole-outside-outer');
      holeArea += ha;
    }
    area += Math.max(0, oa - holeArea);
  }
  const bb = bboxOf(coords);
  if (bb.maxX < GROUND_EXTENT.minX - CITY_MARGIN || bb.minX > GROUND_EXTENT.maxX + CITY_MARGIN
    || bb.maxZ < GROUND_EXTENT.minZ - CITY_MARGIN || bb.minZ > GROUND_EXTENT.maxZ + CITY_MARGIN) {
    return { ok: false, reason: 'city-bbox-violation' };
  }
  return { ok: true, area, flags };
}

function statOf(arr) {
  const a = (arr || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { min: +a[0].toFixed(2), median: +q(0.5).toFixed(2), max: +a[a.length - 1].toFixed(2), p95: +q(0.95).toFixed(2), count: a.length };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const proj = makeProjector(area);
  const raw = JSON.parse(fs.readFileSync(RAW_WATERWAYS, 'utf-8'));
  const els = raw.elements || [];
  const rivers = fs.existsSync(RIVERS) ? (JSON.parse(fs.readFileSync(RIVERS, 'utf-8')).rivers || []) : [];

  // ── source inventory（§1）──
  const inv = { osmWays: 0, osmRelations: 0, closedWaterWays: 0, openCenterlines: 0, relationMemberWays: new Set(), byWaterClass: {}, relationTypes: {} };
  const relMemberIds = new Set();
  for (const e of els) {
    if (e.type === 'relation') { inv.osmRelations++; const t = e.tags || {}; inv.relationTypes[(t.water || t.waterway || t.natural || 'water')] = (inv.relationTypes[(t.water || t.waterway || t.natural || 'water')] || 0) + 1; for (const m of (e.members || [])) if (m.type === 'way') relMemberIds.add(m.ref); }
    else if (e.type === 'way') inv.osmWays++;
  }

  // ── polygon source を集める ──
  const polyRecords = []; // { gt, coords, tags, sourceIds, waterClass, name }
  const rejected = { 'self-intersection': 0, 'zero-area': 0, 'giant-polygon': 0, 'giant-edge(未連結relation)': 0, 'city-bbox-violation': 0, 'degenerate-ring': 0, 'non-finite': 0, 'hole-larger-than-outer': 0, 'unclosed-relation': 0 };

  // relations（multipolygon）
  for (const e of els) {
    if (e.type !== 'relation') continue;
    const t = e.tags || {};
    const asm = assembleMultipolygon(e.members || []);
    if (asm.stats.unclosed > 0 && asm.polygons.length === 0) { rejected['unclosed-relation']++; continue; }
    const polysXZ = asm.polygons.map((pl) => {
      const outer = ringXZ(pl.outer, proj.toXZ);
      const holes = (pl.holes || []).map((h) => ringXZ(h, proj.toXZ)).filter((h) => h.length >= 3);
      return [outer, ...holes];
    }).filter((pl) => pl[0] && pl[0].length >= 3);
    if (!polysXZ.length) continue;
    const gt = polysXZ.length === 1 ? 'Polygon' : 'MultiPolygon';
    const coords = gt === 'Polygon' ? polysXZ[0] : polysXZ;
    const q = checkPolygonQuality(coords, gt);
    if (!q.ok) { rejected[q.reason] = (rejected[q.reason] || 0) + 1; continue; }
    polyRecords.push({ gt, coords, tags: t, sourceIds: [`relation/${e.id}`], waterClass: classifyWater(t), name: t.name || '', qaHints: q.flags || [] });
  }
  inv.osmRelations = els.filter((e) => e.type === 'relation').length;

  // standalone closed ways（relation member でない water polygon）
  for (const e of els) {
    if (e.type !== 'way') continue;
    if (relMemberIds.has(e.id)) continue;
    const t = e.tags || {};
    const g = e.geometry || [];
    if (g.length < 4) continue;
    const closed = g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    const isWaterPoly = closed && (t.natural === 'water' || t.water || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin');
    if (!isWaterPoly) continue;
    inv.closedWaterWays++;
    const outer = ringXZ(g, proj.toXZ);
    if (outer.length < 3) continue;
    const coords = [outer];
    const q = checkPolygonQuality(coords, 'Polygon');
    if (!q.ok) { rejected[q.reason] = (rejected[q.reason] || 0) + 1; continue; }
    polyRecords.push({ gt: 'Polygon', coords, tags: t, sourceIds: [`way/${e.id}`], waterClass: classifyWater(t), name: t.name || '', qaHints: q.flags || [] });
  }
  for (const e of els) if (e.type === 'way') { const t = e.tags || {}; if (['river', 'canal', 'stream', 'drain', 'ditch'].includes(t.waterway)) inv.openCenterlines++; }

  // ── polygon merge（§4: 同名 → MultiPolygon。無理に溶かさない）──
  const byName = new Map();
  const merged = [];
  for (const pr of polyRecords) {
    const key = pr.name ? normalizeRiverName(pr.name) : null;
    if (key) {
      if (!byName.has(key)) { const rec = { ...pr, polys: [], names: new Set([pr.name]) }; byName.set(key, rec); merged.push(rec); }
      const rec = byName.get(key);
      const parts = pr.gt === 'Polygon' ? [pr.coords] : pr.coords;
      for (const pp of parts) rec.polys.push(pp);
      rec.sourceIds.push(...pr.sourceIds.filter((s) => !rec.sourceIds.includes(s)));
      rec.qaHints.push(...pr.qaHints);
    } else {
      const parts = pr.gt === 'Polygon' ? [pr.coords] : pr.coords;
      merged.push({ ...pr, polys: parts, names: new Set() });
    }
  }
  // MultiPolygon 化
  for (const m of merged) {
    m.gt = m.polys.length === 1 ? 'Polygon' : 'MultiPolygon';
    m.coords = m.gt === 'Polygon' ? m.polys[0] : m.polys;
  }

  // ── centerline linkage（§3/§8: polygon-first。§4 分割 polygon 統合）──
  // rivers.json を「正規化名グループ」でまとめ（無名は id 単位）、グループの全 centerline が貫く
  //   river 系 polygon をまとめて claim → 1 MultiPolygon canonical feature にする。
  //   これで「同一河川に polygon feature と ribbon feature が併存」を構造的に防ぐ（polygon-first）。
  const RIVER_MERGE_CLASSES = new Set(['river', 'canal', 'water', 'stream', 'drainage']);
  const majorKeys = new Set(MAJOR_RIVERS.map((n) => normalizeRiverName(n)));
  const okRivers = rivers.filter((r) => r.ok && Array.isArray(r.centerline) && r.centerline.length >= 2);
  const groupsMap = new Map();
  for (const r of okRivers) {
    const key = r.name ? ('name:' + r.normName) : ('id:' + r.id);
    if (!groupsMap.has(key)) groupsMap.set(key, { key, name: r.name || '', normName: r.normName || '', segments: [] });
    groupsMap.get(key).segments.push(r);
  }
  const riverGroups = [...groupsMap.values()].sort((a, b) => {
    const am = majorKeys.has(a.normName) ? 0 : (a.name ? 1 : 2);
    const bm = majorKeys.has(b.normName) ? 0 : (b.name ? 1 : 2);
    if (am !== bm) return am - bm;
    const al = a.segments.reduce((s, r) => s + (r.centerlineLength || 0), 0);
    const bl = b.segments.reduce((s, r) => s + (r.centerlineLength || 0), 0);
    return bl - al;
  });

  const claimed = new Set();       // merged index が claim 済み
  const coveredGroups = new Set(); // group.key が polygon で覆われた
  const riverPolyGroups = [];      // { group, primary(river), mergedIdxs, insideRatio, meanDist, maxDist }
  for (const g of riverGroups) {
    const allCl = g.segments.flatMap((r) => r.centerline);
    const clbb = ringBbox(allCl);
    const cand = [];
    let insideTotal = 0, hasSameName = false;
    for (let mi = 0; mi < merged.length; mi++) {
      if (claimed.has(mi)) continue;
      const m = merged[mi];
      if (!RIVER_MERGE_CLASSES.has(m.waterClass)) continue;
      if (!bboxHit(clbb, bboxOf(m.coords))) continue;
      const sameName = m.name && g.normName && normalizeRiverName(m.name) === g.normName;
      let inside = 0;
      for (const [x, z] of allCl) if (pointInMulti(x, z, m.coords, m.gt)) inside++;
      if (sameName || inside > 0) { cand.push(mi); insideTotal += inside; if (sameName) hasSameName = true; }
    }
    const insideRatio = insideTotal / allCl.length;
    // 同名 polygon がある場合は insideRatio に関わらず claim（名前付き polygon が水域の正）。
    if (cand.length && (insideRatio >= 0.4 || hasSameName)) {
      for (const mi of cand) claimed.add(mi);
      coveredGroups.add(g.key);
      const rings = cand.flatMap((mi) => { const m = merged[mi]; return m.gt === 'Polygon' ? m.coords : m.coords.flat(); });
      let sum = 0, mx = 0;
      for (const [x, z] of allCl) { let dmin = Infinity; for (const rg of rings) { const d = distToRing(x, z, rg); if (d < dmin) dmin = d; } sum += dmin; if (dmin > mx) mx = dmin; }
      const primary = g.segments.slice().sort((a, b) => (b.centerlineLength || 0) - (a.centerlineLength || 0))[0];
      riverPolyGroups.push({
        group: g, primary, mergedIdxs: cand,
        insideRatio: +Math.min(1, insideRatio).toFixed(3),
        meanCenterlineToWaterDistance: +(sum / allCl.length).toFixed(2),
        maxCenterlineToWaterDistance: +mx.toFixed(2),
      });
    }
  }

  // ── canonical feature 生成 ──
  const out = [];
  const stats = {
    polygonCanonicalCount: 0, ribbonFallbackCount: 0, defaultWidthFallbackCount: 0,
    byGeometrySource: {}, byWaterClass: {}, rejectedPolygons: rejected,
    centerlineLinked: 0, schemaErrors: 0,
  };
  const bumpGS = (k) => { stats.byGeometrySource[k] = (stats.byGeometrySource[k] || 0) + 1; };
  const bumpWC = (k) => { stats.byWaterClass[k] = (stats.byWaterClass[k] || 0) + 1; };

  // waterClass 正規化（§12: river/canal/harbor/sea/pond/lake/reservoir/drainage/stream/water）
  const normWaterClass = (wc, tags) => {
    if (wc === 'harbour') return (tags && (tags.natural === 'bay' || tags.water === 'sea')) ? 'sea' : 'harbor';
    if (wc === 'canal' && tags && (tags.waterway === 'drain' || tags.waterway === 'ditch' || tags.water === 'drain')) return 'drainage';
    return wc; // river / canal / stream / pond / lake / reservoir / water
  };

  // ── (A) river polygon group（centerline claim。分割 polygon を 1 MultiPolygon へ・名前グループ単位）──
  for (const grp of riverPolyGroups) {
    const r = grp.primary;
    const g = grp.group;
    // 各 claimed merged record の polygon を「1 polygon = [outer,...holes]」単位で個別品質チェックし、
    //   合格したものだけ parts に入れる（自己交差 relation の 1 枚を丸ごと落とす）。
    const parts = [];
    let droppedParts = 0;
    for (const mi of grp.mergedIdxs) {
      const m = merged[mi];
      const polys = m.gt === 'Polygon' ? [m.coords] : m.coords;
      for (const poly of polys) {
        const q1 = checkPolygonQuality(poly, 'Polygon');
        if (q1.ok) parts.push(poly); else droppedParts++;
      }
    }
    if (!parts.length) { coveredGroups.delete(grp.group.key); continue; } // 全 part invalid → ribbon fallback へ
    const gt = parts.length === 1 ? 'Polygon' : 'MultiPolygon';
    const coords = gt === 'Polygon' ? parts[0] : parts;
    const sourceIds = [...new Set(grp.mergedIdxs.flatMap((mi) => merged[mi].sourceIds))].slice(0, 60);
    const wc = normWaterClass(r.waterClass || 'river', { waterway: r.waterwayTag });
    const canonArea = polygonAreaM2(gt, coords);
    const segRibbonArea = g.segments.reduce((s, sr) => {
      const l = sr.left || [], rt = sr.right || [];
      return s + ((l.length >= 2 && rt.length >= 2) ? ringAreaM2(l.concat(rt.slice().reverse())) : 0);
    }, 0);
    const qaFlags = [...new Set(grp.mergedIdxs.flatMap((mi) => merged[mi].qaHints))];
    if (droppedParts) qaFlags.push('dropped-invalid-polygon-parts:' + droppedParts);
    if (grp.insideRatio < 0.4) qaFlags.push('centerline-mostly-outside-polygon');
    else if (grp.insideRatio < 0.6) qaFlags.push('centerline-partly-outside-polygon');
    if (grp.maxCenterlineToWaterDistance > 400) qaFlags.push('centerline-far-from-water-edge');
    if (segRibbonArea > 0 && canonArea / segRibbonArea > 2.5) qaFlags.push('polygon-much-larger-than-ribbon(要確認)');
    stats.centerlineLinked++;
    const prov = makeProvenance({
      geometrySource: 'osm-riverbank',
      attributeSources: ['osm-water', 'osm-waterway-centerline', r.name ? 'osm-name' : null].filter(Boolean),
      confidence: CONFIDENCE.OSM_WATER_POLYGON,
      sourceIds, generatedAt,
      notes: `centerline "${g.name || r.id}"（${g.segments.length} 区間）が貫く water polygon ${parts.length} 枚を統合（§4）。`,
    });
    const cid = g.name ? `cg_water_river_${g.normName.replace(/[^A-Za-z0-9_-]/g, '') || 'x'}_${r.id}` : `cg_water_${r.id}`;
    const f = makeCanonicalFeature({
      canonicalId: cid,
      layer: 'water', geometryType: gt, coordinates: coords,
      provenance: prov,
      attributes: {
        name: r.name || null, waterClass: wc, waterwayTag: r.waterwayTag || null,
        riverClass: r.riverClass || null, surface: r.surface !== false,
        polygonMergedParts: parts.length, centerlineSegments: g.segments.length,
      },
      qaFlags,
      centerlineRef: {
        sourceIds: g.segments.map((sr) => (sr.source && sr.source.id ? `${sr.source.type || 'way'}/${sr.source.id}` : sr.id)),
        coordinates: r.centerline.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
        lengthM: Math.round(g.segments.reduce((s, sr) => s + (sr.centerlineLength || 0), 0)),
        centerlineInsideRatio: grp.insideRatio,
        meanCenterlineToWaterDistance: grp.meanCenterlineToWaterDistance,
        maxCenterlineToWaterDistance: grp.maxCenterlineToWaterDistance,
      },
      widthProfile: {
        method: r.widthMethod || null,
        min: r.widthMin != null ? +r.widthMin.toFixed(2) : null,
        median: r.widthMedian != null ? +r.widthMedian.toFixed(2) : null,
        max: r.widthMax != null ? +r.widthMax.toFixed(2) : null,
        matchedRiverbanks: r.widthMatchedRiverbanks || 0,
        profile: statOf(g.segments.flatMap((sr) => sr.widths || [])),
        ribbonAreaM2: Math.round(segRibbonArea), canonicalAreaM2: Math.round(canonArea),
      },
    });
    const v = validateCanonicalFeature(f);
    if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
    out.push(f);
    stats.polygonCanonicalCount++; bumpGS('osm-riverbank'); bumpWC(wc);
  }

  // ── (B) claim されなかった polygon（池・貯水池・単独 water polygon 等）を個別に emit ──
  for (let mi = 0; mi < merged.length; mi++) {
    if (claimed.has(mi)) continue;
    const m = merged[mi];
    const wc = normWaterClass(m.waterClass, m.tags);
    const isRiverish = wc === 'river' || wc === 'canal' || m.tags.waterway === 'riverbank' || m.tags.water === 'river';
    const geometrySource = isRiverish ? 'osm-riverbank' : 'osm-water-polygon';
    const confidence = isRiverish ? CONFIDENCE.OSM_WATER_POLYGON
      : (['pond', 'reservoir', 'lake'].includes(wc) ? 0.88 : CONFIDENCE.OSM_WATER_POLYGON);
    const qaFlags = [...new Set(m.qaHints)];
    const prov = makeProvenance({
      geometrySource,
      attributeSources: ['osm-water', m.name ? 'osm-name' : null].filter(Boolean),
      confidence: +confidence.toFixed(2),
      sourceIds: m.sourceIds.slice(0, 40),
      generatedAt,
      notes: `raw OSM waterways polygon 由来。merged parts=${m.polys.length}`,
    });
    const f = makeCanonicalFeature({
      canonicalId: `cg_water_${m.sourceIds[0].replace('/', '_')}`,
      layer: 'water', geometryType: m.gt, coordinates: m.coords,
      provenance: prov,
      attributes: {
        name: m.name || null, waterClass: wc,
        waterwayTag: m.tags.waterway || null, osmWater: m.tags.water || null,
        surface: m.tags.tunnel ? false : true,
      },
      qaFlags,
    });
    const v = validateCanonicalFeature(f);
    if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
    out.push(f);
    stats.polygonCanonicalCount++; bumpGS(geometrySource); bumpWC(wc);
  }

  // ── ribbon fallback（polygon で覆われていない河川グループのみ・区間ごとに 1 feature）──
  //   geometry は「区間ごとの四角形の MultiPolygon」にして concatenated ring の自己交差を避ける。
  function ribbonQuads(left, right) {
    const parts = [];
    const n = Math.min(left.length, right.length);
    for (let i = 0; i + 1 < n; i++) {
      const q = [
        [+left[i][0].toFixed(2), +left[i][1].toFixed(2)],
        [+left[i + 1][0].toFixed(2), +left[i + 1][1].toFixed(2)],
        [+right[i + 1][0].toFixed(2), +right[i + 1][1].toFixed(2)],
        [+right[i][0].toFixed(2), +right[i][1].toFixed(2)],
      ];
      if (ringAreaM2(q) >= 1 && !ringSelfIntersects(q)) parts.push([q]);
    }
    return parts;
  }
  const emittedRibbonNames = new Set();
  for (const g of riverGroups) {
    if (coveredGroups.has(g.key)) continue;
    for (const r of g.segments) {
      const left = r.left || [], right = r.right || [];
      if (left.length < 2 || right.length < 2) continue;
      const parts = ribbonQuads(left, right);
      if (!parts.length) continue;
      const gt = parts.length === 1 ? 'Polygon' : 'MultiPolygon';
      const coords = gt === 'Polygon' ? parts[0] : parts;
    const method = r.widthMethod || 'default';
    const isDefault = /default/.test(method) && !/measured/.test(method);
    let confidence = /measured-strong/.test(method) ? CONFIDENCE.OSM_CENTERLINE_WIDTH_TAG
      : /measured/.test(method) ? CONFIDENCE.OSM_CENTERLINE_MEASURED_WIDTH
        : CONFIDENCE.OSM_CENTERLINE_CLASS_DEFAULT_WIDTH;
    const wc = normWaterClass(r.waterClass || 'river', { waterway: r.waterwayTag });
    const qaFlags = ['geometry-from-centerline-ribbon'];
    if (r.surface === false) qaFlags.push('underground');
    if (isDefault) qaFlags.push('width-default-low-confidence');
    if ((r.validationErrors || []).length) qaFlags.push('ribbon-validation-error');
    const prov = makeProvenance({
      geometrySource: 'osm-waterway-centerline',
      attributeSources: ['osm-waterway', r.name ? 'osm-name' : null].filter(Boolean),
      confidence: +confidence.toFixed(2),
      sourceIds: [r.source && r.source.id ? `${r.source.type || 'way'}/${r.source.id}` : r.id],
      generatedAt,
      notes: `polygon source なし。RiverLayerV2 ribbon 採用。widthMethod=${method}`,
    });
    const f = makeCanonicalFeature({
      canonicalId: `cg_water_${r.id}`,
      layer: 'water', geometryType: gt, coordinates: coords,
      provenance: prov,
      attributes: { name: r.name || null, waterClass: wc, waterwayTag: r.waterwayTag || null, riverClass: r.riverClass || null, surface: r.surface !== false, ribbonSegments: parts.length },
      qaFlags,
      centerlineRef: { sourceIds: [prov.sourceIds[0]], coordinates: (r.centerline || []).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]), lengthM: Math.round(r.centerlineLength || 0) },
      widthProfile: { method, min: r.widthMin != null ? +r.widthMin.toFixed(2) : null, median: r.widthMedian != null ? +r.widthMedian.toFixed(2) : null, max: r.widthMax != null ? +r.widthMax.toFixed(2) : null, matchedRiverbanks: r.widthMatchedRiverbanks || 0, profile: statOf(r.widths || []) },
    });
    const v = validateCanonicalFeature(f);
    if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
    out.push(f);
    stats.ribbonFallbackCount++; bumpGS('osm-waterway-centerline'); bumpWC(wc);
    if (isDefault) stats.defaultWidthFallbackCount++;
    if (r.name) emittedRibbonNames.add(normalizeRiverName(r.name));
    }
  }

  // ── duplicate canonicalId 解消（同一 way が複数経路で来た場合の保険）──
  const seen = new Set(); let dedup = [];
  for (const f of out) { if (seen.has(f.canonicalId)) continue; seen.add(f.canonicalId); dedup.push(f); }

  // ── [31E §13] canonical corrections を適用（追跡可能・可逆。元 raw source は不変）──
  const corrections = loadCorrections('water');
  let correctionResult = { applied: [], errors: [], summary: { correctionsSeen: 0, correctionsApplied: 0, correctionErrors: 0, featuresAdded: 0 } };
  if (corrections.length) {
    correctionResult = applyCorrections(dedup, corrections);
    dedup = correctionResult.features;
    for (const e of correctionResult.errors) console.warn('[canonical-water] correction エラー:', JSON.stringify(e));
    console.log('[canonical-water] corrections: ' + JSON.stringify(correctionResult.summary));
  }

  const totalArea = dedup.reduce((s, f) => s + (f.areaM2 || 0), 0);
  const polyCount = stats.polygonCanonicalCount;
  const polygonCoverageRatio = dedup.length ? +(polyCount / dedup.length).toFixed(3) : 0;
  const bbox = bboxOf(dedup.map((f) => f.coordinates));

  const body = {
    version: 2, layer: 'water', kind: 'canonical-geometry',
    coordinateConvention: COORDINATE_CONVENTION, generatedAt,
    featureCount: dedup.length, bbox,
    sourcePriority: SOURCE_PRIORITY.water,
    polygonCoverageRatio,
    corrections31E: correctionResult.summary,
    note: 'Mission 31B。polygon-first。RiverLayerV2 / rivers.json は不変。tile は canonical/water/ に別出力（simplify は derived のみ）。31E: canonical/corrections/water/ を適用（元 raw source 不変・可逆）。',
    features: dedup,
  };
  fs.mkdirSync(path.dirname(OUT_BODY), { recursive: true });
  fs.writeFileSync(OUT_BODY, JSON.stringify(body));

  // ── derived tile prototype（§15）──
  fs.rmSync(OUT_TILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_TILE_DIR, { recursive: true });
  const tileMap = new Map();
  for (const f of dedup) {
    if (!f.bbox) continue;
    for (let tx = Math.floor(f.bbox.minX / TILE_SIZE); tx <= Math.floor(f.bbox.maxX / TILE_SIZE); tx++)
      for (let tz = Math.floor(f.bbox.minZ / TILE_SIZE); tz <= Math.floor(f.bbox.maxZ / TILE_SIZE); tz++) {
        const k = tx + '_' + tz;
        if (!tileMap.has(k)) tileMap.set(k, []);
        tileMap.get(k).push(f.canonicalId);
      }
  }
  const tiles = [];
  for (const [k, ids] of [...tileMap.entries()].sort()) {
    const [tx, tz] = k.split('_').map(Number);
    const feats = dedup.filter((f) => ids.includes(f.canonicalId));
    fs.writeFileSync(path.join(OUT_TILE_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: COORDINATE_CONVENTION, count: feats.length, features: feats }));
    tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
  }
  fs.writeFileSync(path.join(OUT_TILE_DIR, 'manifest.json'), JSON.stringify({
    version: 1, layer: 'water', kind: 'derived-tile-prototype', coordinateConvention: COORDINATE_CONVENTION,
    generatedAt, tileSize: TILE_SIZE, featureCount: dedup.length, bbox, sourcePriority: SOURCE_PRIORITY.water,
    simplification: 'none (prototype)。LOD simplify は 31F derived band で実施。',
    tiles,
  }, null, 2));

  // ── preview GeoJSON（§20）──
  const gj = {
    type: 'FeatureCollection',
    name: 'canonical-water-osaka-city',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: dedup.map((f) => {
      const toGeo = (ring) => ring.map(([x, z]) => { const [lat, lon] = proj.toLatLon(x, z); return [+lon.toFixed(7), +lat.toFixed(7)]; });
      const closeRing = (r) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
      let geometry;
      if (f.geometryType === 'Polygon') geometry = { type: 'Polygon', coordinates: f.coordinates.map((r) => closeRing(toGeo(r))) };
      else geometry = { type: 'MultiPolygon', coordinates: f.coordinates.map((poly) => poly.map((r) => closeRing(toGeo(r)))) };
      return {
        type: 'Feature', geometry,
        properties: {
          canonicalId: f.canonicalId, name: f.attributes.name, waterClass: f.attributes.waterClass,
          geometrySource: f.source.geometrySource, confidence: f.source.confidence,
          areaM2: f.areaM2, qaFlags: f.qaFlags.join(','),
          hasCenterlineRef: !!f.centerlineRef,
        },
      };
    }),
  };
  fs.writeFileSync(PREVIEW, JSON.stringify(gj));

  // ── source inventory report（§1）──
  const inventory = {
    generatedAt,
    rawSource: toProjectRelativePath(RAW_WATERWAYS),
    rawMeta: raw._meta || null,
    osm: {
      ways: inv.osmWays, relations: inv.osmRelations,
      closedWaterWays: inv.closedWaterWays, openCenterlines: inv.openCenterlines,
      relationTypes: inv.relationTypes,
    },
    riversJson: { okRivers: rivers.filter((r) => r.ok).length, namedRivers: rivers.filter((r) => r.ok && r.name).length },
    waterSurface: fs.existsSync(WATER_SURFACE) ? { note: 'SEA_MASK ラスタ（海面）。canonical water(河川)には含めない。sea/harbor 分離の参照のみ。' } : null,
    officialCandidates: [
      { source: '国土地理院 基盤地図情報 水涯線（WL）', coverage: '全国', geometryType: '水涯線（LineString）→ polygon 化要', precision: '±0.5m 級（公共測量）', updateDate: '随時更新', license: '基盤地図情報 利用規約（出典明記・申請不要）', osakaCoverage: '大阪市全域あり', canonicalPriority: 1, acquisition: 'GSI 基盤地図情報ダウンロードサービス（要アカウント・無償）', status: 'not-acquired（31B ではネットワーク不可。ローカル取得候補）' },
      { source: '国土数値情報 W05 河川（河川区域・水涯線）', coverage: '全国（都道府県別）', geometryType: '河川区域 polygon + 河川中心線', precision: '1/25000 相当', updateDate: '年次', license: '国土数値情報 利用約款（出典明記）', osakaCoverage: '大阪府データに含まれる', canonicalPriority: 1, acquisition: 'https://nlftp.mlit.go.jp/ksj/ W05', status: 'not-acquired' },
      { source: 'PLATEAU 関連水域（土地利用 luse / 災害リスク fld）', coverage: 'PLATEAU 整備都市', geometryType: 'polygon', precision: '±1–1.5m', updateDate: 'PLATEAU 更新周期', license: 'PLATEAU（政府標準利用規約2.0）', osakaCoverage: '大阪市 3D 都市モデルに含まれる', canonicalPriority: 2, acquisition: 'PLATEAU CityGML luse', status: 'not-acquired' },
      { source: '大阪市 / 大阪府 オープンデータ（河川・水路 GIS）', coverage: '市域', geometryType: 'polygon / line（データにより）', precision: '不明（要確認）', updateDate: '不定期', license: 'CC BY 4.0（データにより）', osakaCoverage: '一部河川', canonicalPriority: 2, acquisition: '大阪市オープンデータポータル / G空間情報センター', status: 'not-acquired（要調査）' },
    ],
    currentlyUsed: [
      { source: 'osm-riverbank / osm-water=river polygon', priority: 2, adopted: stats.byGeometrySource['osm-riverbank'] || 0 },
      { source: 'osm-water-polygon (natural=water)', priority: 3, adopted: stats.byGeometrySource['osm-water-polygon'] || 0 },
      { source: 'osm-waterway-centerline + width (ribbon fallback)', priority: 4, adopted: stats.byGeometrySource['osm-waterway-centerline'] || 0 },
    ],
  };
  await writeJson(INVENTORY, inventory);

  // ── major river comparison（§6/§19）──
  const majorRows = MAJOR_RIVERS.map((nm) => {
    const key = normalizeRiverName(nm);
    const canon = dedup.filter((f) => f.attributes.name && normalizeRiverName(f.attributes.name) === key);
    const ribbonRivers = rivers.filter((r) => r.ok && (r.normName === key || (r.name && normalizeRiverName(r.name) === key)));
    const ribbonArea = ribbonRivers.reduce((s, r) => {
      const l = r.left || [], rt = r.right || [];
      if (l.length < 2 || rt.length < 2) return s;
      return s + ringAreaM2(l.concat(rt.slice().reverse()));
    }, 0);
    const canonArea = canon.reduce((s, f) => s + (f.areaM2 || 0), 0);
    const polygonFeat = canon.find((f) => f.source.geometrySource !== 'osm-waterway-centerline');
    return {
      name: nm,
      canonicalFeatureCount: canon.length,
      geometrySource: canon.length ? [...new Set(canon.map((f) => f.source.geometrySource))] : ['(none)'],
      polygonSourceAvailable: !!polygonFeat,
      canonicalAreaM2: Math.round(canonArea),
      ribbonAreaM2: Math.round(ribbonArea),
      areaRatioCanonVsRibbon: ribbonArea > 0 ? +(canonArea / ribbonArea).toFixed(3) : null,
      confidence: canon.length ? Math.max(...canon.map((f) => f.source.confidence)) : null,
      widthMedian: ribbonRivers.length ? ribbonRivers[0].widthMedian : null,
      centerlineInsideRatio: polygonFeat && polygonFeat.centerlineRef ? polygonFeat.centerlineRef.centerlineInsideRatio : null,
      bbox: canon.length ? bboxOf(canon.map((f) => f.coordinates)) : null,
    };
  });
  await writeJson(MAJOR_REPORT, { generatedAt, note: 'canonical water vs RiverLayerV2 ribbon の feature 比較（§6/§19）。', rivers: majorRows });

  // ── build report ──
  const confList = dedup.map((f) => f.source.confidence);
  const report = {
    generatedAt,
    body: toProjectRelativePath(OUT_BODY),
    tileDir: toProjectRelativePath(OUT_TILE_DIR),
    featureCount: dedup.length,
    polygonCanonicalCount: polyCount,
    ribbonFallbackCount: stats.ribbonFallbackCount,
    defaultWidthFallbackCount: stats.defaultWidthFallbackCount,
    polygonCoverageRatio,
    centerlineLinkedPolygons: stats.centerlineLinked,
    byGeometrySource: stats.byGeometrySource,
    byWaterClass: stats.byWaterClass,
    rejectedPolygons: rejected,
    schemaErrors: stats.schemaErrors,
    totalAreaM2: Math.round(totalArea),
    confidence: { mean: +(confList.reduce((s, c) => s + c, 0) / (confList.length || 1)).toFixed(3), ...statOf(confList) },
    qaFlagCounts: dedup.reduce((m, f) => { for (const q of f.qaFlags) m[q.split(':')[0]] = (m[q.split(':')[0]] || 0) + 1; return m; }, {}),
    tiles: tiles.length,
    bbox,
    corrections31E: { ...correctionResult.summary, applied: correctionResult.applied, errors: correctionResult.errors },
    RESULT: (dedup.length > 100 && stats.schemaErrors === 0 && correctionResult.errors.length === 0) ? 'PASS'
      : (stats.schemaErrors > 0 ? 'SCHEMA-FAIL' : correctionResult.errors.length ? 'CORRECTION-FAIL' : 'EMPTY'),
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  if (correctionResult.applied.length || correctionResult.errors.length) {
    await writeJson(P('data', 'reports', 'canonical-water-corrections.json'), {
      generatedAt, applied: correctionResult.applied, errors: correctionResult.errors, summary: correctionResult.summary,
    });
  }

  console.log('[canonical-water] features=' + dedup.length + ' (polygon ' + polyCount + ' / ribbon fallback ' + stats.ribbonFallbackCount + ' / default-width ' + stats.defaultWidthFallbackCount + ')');
  console.log('  polygonCoverageRatio=' + polygonCoverageRatio + '  centerline-linked polygons=' + stats.centerlineLinked);
  console.log('  byGeometrySource: ' + JSON.stringify(stats.byGeometrySource));
  console.log('  byWaterClass: ' + JSON.stringify(stats.byWaterClass));
  console.log('  rejected polygons: ' + JSON.stringify(rejected));
  console.log('  confidence mean=' + report.confidence.mean + '  schemaErrors=' + stats.schemaErrors + '  tiles=' + tiles.length);
  console.log('保存: ' + toProjectRelativePath(OUT_BODY) + ' / tiles / preview / inventory / major-rivers  RESULT: ' + report.RESULT);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[canonical-water] 失敗:', e && e.stack || e); process.exit(1); });
